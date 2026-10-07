import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AnswerRequestInput,
  DriverCapabilities,
  DriverContext,
  InstanceSnapshot,
  McpMount,
  ModelInfo,
  PermissionChoice,
  ProviderAdapter,
  ProviderDriver,
  RuntimeEvent,
  SendTurnInput,
  ThreadId,
  TokenUsage,
  TurnIntegrations,
} from '../contracts.ts';
import { NO_CAPABILITIES } from '../contracts.ts';
import { appendNdjsonLimited, dataPath, threadLogPath } from '../paths.ts';
import { findCli, killTree, lineReader, spawnCli } from './spawn.ts';
import { allowKeyFor } from './cli.ts';
import { isComputerTool } from '../computer.ts';

/**
 * Agent Client Protocol — JSON-RPC 2.0 over stdio, newline delimited.
 *
 * The difference from `cli.ts` that shapes this whole file: ACP is a *connection*,
 * not a command. One process serves many sessions, and it is expensive to start
 * (a real agent spends tens of seconds loading plugins before it answers), so a
 * process-per-turn would make every message pay that cost. The child therefore
 * outlives the turn, sessions are multiplexed over it by `sessionId`, and the
 * per-thread mapping is what `dropSession` throws away after a rewind.
 *
 * What this buys over a one-shot CLI is the whole point of the protocol: streamed
 * text, tool calls as they happen, and permission requests the user can answer —
 * which is what lets these engines honestly declare tool capabilities.
 */

export interface AcpDriverConfig {
  /** Explicit executable path from Settings -> Engines. */
  command?: string;
  /** Extra argv placed before the spec's own ACP flags. */
  args?: string[];
  env?: Record<string, string>;
}

export interface AcpDriverSpec {
  kind: string;
  displayName: string;
  /** Executable name looked up on PATH when config.command is unset. */
  bin: string;
  /** The flags that put this CLI into ACP mode, e.g. `['acp']`. */
  acpArgs: string[];
  models: ModelInfo[];
  capabilities: Partial<DriverCapabilities>;
  /** Env var holding this provider's credential. Nothing else is inherited. */
  secretEnv?: string;
}

const cap = (partial: Partial<DriverCapabilities>): DriverCapabilities => ({ ...NO_CAPABILITIES, ...partial });

/** The protocol revision this client speaks. Bumping it is a deliberate act. */
const PROTOCOL_VERSION = 1;

/** A boot that never finishes must not wedge a turn forever. */
const START_TIMEOUT_MS = 120_000;

/** A client write bigger than this is refused. Pipeline files are far smaller. */
const MAX_FILE_CHARS = 1_000_000;

/** True when `file` is `root` or a path inside it. A sibling prefix does not count. */
export function containedPath(root: string, file: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(file);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Absolute path the agent may read or write: this session's folder, or the shared
 * workspace every bot already uses for handoffs. Anywhere else is refused.
 */
export function allowedFilePath(roots: string[], file: string): string | null {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const target = path.resolve(file);
  for (const root of roots) {
    if (root && containedPath(root, target)) return target;
  }
  return null;
}

export function relativeToRoots(roots: string[], file: string): string {
  for (const root of roots) {
    if (root && containedPath(root, file)) return path.relative(root, file);
  }
  return path.basename(file);
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface LiveTurn {
  threadId: ThreadId;
  turnId: string;
  sessionId: string;
  settled: boolean;
  /** Cards opened by this turn, cancelled when it ends so none outlives it. */
  openRequests: Set<string>;
}

interface OpenPermission {
  rpcId: number;
  threadId: ThreadId;
  options: { optionId: string; name?: string; kind?: string }[];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Label for one ACP model row.
 *
 * Hermes inventory names are already `Provider label · model-id`. Prefixing the
 * slug again (`openai-codex · ChatGPT or Codex Subscription · gpt-5.4`) pushes
 * the only unique part past the end of a truncated row. A short advertised name
 * such as `Nemotron` is kept; the provider is a group header, not part of the name.
 */
export function acpModelLabel(id: string, name: string): string {
  const cut = id.indexOf(':');
  const modelPart = cut > 0 ? id.slice(cut + 1) : id;
  const provider = cut > 0 ? id.slice(0, cut) : '';
  const advertised = name.trim() || id;
  if (!provider) return advertised;
  const sep = advertised.lastIndexOf(' · ');
  if (sep >= 0) {
    const tail = advertised.slice(sep + 3).trim();
    if (tail && tail.toLowerCase() === modelPart.toLowerCase()) return tail;
    if (tail && tail.length <= 64) return tail;
    return modelPart;
  }
  return advertised;
}

/**
 * Models advertised by `session/new`. Hermes ids are `provider:model`, and the
 * picker has to keep that id — it is what `session/set_model` expects.
 */
export function readAcpModels(result: Record<string, unknown>): ModelInfo[] {
  const models = asRecord(result.models);
  const raw = models.availableModels ?? models.available_models;
  if (!Array.isArray(raw)) return [];
  const current = str(models.currentModelId ?? models.current_model_id);
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const rec = asRecord(item);
    const id = str(rec.modelId ?? rec.model_id ?? rec.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = str(rec.name) ?? id;
    out.push({ id, label: acpModelLabel(id, name), default: current ? id === current : undefined });
  }
  return out;
}

/** Learned catalogue first, then any built-in id the agent did not already list. */
export function mergeCatalog(spec: ModelInfo[], learned: ModelInfo[]): ModelInfo[] {
  if (!learned.length) return spec;
  const seen = new Set(learned.map((m) => m.id));
  return [...learned, ...spec.filter((m) => !seen.has(m.id))];
}

function catalogPath(dataDir: string, instanceId: string): string {
  const safe = instanceId.replace(/[^\w.-]/g, '') || 'instance';
  return path.join(dataDir, `acp-models-${safe}.json`);
}

function loadCatalog(file: string): ModelInfo[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ModelInfo[] = [];
    for (const item of parsed) {
      const rec = asRecord(item);
      const id = str(rec.id);
      if (!id) continue;
      out.push({ id, label: str(rec.label) ?? id, default: rec.default === true });
    }
    return out;
  } catch {
    return [];
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** ACP carries env and headers as name/value pairs, not as objects. */
const pairs = (obj?: Record<string, string>): { name: string; value: string }[] =>
  Object.entries(obj ?? {}).map(([name, value]) => ({ name, value }));

function mcpServer(name: string, mount: McpMount): Record<string, unknown> {
  return mount.transport === 'stdio'
    ? { name, command: mount.command, args: mount.args, env: pairs(mount.env) }
    : { type: 'http', name, url: mount.url, headers: pairs(mount.headers) };
}

/** Only mounts the driver declared support for reach this point; the turn builder gates. */
export function mcpServersFor(integrations: TurnIntegrations): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [name, mount] of Object.entries(integrations) as [string, McpMount | undefined][]) {
    if (!mount || name === 'custom') continue;
    out.push(mcpServer(name, mount));
  }
  for (const [name, mount] of Object.entries(integrations.custom ?? {})) out.push(mcpServer(name, mount));
  return out;
}

/** ACP reports totals for the turn; the harness banks them once, on turn.completed. */
function readUsage(v: unknown): TokenUsage | undefined {
  const u = asRecord(v);
  const input = Number(u.inputTokens ?? 0);
  const output = Number(u.outputTokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cachedInput: Number(u.cachedReadTokens ?? 0) || undefined,
  };
}

/** ACP stop reasons -> the harness's smaller vocabulary. */
function stopReasonOf(raw: unknown): 'completed' | 'interrupted' | 'denied' | 'error' | 'timeout' {
  switch (str(raw)) {
    case 'cancelled':
      return 'interrupted';
    case 'refusal':
      return 'denied';
    case 'max_tokens':
    case 'max_turn_requests':
      return 'timeout';
    default:
      return 'completed';
  }
}

class AcpAdapter implements ProviderAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** threadId -> ACP sessionId, and back: updates arrive keyed by session. */
  private sessions = new Map<ThreadId, string>();
  /** What that session was opened with. A later opt-in must not keep a session that has no hands. */
  private mounted = new Map<ThreadId, string>();
  private threadOf = new Map<string, ThreadId>();
  private turns = new Map<ThreadId, LiveTurn>();
  private permissions = new Map<string, OpenPermission>();
  private stderrTail = '';
  private cachedSnapshot?: { at: number; value: InstanceSnapshot };
  /** Models the agent reported. Survives restart so the picker is not one row until the next probe. */
  private learned: ModelInfo[] = [];
  /**
   * Model id last confirmed on that ACP session.
   * The catalogue `default` flag is not this: a refresh or another bot's switch
   * rewrites it, and the next turn would skip `session/set_model` while this
   * session was still on the model it opened with.
   */
  private sessionModel = new Map<string, string>();
  /** Folder the session was opened in. File methods may also use the shared workspace. */
  private sessionCwd = new Map<string, string>();
  private probing: Promise<ModelInfo[]> | null = null;

  private readonly spec: AcpDriverSpec;
  private readonly config: AcpDriverConfig;
  private readonly ctx: DriverContext;

  constructor(spec: AcpDriverSpec, config: AcpDriverConfig, ctx: DriverContext) {
    this.spec = spec;
    this.config = config;
    this.ctx = ctx;
    this.learned = loadCatalog(catalogPath(ctx.dataDir, ctx.instanceId));
  }

  get instanceId(): string {
    return this.ctx.instanceId;
  }

  get driver(): string {
    return this.spec.kind;
  }

  private resolveCommand(): string | null {
    return this.config.command ? (findCli(this.config.command) ?? null) : findCli(this.spec.bin);
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...this.config.env };
    if (this.spec.secretEnv) {
      const value = this.ctx.secret('primary');
      if (value) env[this.spec.secretEnv] = value;
    }
    return env;
  }

  async snapshot(): Promise<InstanceSnapshot> {
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cachedSnapshot.at < 15_000) return this.cachedSnapshot.value;

    const command = this.resolveCommand();
    const base = {
      instanceId: this.ctx.instanceId,
      driver: this.spec.kind,
      bin: this.spec.bin,
      displayName: this.ctx.displayName,
      accentColor: this.ctx.accentColor,
      models: mergeCatalog(this.spec.models, this.learned),
      capabilities: cap(this.spec.capabilities),
    };
    // Deliberately does not start the agent: snapshot() runs on every roster read and
    // booting an ACP agent costs tens of seconds.
    const value: InstanceSnapshot = command
      ? { ...base, state: 'available' }
      : {
          ...base,
          state: 'unavailable',
          reason: `${this.spec.displayName} CLI not found - install it, or set an absolute path in Settings -> Engines`,
          errorCode: 'missing_cli',
          models: [],
          capabilities: cap({}),
        };
    this.cachedSnapshot = { at: now, value };
    return value;
  }

  /**
   * One throwaway session, only to read the catalogue. Hermes lists every
   * authenticated provider here; the static spec cannot know that set.
   */
  async refreshModels(): Promise<ModelInfo[]> {
    if (this.probing) return this.probing;
    this.probing = this.probeModels().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async probeModels(): Promise<ModelInfo[]> {
    await this.ensureChild();
    const result = await this.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    const found = readAcpModels(result);
    if (found.length) this.remember(found);
    return found;
  }

  private remember(models: ModelInfo[]): void {
    this.learned = models;
    this.cachedSnapshot = undefined;
    try {
      fs.writeFileSync(catalogPath(this.ctx.dataDir, this.ctx.instanceId), JSON.stringify(models));
    } catch {
      // The in-memory list still serves this process.
    }
  }

  /** Switch this session when its confirmed model is not the one the turn asked for. `default` leaves Hermes on its config. */
  private async applyModel(threadId: ThreadId, sessionId: string, model: string): Promise<void> {
    if (!model || model === 'default') return;
    if (this.sessionModel.get(sessionId) === model) return;
    // Hermes accepts a provider:model id it has not advertised yet (a stale catalogue,
    // or a model the user added). Other agents only switch to an id they listed.
    if (this.spec.kind !== 'hermes' && !this.learned.some((m) => m.id === model)) return;
    try {
      await this.request('session/set_model', { sessionId, modelId: model });
      this.sessionModel.set(sessionId, model);
      if (this.learned.some((m) => m.id === model)) {
        this.remember(this.learned.map((m) => ({ ...m, default: m.id === model })));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stayed = this.sessionModel.get(sessionId);
      this.emit(threadId, {
        type: 'runtime.error',
        message: stayed
          ? `Could not switch to ${model} (${message}). This turn stays on ${stayed}.`
          : `Could not switch to ${model} (${message}). This turn stays on the model the session opened with.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private write(message: Record<string, unknown>): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler is the one place that reports a dead child.
    }
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private emit(threadId: ThreadId, partial: Partial<RuntimeEvent>, raw?: unknown): void {
    const turn = this.turns.get(threadId);
    this.ctx.emit({
      eventId: randomUUID(),
      provider: this.spec.kind,
      providerInstanceId: this.ctx.instanceId,
      threadId,
      createdAt: Date.now(),
      turnId: turn?.turnId,
      raw,
      ...partial,
    } as RuntimeEvent);
  }

  /** Spawn and handshake once. Every caller awaits the same promise. */
  private ensureChild(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const command = this.resolveCommand();
      if (!command) throw new Error(`${this.spec.displayName} CLI not found`);

      const args = [...(this.config.args ?? []), ...this.spec.acpArgs];
      const child = spawnCli(command, args, { env: this.childEnv() });
      this.child = child;

      child.stdout.on(
        'data',
        lineReader((line) => {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            return; // Agents print banners on stdout before the protocol settles.
          }
          this.onMessage(asRecord(message));
        }),
      );

      // Agents log freely to stderr; keep only enough to explain a failure.
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-8192);
      });

      child.on('error', (err) => this.onChildGone(err.message));
      child.on('close', (code) => this.onChildGone(`${this.spec.bin} exited with code ${code}`));

      const initialize = this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${this.spec.displayName} did not answer initialize`)), START_TIMEOUT_MS),
      );
      await Promise.race([initialize, timeout]);
    })();

    // A failed boot must not be cached as "starting": the next turn gets a fresh try.
    this.starting.catch(() => {
      this.starting = null;
      this.child = null;
    });
    return this.starting;
  }

  private onChildGone(reason: string): void {
    const detail = this.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    for (const { reject } of this.pending.values()) reject(new Error(detail || reason));
    this.pending.clear();
    this.sessions.clear();
    this.mounted.clear();
    this.threadOf.clear();
    this.sessionModel.clear();
    this.sessionCwd.clear();
    this.permissions.clear();
    this.child = null;
    this.starting = null;
    // Every turn still in flight has to settle; a dead agent must not hang the UI.
    // Copied on purpose: settle() deletes from this.turns as we go.
    // oxlint-disable-next-line unicorn/no-useless-spread -- intentional snapshot
    for (const turn of [...this.turns.values()]) {
      if (turn.settled) continue;
      this.emit(turn.threadId, { type: 'runtime.error', message: detail || reason });
      this.settle(turn, { type: 'turn.completed', stopReason: 'error' });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    const method = str(msg.method);

    if (typeof id === 'number' && !method) {
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      if (msg.error) waiting.reject(new Error(str(asRecord(msg.error).message) ?? 'ACP error'));
      else waiting.resolve(asRecord(msg.result));
      return;
    }
    if (typeof id === 'number' && method) {
      this.onAgentRequest(id, method, asRecord(msg.params));
      return;
    }
    if (method) this.onNotification(method, asRecord(msg.params), msg);
  }

  private rootsFor(sessionId: string): string[] {
    const roots = [dataPath('workspace')];
    const cwd = this.sessionCwd.get(sessionId);
    // Home is the fallback desk, not a project. A write there would skip the approval card.
    if (cwd && path.resolve(cwd) !== path.resolve(os.homedir())) roots.push(cwd);
    return roots;
  }

  /** Read or write a text file the agent asked the client to touch. Content never goes into the transcript. */
  private onClientFile(id: number, method: string, params: Record<string, unknown>): void {
    const sessionId = str(params.sessionId) ?? '';
    const threadId = this.threadOf.get(sessionId);
    const roots = this.rootsFor(sessionId);
    const file = allowedFilePath(roots, str(params.path) ?? '');
    if (!threadId || !file) {
      const workspace = dataPath('workspace');
      this.respondError(
        id,
        -32000,
        `that path is outside the shared workspace (${workspace}) and this bot's project folder. Use an absolute path inside ${workspace}.`,
      );
      return;
    }
    const shown = relativeToRoots(roots, file);
    try {
      if (method === 'fs/read_text_file') {
        const raw = fs.readFileSync(file, 'utf8').slice(0, MAX_FILE_CHARS);
        const lines = raw.split('\n');
        const start = Math.max(0, Number(params.line ?? 1) - 1);
        const count = params.limit === undefined ? lines.length : Math.max(0, Number(params.limit));
        this.emit(threadId, { type: 'item.completed', itemKind: 'tool', toolName: 'Read', title: shown, ok: true });
        this.respond(id, { content: lines.slice(start, start + count).join('\n') });
        return;
      }
      const content = typeof params.content === 'string' ? params.content : '';
      if (content.length > MAX_FILE_CHARS) {
        this.respondError(id, -32000, 'that file is too large to write');
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      const bytes = Buffer.byteLength(content);
      this.emit(threadId, {
        type: 'item.completed',
        itemKind: 'tool',
        toolName: 'Write',
        title: `${shown} (${bytes} bytes)`,
        ok: true,
      });
      this.respond(id, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'could not touch that file';
      this.emit(threadId, { type: 'item.completed', itemKind: 'tool', toolName: 'Write', title: shown, ok: false });
      this.respondError(id, -32000, message);
    }
  }

  private onAgentRequest(id: number, method: string, params: Record<string, unknown>): void {
    if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
      this.onClientFile(id, method, params);
      return;
    }

    if (method !== 'session/request_permission') {
      this.respondError(id, -32601, `${method} is not supported by this client`);
      return;
    }

    const threadId = this.threadOf.get(str(params.sessionId) ?? '');
    const toolCall = asRecord(params.toolCall);
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options = rawOptions.map((o) => {
      const rec = asRecord(o);
      return { optionId: String(rec.optionId ?? ''), name: str(rec.name), kind: str(rec.kind) };
    });

    if (!threadId) {
      // An update for a session we do not own: refuse rather than guess a thread.
      this.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }

    const requestId = randomUUID();
    this.permissions.set(requestId, { rpcId: id, threadId, options });
    this.turns.get(threadId)?.openRequests.add(requestId);

    const toolName = str(toolCall.title) ?? str(toolCall.kind) ?? 'Command';
    const detail = str(asRecord(toolCall.rawInput).command) ?? str(toolCall.title);
    const approvalScope = isComputerTool(toolName) ? ('local-computer' as const) : undefined;
    const choices: PermissionChoice[] = options.map((o) => ({
      id: o.optionId,
      label: o.name ?? o.optionId,
      destructive: /reject|deny/i.test(o.kind ?? ''),
    }));

    this.emit(
      threadId,
      {
        type: 'request.opened',
        requestKind: 'permission',
        toolName,
        summary: str(toolCall.title) ?? `${toolName} wants to run`,
        requestId,
        choices,
        destructive: /delete|remove|write|execute/i.test(str(toolCall.kind) ?? ''),
        allowKey: allowKeyFor(toolName, detail),
        approvalScope,
      },
      params,
    );
  }

  private onNotification(method: string, params: Record<string, unknown>, raw: unknown): void {
    if (method !== 'session/update') return;
    const threadId = this.threadOf.get(str(params.sessionId) ?? '');
    if (!threadId) return;

    const update = asRecord(params.update);
    const kind = str(update.sessionUpdate);
    const nativeLog = threadLogPath('native', threadId);
    if (nativeLog) {
      appendNdjsonLimited(nativeLog, {
        at: Date.now(),
        dir: 'in',
        source: this.spec.kind,
        msg: raw,
      });
    }

    switch (kind) {
      case 'agent_message_chunk': {
        const text = str(asRecord(update.content).text);
        if (text) this.emit(threadId, { type: 'content.delta', itemKind: 'assistant_text', delta: text }, raw);
        break;
      }
      case 'agent_thought_chunk': {
        const text = str(asRecord(update.content).text);
        if (text) this.emit(threadId, { type: 'content.delta', itemKind: 'reasoning', delta: text }, raw);
        break;
      }
      case 'tool_call': {
        this.emit(
          threadId,
          {
            type: 'item.started',
            itemKind: 'tool',
            toolName: str(update.kind) ?? 'tool',
            title: str(update.title),
            itemId: str(update.toolCallId),
          },
          raw,
        );
        break;
      }
      case 'tool_call_update': {
        const status = str(update.status);
        // in_progress is noise; only a settled call is worth a line in the transcript.
        if (status !== 'completed' && status !== 'failed') break;
        this.emit(
          threadId,
          {
            type: 'item.completed',
            itemKind: 'tool',
            toolName: str(update.kind) ?? 'tool',
            title: str(update.title),
            ok: status === 'completed',
            itemId: str(update.toolCallId),
          },
          raw,
        );
        break;
      }
      default:
        // plan / usage_update / available_commands_update / session_info_update carry
        // nothing the harness models today. They stay in the native log for the inspector.
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private async ensureSession(input: SendTurnInput, signature: string): Promise<string> {
    const existing = this.sessions.get(input.threadId);
    if (existing && this.mounted.get(input.threadId) === signature) return existing;
    if (existing) {
      this.threadOf.delete(existing);
      this.sessions.delete(input.threadId);
      this.sessionModel.delete(existing);
      this.sessionCwd.delete(existing);
    }

    const result = await this.request('session/new', {
      cwd: input.cwd ?? process.cwd(),
      mcpServers: mcpServersFor(input.integrations),
    });
    const sessionId = str(result.sessionId);
    if (!sessionId) throw new Error('the agent created no session');
    const advertised = readAcpModels(result);
    if (advertised.length) this.remember(advertised);
    const booted = advertised.find((m) => m.default)?.id;
    if (booted) this.sessionModel.set(sessionId, booted);

    this.sessions.set(input.threadId, sessionId);
    this.mounted.set(input.threadId, signature);
    this.threadOf.set(sessionId, input.threadId);
    if (input.cwd) this.sessionCwd.set(sessionId, input.cwd);
    // Deliberately no resumeCursor. The harness stops replaying the branch once one is
    // stored (turns.ts), but this map is in memory — so after a harness restart we would
    // open a blank session and be handed no history to put in it. Reporting no cursor
    // keeps the transcript coming, and `fresh` below decides when to replay it.
    this.emit(input.threadId, { type: 'session.started', sessionId });
    return sessionId;
  }

  private settle(turn: LiveTurn, partial: Partial<RuntimeEvent>): void {
    if (turn.settled) return;
    turn.settled = true;
    // An unanswered card must never outlive its turn: fail closed, never act.
    for (const requestId of turn.openRequests) {
      const open = this.permissions.get(requestId);
      if (open) {
        this.respond(open.rpcId, { outcome: { outcome: 'cancelled' } });
        this.permissions.delete(requestId);
      }
      this.emit(turn.threadId, { type: 'request.resolved', outcome: 'unavailable', source: 'system', requestId });
    }
    turn.openRequests.clear();
    this.emit(turn.threadId, partial);
    this.turns.delete(turn.threadId);
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const turn: LiveTurn = {
      threadId: input.threadId,
      turnId: input.turnId,
      sessionId: '',
      settled: false,
      openRequests: new Set(),
    };
    this.turns.set(input.threadId, turn);
    this.emit(input.threadId, { type: 'turn.started' });

    // Whether this turn opens the session decides whether it has to carry the history.
    // A change in mounts (the user opted into the desktop) opens a new session too,
    // or the agent would keep the empty tool list from the first message.
    const signature = JSON.stringify(mcpServersFor(input.integrations));
    const fresh = !this.sessions.has(input.threadId) || this.mounted.get(input.threadId) !== signature;
    let sessionId: string;
    try {
      await this.ensureChild();
      sessionId = await this.ensureSession(input, signature);
      turn.sessionId = sessionId;
      await this.applyModel(input.threadId, sessionId, input.model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const setup = /not found|initialize|auth|credential/i.test(message);
      this.emit(input.threadId, {
        type: 'runtime.error',
        message,
        setup,
        errorCode: /not found/i.test(message) ? 'missing_cli' : undefined,
      });
      this.settle(turn, { type: 'turn.completed', stopReason: 'error' });
      return;
    }

    const onAbort = (): void => {
      this.notify('session/cancel', { sessionId });
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    const blocks: Record<string, unknown>[] = [];
    if (fresh) {
      // A new ACP session starts empty, so the visible branch has to be replayed into
      // it — otherwise a rewind or a restart silently drops the conversation.
      const preamble = [input.system, ...input.transcript.map((l) => `${l.name ?? l.role}: ${l.text}`)]
        .filter(Boolean)
        .join('\n\n');
      if (preamble) blocks.push({ type: 'text', text: preamble });
    }
    blocks.push({ type: 'text', text: input.text });
    for (const image of input.images ?? []) {
      blocks.push({ type: 'image', mimeType: image.mime, data: image.data });
    }

    try {
      const result = await this.request('session/prompt', { sessionId, prompt: blocks });
      this.settle(turn, {
        type: 'turn.completed',
        usage: readUsage(result.usage),
        stopReason: input.signal.aborted ? 'interrupted' : stopReasonOf(result.stopReason),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!turn.settled) {
        this.emit(input.threadId, { type: 'runtime.error', message });
        this.settle(turn, { type: 'turn.completed', stopReason: 'error' });
      }
    } finally {
      input.signal.removeEventListener('abort', onAbort);
    }
  }

  async answerRequest(answer: AnswerRequestInput): Promise<void> {
    const open = this.permissions.get(answer.requestId);
    if (!open) return;
    this.permissions.delete(answer.requestId);
    this.turns.get(open.threadId)?.openRequests.delete(answer.requestId);

    // An explicit choice wins; otherwise map the harness's verdict onto the agent's
    // own option list, because only the agent knows what it offered.
    const wanted = answer.choiceId
      ? open.options.find((o) => o.optionId === answer.choiceId)
      : answer.outcome === 'allowed-once'
        ? (open.options.find((o) => o.kind === 'allow_once') ?? open.options.find((o) => /allow/i.test(o.kind ?? '')))
        : (open.options.find((o) => o.kind === 'reject_once') ?? open.options.find((o) => /reject|deny/i.test(o.kind ?? '')));

    if (answer.outcome === 'unavailable' || !wanted) this.respond(open.rpcId, { outcome: { outcome: 'cancelled' } });
    else this.respond(open.rpcId, { outcome: { outcome: 'selected', optionId: wanted.optionId } });

    this.emit(open.threadId, {
      type: 'request.resolved',
      requestId: answer.requestId,
      outcome: answer.outcome,
      source: answer.source,
      answer: answer.answer,
    });
  }

  async interrupt(threadId: ThreadId): Promise<void> {
    const sessionId = this.sessions.get(threadId);
    if (!sessionId) return;
    this.notify('session/cancel', { sessionId });
    const turn = this.turns.get(threadId);
    // The agent should answer the pending prompt with `cancelled`; if it never does,
    // this is what stops the UI spinning forever.
    if (turn) setTimeout(() => this.settle(turn, { type: 'turn.completed', stopReason: 'interrupted' }), 5_000).unref?.();
  }

  async dropSession(threadId: ThreadId): Promise<void> {
    const sessionId = this.sessions.get(threadId);
    if (sessionId) {
      this.threadOf.delete(sessionId);
      this.sessionModel.delete(sessionId);
      this.sessionCwd.delete(sessionId);
    }
    this.sessions.delete(threadId);
    this.mounted.delete(threadId);
    const turn = this.turns.get(threadId);
    if (turn) this.settle(turn, { type: 'turn.completed', stopReason: 'interrupted' });
  }

  async dispose(): Promise<void> {
    // Copied on purpose: settle() deletes from this.turns as we go.
    // oxlint-disable-next-line unicorn/no-useless-spread -- intentional snapshot
    for (const turn of [...this.turns.values()]) this.settle(turn, { type: 'turn.completed', stopReason: 'interrupted' });
    if (this.child) killTree(this.child);
    this.child = null;
    this.starting = null;
    this.pending.clear();
    this.sessions.clear();
    this.mounted.clear();
    this.threadOf.clear();
    this.sessionModel.clear();
    this.sessionCwd.clear();
    this.permissions.clear();
  }
}

/** One Grok ACP process. Headless `grok` has no MCP flag; `grok agent stdio` does. */
export function createHandsSession(ctx: DriverContext, config: AcpDriverConfig): Promise<ProviderAdapter> {
  return defineAcpDriver({
    kind: 'grok',
    displayName: 'Grok',
    bin: 'grok',
    acpArgs: [],
    models: [],
    capabilities: {},
    secretEnv: 'XAI_API_KEY',
  }).create(config, ctx);
}

export function defineAcpDriver(spec: AcpDriverSpec): ProviderDriver<AcpDriverConfig> {
  return {
    kind: spec.kind,
    displayName: spec.displayName,
    decodeConfig(raw: unknown): AcpDriverConfig {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object') throw new Error('config must be an object');
      const r = raw as Record<string, unknown>;
      if (r.command !== undefined && typeof r.command !== 'string') throw new Error('command must be a string');
      if (r.args !== undefined && !Array.isArray(r.args)) throw new Error('args must be an array');
      if (r.args && (r.args as unknown[]).some((a) => typeof a !== 'string')) throw new Error('args must be strings');
      if (r.env !== undefined && (typeof r.env !== 'object' || r.env === null)) throw new Error('env must be an object');
      return { command: r.command as string, args: r.args as string[], env: r.env as Record<string, string> };
    },
    async create(config, ctx) {
      return new AcpAdapter(spec, config, ctx);
    },
  };
}
