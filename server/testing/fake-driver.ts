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
 * In-process driver for registry, bus, store, and API tests. No child process, so
 * unit tests stay fast; the scripted fake CLI covers the spawn path separately.
 *
 * Behaviour is picked from the prompt text so a test can drive it without extra wiring.
 */

export interface FakeDriverConfig {
  /** Set to make create() reject, exercising the unavailable-shadow path. */
  failCreate?: string;
  models?: string[];
}

export class FakeAdapter implements ProviderAdapter {
  readonly driver = 'fake';
  private pending = new Map<string, { threadId: ThreadId; turnId: string }>();
  private aborts = new Map<ThreadId, AbortController>();
  /** Public so tests can assert cursor isolation without reaching into the store. */
  readonly sessions = new Map<ThreadId, string>();
  /** Prompts this adapter actually received, in order. */
  readonly lastInputs: SendTurnInput[] = [];

  private readonly config: FakeDriverConfig;
  private readonly ctx: DriverContext;

  constructor(config: FakeDriverConfig, ctx: DriverContext) {
    this.config = config;
    this.ctx = ctx;
  }

  get instanceId(): string {
    return this.ctx.instanceId;
  }

  async snapshot(): Promise<InstanceSnapshot> {
    return {
      instanceId: this.ctx.instanceId,
      driver: 'fake',
      displayName: this.ctx.displayName,
      state: 'available',
      models: (this.config.models ?? ['fake-1']).map((id, i) => ({ id, label: id, default: i === 0 })),
      capabilities: { ...NO_CAPABILITIES, queueing: true, steer: true, images: true, agentsMcp: true, customMcp: true },
    };
  }

  private emit(threadId: ThreadId, turnId: string, partial: Partial<RuntimeEvent>): void {
    this.ctx.emit({
      eventId: randomUUID(),
      provider: 'fake',
      providerInstanceId: this.ctx.instanceId,
      threadId,
      createdAt: Date.now(),
      turnId,
      ...partial,
    } as RuntimeEvent);
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    this.lastInputs.push(input);
    const { threadId, turnId, text } = input;
    const controller = new AbortController();
    this.aborts.set(threadId, controller);
    input.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const sessionId = (input.resumeCursor as string | undefined) ?? `sess_${randomUUID().slice(0, 8)}`;
    this.sessions.set(threadId, sessionId);
    this.emit(threadId, turnId, { type: 'session.started', sessionId, resumeCursor: sessionId });
    this.emit(threadId, turnId, { type: 'turn.started' });

    if (text.includes('/fail')) {
      this.emit(threadId, turnId, { type: 'runtime.error', message: 'fake failure', setup: false });
      this.emit(threadId, turnId, { type: 'turn.completed', stopReason: 'error' });
      this.aborts.delete(threadId);
      return;
    }

    if (text.includes('/setup')) {
      this.emit(threadId, turnId, { type: 'runtime.error', message: 'CLI not installed', setup: true, errorCode: 'missing_cli' });
      this.emit(threadId, turnId, { type: 'turn.completed', stopReason: 'error' });
      this.aborts.delete(threadId);
      return;
    }

    if (text.includes('/permission')) {
      const requestId = `req_${randomUUID().slice(0, 8)}`;
      this.pending.set(requestId, { threadId, turnId });
      this.emit(threadId, turnId, {
        type: 'request.opened',
        requestKind: 'permission',
        toolName: 'Bash',
        summary: 'git status',
        allowKey: 'Bash:git',
        requestId,
        approvalScope: text.includes('/local') ? 'local-computer' : undefined,
      });
      return; // Turn stays open until the card is answered.
    }

    if (text.includes('/tool')) {
      this.emit(threadId, turnId, { type: 'item.started', itemKind: 'tool', toolName: 'Read', title: 'README.md' });
      this.emit(threadId, turnId, { type: 'item.completed', itemKind: 'tool', toolName: 'Read', ok: true });
    }

    for (const piece of ['pong', ': ', text.slice(0, 40)]) {
      if (controller.signal.aborted) break;
      this.emit(threadId, turnId, { type: 'content.delta', itemKind: 'assistant_text', delta: piece });
    }

    if (controller.signal.aborted) {
      this.emit(threadId, turnId, { type: 'turn.completed', stopReason: 'interrupted' });
      this.aborts.delete(threadId);
      return;
    }

    this.emit(threadId, turnId, {
      type: 'item.completed',
      itemKind: 'assistant_text',
      text: `pong: ${text.slice(0, 40)}`,
    });
    this.emit(threadId, turnId, {
      type: 'turn.completed',
      stopReason: 'completed',
      usage: { input: 10, output: 5, cachedInput: 2, costUsd: 0.001 },
    });
    this.aborts.delete(threadId);
  }

  async answerRequest(answer: AnswerRequestInput): Promise<void> {
    const found = this.pending.get(answer.requestId);
    if (!found) return;
    this.pending.delete(answer.requestId);
    const { threadId, turnId } = found;
    this.emit(threadId, turnId, {
      type: 'request.resolved',
      requestId: answer.requestId,
      outcome: answer.outcome,
      source: answer.source,
      answer: answer.answer,
    });
    const allowed = answer.outcome === 'allowed-once';
    this.emit(threadId, turnId, {
      type: 'item.completed',
      itemKind: 'assistant_text',
      text: allowed ? 'ran the command' : 'did not run the command',
    });
    this.emit(threadId, turnId, { type: 'turn.completed', stopReason: allowed ? 'completed' : 'denied' });
  }

  async interrupt(threadId: ThreadId): Promise<void> {
    this.aborts.get(threadId)?.abort();
    this.emit(threadId, 'interrupt', { type: 'turn.completed', stopReason: 'interrupted' });
  }

  async dropSession(threadId: ThreadId): Promise<void> {
    this.sessions.delete(threadId);
  }

  async dispose(): Promise<void> {
    for (const c of this.aborts.values()) c.abort();
    this.aborts.clear();
    this.pending.clear();
  }
}

export const fakeDriver: ProviderDriver<FakeDriverConfig> = {
  kind: 'fake',
  displayName: 'Fake',
  decodeConfig(raw) {
    if (raw && typeof raw === 'object' && 'invalid' in raw) throw new Error('invalid fake config');
    return (raw ?? {}) as FakeDriverConfig;
  },
  async create(config, ctx) {
    // Async rejection, never a sync throw: the registry turns this into a shadow.
    if (config.failCreate) throw new Error(config.failCreate);
    return new FakeAdapter(config, ctx);
  },
};
