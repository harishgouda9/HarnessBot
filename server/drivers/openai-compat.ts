import { randomUUID } from 'node:crypto';
import type {
  AnswerRequestInput,
  DriverContext,
  InstanceSnapshot,
  ProviderAdapter,
  ProviderDriver,
  RuntimeEvent,
  SendTurnInput,
  ThreadId,
} from '../contracts.ts';
import { NO_CAPABILITIES } from '../contracts.ts';

/**
 * OpenAI-compatible chat endpoint. Text and reasoning only.
 *
 * It declares no tool capabilities at all, so the UI will never offer it a computer,
 * connected apps, or peer tools. Advertising hands it does not have would produce a
 * bot that silently fails halfway through a task (HB-PRD-001 F-ENG-06).
 */

export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  models: { id: string; label?: string }[];
}

class OpenAiCompatAdapter implements ProviderAdapter {
  private aborts = new Map<ThreadId, AbortController>();

  private readonly config: OpenAiCompatConfig;
  private readonly ctx: DriverContext;
  readonly driver: string;

  constructor(config: OpenAiCompatConfig, ctx: DriverContext, driver: string) {
    this.config = config;
    this.ctx = ctx;
    this.driver = driver;
  }

  get instanceId(): string {
    return this.ctx.instanceId;
  }

  /**
   * This instance's own key first, the shared one only as a fallback.
   *
   * The order used to be the other way round, so once a global OpenAI-compatible key
   * existed every custom provider silently authenticated with it — a second endpoint
   * added with its own credential would quietly use the first one's.
   */
  private apiKey(): string | undefined {
    const own = this.config.apiKeyEnv ? this.ctx.secret(this.config.apiKeyEnv) : undefined;
    return own ?? this.ctx.secret('primary');
  }

  /**
   * A model running on this machine has nothing to authenticate against.
   *
   * Requiring a key for every endpoint made "run it locally" unusable: connecting a
   * running Ollama produced an engine permanently stuck on "No API key", and there is
   * no key to give it. Loopback is the exception, and only loopback — a remote host
   * that wants no auth still has to say so by leaving the key blank deliberately.
   */
  private needsKey(): boolean {
    try {
      const { hostname } = new URL(this.config.baseUrl);
      return !['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(hostname);
    } catch {
      return true;
    }
  }

  async snapshot(): Promise<InstanceSnapshot> {
    const ready = Boolean(this.apiKey()) || !this.needsKey();
    return {
      instanceId: this.ctx.instanceId,
      driver: this.driver,
      displayName: this.ctx.displayName,
      accentColor: this.ctx.accentColor,
      state: ready ? 'available' : 'unavailable',
      reason: ready ? undefined : 'No API key - add one in Settings -> Providers -> API keys',
      errorCode: ready ? undefined : 'invalid_credentials',
      models: this.config.models.map((mm, i) => ({ id: mm.id, label: mm.label ?? mm.id, default: i === 0 })),
      // Deliberately empty: text in, text out. No hands.
      capabilities: { ...NO_CAPABILITIES },
    };
  }

  private emit(input: SendTurnInput, partial: Partial<RuntimeEvent>): void {
    this.ctx.emit({
      eventId: randomUUID(),
      provider: this.driver,
      providerInstanceId: this.ctx.instanceId,
      threadId: input.threadId,
      createdAt: Date.now(),
      turnId: input.turnId,
      ...partial,
    } as RuntimeEvent);
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const key = this.apiKey();
    this.emit(input, { type: 'turn.started' });
    if (!key && this.needsKey()) {
      this.emit(input, { type: 'runtime.error', message: 'No API key configured', setup: true });
      this.emit(input, { type: 'turn.completed', stopReason: 'error' });
      return;
    }

    const controller = new AbortController();
    this.aborts.set(input.threadId, controller);
    input.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const messages = [
      { role: 'system', content: input.system },
      ...input.transcript.map((line) => ({
        role: line.role === 'user' ? 'user' : 'assistant',
        content: line.name ? `${line.name}: ${line.text}` : line.text,
      })),
      { role: 'user', content: input.text },
    ];

    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        // No header at all when there is no key: `Bearer undefined` is a 401 waiting
        // to happen, and a local runtime rejects an unexpected Authorization outright.
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: input.model, messages, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        this.emit(input, {
          type: 'runtime.error',
          message: `${res.status} ${detail.slice(0, 300)}`,
          setup: res.status === 401 || res.status === 403,
          errorCode: res.status === 429 ? 'quota_or_region_restriction' : 'upstream_outage',
        });
        this.emit(input, { type: 'turn.completed', stopReason: 'error' });
        return;
      }

      let full = '';
      let buffer = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              this.emit(input, { type: 'content.delta', itemKind: 'assistant_text', delta });
            }
          } catch {
            // Keep-alive comments and partial frames are expected here.
          }
        }
      }
      if (full) this.emit(input, { type: 'item.completed', itemKind: 'assistant_text', text: full });
      this.emit(input, { type: 'turn.completed', stopReason: 'completed' });
    } catch (err) {
      const interrupted = controller.signal.aborted;
      if (!interrupted) this.emit(input, { type: 'runtime.error', message: String(err) });
      this.emit(input, { type: 'turn.completed', stopReason: interrupted ? 'interrupted' : 'error' });
    } finally {
      this.aborts.delete(input.threadId);
    }
  }

  async answerRequest(_answer: AnswerRequestInput): Promise<void> {
    // No tools, so no requests are ever opened.
  }

  async interrupt(threadId: ThreadId): Promise<void> {
    this.aborts.get(threadId)?.abort();
  }

  async dropSession(): Promise<void> {
    // Stateless endpoint: the transcript is replayed on every turn.
  }

  async dispose(): Promise<void> {
    for (const c of this.aborts.values()) c.abort();
    this.aborts.clear();
  }
}

function decode(raw: unknown): OpenAiCompatConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl : '';
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('baseUrl must be http(s)');
  const models = Array.isArray(r.models) ? r.models : [];
  if (models.length === 0) throw new Error('at least one model is required');
  return {
    baseUrl,
    apiKeyEnv: typeof r.apiKeyEnv === 'string' ? r.apiKeyEnv : undefined,
    models: models.map((mm) => {
      const model = mm as Record<string, unknown>;
      if (typeof model.id !== 'string') throw new Error('model.id must be a string');
      return { id: model.id, label: typeof model.label === 'string' ? model.label : undefined };
    }),
  };
}

export const openAiCompatDriver: ProviderDriver<OpenAiCompatConfig> = {
  kind: 'openaiCompat',
  displayName: 'OpenAI-compatible',
  decodeConfig: decode,
  async create(config, ctx) {
    return new OpenAiCompatAdapter(config, ctx, 'openaiCompat');
  },
};

/** MiniMax speaks the same chat API; it differs only in default endpoint and models. */
export const miniMaxDriver: ProviderDriver<OpenAiCompatConfig> = {
  kind: 'minimax',
  displayName: 'MiniMax',
  decodeConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    return decode({
      baseUrl: r.baseUrl ?? 'https://api.minimax.chat/v1',
      apiKeyEnv: r.apiKeyEnv ?? 'MINIMAX_API_KEY',
      models: r.models ?? [{ id: 'minimax-m2', label: 'MiniMax M2' }],
    });
  },
  async create(config, ctx) {
    return new OpenAiCompatAdapter(config, ctx, 'minimax');
  },
};
