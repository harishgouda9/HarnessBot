import type { BotRecord, GroupRecord, Message } from '../../../../shared/types.ts';
import { nextHarnessAction } from './logic.ts';

/**
 * The harness, as the desktop plugin sees it.
 *
 * Every call goes through `ctx.rest`, which is the plugin's own namespace
 * (`/api/plugins/harnessbot/…`) and therefore already behind Hermes' auth — the
 * plugin never assembles a URL or handles a token itself. `/hb/*` is the proxy
 * hop the Python router forwards to the loopback harness.
 */

export interface PluginRestOptions {
  method?: string;
  body?: unknown;
}

export interface PluginCtx {
  rest<T>(path: string, opts?: PluginRestOptions): Promise<T>;
  socket(path: string, onMessage: (data: unknown) => void): () => void;
  register(contribution: unknown): () => void;
  registerMany(contributions: unknown[]): () => void;
  onDispose(fn: () => void): void;
  storage: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  os?: { openExternal?(url: string): void; notify?(title: string, body?: string): void };
}

export interface HarnessHealth {
  app?: string;
  version?: string;
  pid?: number;
  static?: boolean;
}

export interface HarnessStatus {
  running: boolean;
  installed: boolean;
  ui_built: boolean;
  static_ui_built?: boolean;
  url: string | null;
  pid: number | null;
  app_dir: string;
  data_dir: string;
  node: string | null;
  health?: HarnessHealth | null;
}

export interface HarnessCommandResult {
  ok: boolean;
  error?: string;
  url?: string | null;
}

const BUILD_HINT = 'Run `node scripts/build-hermes-plugin.mjs` in the HarnessBot checkout, then reload desktop plugins.';

export interface HermesBridgeStatus {
  connected: boolean;
  profile?: string;
  skillsRoot?: string | null;
  mcpServers: number;
  skills: number;
}

export interface EngineInstance {
  instanceId: string;
  driver: string;
  available: boolean;
  models?: { id: string; label: string }[];
}

export class Harness {
  constructor(private readonly ctx: PluginCtx) {}

  /** Plugin-level: is the harness process up, and where does it live. */
  status(): Promise<HarnessStatus> {
    return this.ctx.rest<HarnessStatus>('/status');
  }

  start(): Promise<HarnessCommandResult> {
    return this.ctx.rest('/start', { method: 'POST' });
  }

  restart(): Promise<HarnessCommandResult> {
    return this.ctx.rest('/restart', { method: 'POST' });
  }

  /**
   * Bring the harness up serving the full UI, or explain why it cannot.
   *
   * Side-effecting on purpose: the desktop page is a viewport onto the product,
   * and a harness that is up but answering JSON at GET / is the bug the user
   * hit (`{"error":"not found"}` at 127.0.0.1:8799).
   */
  async ensureRunning(): Promise<HarnessStatus & HarnessCommandResult> {
    let status = await this.status();
    const action = nextHarnessAction(status);

    if (action === 'build') {
      return { ...status, ok: false, error: `HarnessBot's interface has not been built. ${BUILD_HINT}` };
    }

    if (action === 'start' || action === 'restart') {
      const result = action === 'start' ? await this.start() : await this.restart();
      if (!result.ok) return { ...status, ok: false, error: result.error || `the harness could not be ${action}ed` };
      status = await this.status();
    }

    if (!status.running || !status.url) {
      return { ...status, ok: false, error: 'HarnessBot started but is not answering.' };
    }
    if (!status.health?.static) {
      return { ...status, ok: false, error: `HarnessBot is running but not serving its UI. ${BUILD_HINT}` };
    }
    return { ...status, ok: true };
  }

  private api<T>(path: string, opts?: PluginRestOptions): Promise<T> {
    return this.ctx.rest<T>(`/hb/api${path}`, opts);
  }

  bots(): Promise<BotRecord[]> {
    return this.api<BotRecord[]>('/bots');
  }

  bot(id: string): Promise<BotRecord> {
    return this.api<BotRecord>(`/bots/${encodeURIComponent(id)}`);
  }

  groups(): Promise<GroupRecord[]> {
    return this.api<GroupRecord[]>('/groups');
  }

  engines(): Promise<EngineInstance[]> {
    return this.api<EngineInstance[]>('/instances');
  }

  hermes(): Promise<HermesBridgeStatus> {
    return this.api<HermesBridgeStatus>('/hermes');
  }

  messages(threadId: string, all = false): Promise<{ messages: Message[] }> {
    return this.api(`/threads/${encodeURIComponent(threadId)}/messages${all ? '?all=true' : ''}`);
  }

  send(botId: string, text: string, threadId?: string): Promise<unknown> {
    return this.api(`/bots/${encodeURIComponent(botId)}/messages`, {
      method: 'POST',
      body: { text, threadId },
    });
  }

  interrupt(botId: string): Promise<unknown> {
    return this.api(`/bots/${encodeURIComponent(botId)}/interrupt`, { method: 'POST' });
  }

  /** Answer an approval card. The harness owns the decision log; this only relays. */
  respond(botId: string, requestId: string, choiceId: string, answer?: string): Promise<unknown> {
    return this.api(`/bots/${encodeURIComponent(botId)}/respond`, {
      method: 'POST',
      body: { requestId, choiceId, answer },
    });
  }
}

/** Query keys, in one place so an invalidation cannot miss a view. */
export const KEYS = {
  status: ['harnessbot', 'status'] as const,
  bots: ['harnessbot', 'bots'] as const,
  groups: ['harnessbot', 'groups'] as const,
  engines: ['harnessbot', 'engines'] as const,
  hermes: ['harnessbot', 'hermes'] as const,
  thread: (id: string) => ['harnessbot', 'thread', id] as const,
};
