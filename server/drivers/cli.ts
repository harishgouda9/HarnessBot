import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AnswerRequestInput,
  DriverCapabilities,
  DriverContext,
  InstanceSnapshot,
  ModelInfo,
  ProviderAdapter,
  ProviderDriver,
  RuntimeEvent,
  SendTurnInput,
  ThreadId,
  TurnIntegrations,
} from '../contracts.ts';
import { NO_CAPABILITIES } from '../contracts.ts';
import { appendNdjsonLimited, threadLogPath } from '../paths.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCli, findCli, killTree, lineReader, spawnCli } from './spawn.ts';

/**
 * One implementation for every provider CLI that speaks line-delimited JSON.
 *
 * The per-vendor differences that actually exist are argv shape, resume flag, and a
 * handful of event names — so they live in a spec object rather than in twelve
 * near-identical driver files. `builtIn.ts` holds the table; adding an engine is one
 * entry there, or one call to `defineCliDriver` for a vendor that needs real parsing.
 */

export interface CliDriverConfig {
  /** Explicit executable path from Settings -> Engines (version managers, wrappers). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BuildArgsInput {
  input: SendTurnInput;
  /** The vendor session id to resume, when this task already has one. */
  resume?: string;
}

export interface CliDriverSpec {
  kind: string;
  displayName: string;
  /** Executable name looked up on PATH when config.command is unset. */
  bin: string;
  models: ModelInfo[];
  capabilities: Partial<DriverCapabilities>;
  /** Env var holding this provider's credential. Nothing else is inherited. */
  secretEnv?: string;
  buildArgs(ctx: BuildArgsInput): string[];
  /** Vendor line -> canonical events. Return [] for lines with no product meaning. */
  parse?(line: unknown, state: TurnState): Partial<RuntimeEvent>[];
  /** How to answer a permission request over stdin. */
  encodeAnswer?(answer: AnswerRequestInput): unknown;
  /**
   * True for CLIs that speak a bidirectional stream protocol: stdin stays open for
   * the whole turn so permission answers can get back in. One-shot CLIs that read a
   * prompt until EOF leave this false, or they hang waiting for input that never ends.
   */
  interactiveStdin?: boolean;
  /**
   * How the user prompt is delivered. Default `stdin`. Grok Build's headless mode
   * ignores stdin and requires `--prompt-file` / `-p` / `--prompt-json` to even
   * enter headless; putting the prompt on argv would leak it in `ps`.
   */
  promptVia?: 'stdin' | 'file';
  versionArgs?: string[];
}

export interface TurnState {
  threadId: ThreadId;
  turnId: string;
  sessionId?: string;
}

const cap = (partial: Partial<DriverCapabilities>): DriverCapabilities => ({ ...NO_CAPABILITIES, ...partial });

/**
 * Canonical stream-JSON parse. Covers the shapes the supported CLIs emit today:
 * Claude Code's `{type:"assistant"|"result"}`, Codex's `{msg:{type}}` envelope, and
 * the plain `{type:"text"|"tool"|"permission"}` form our fake CLIs speak.
 */
export function defaultParse(line: unknown, state: TurnState): Partial<RuntimeEvent>[] {
  if (!line || typeof line !== 'object') return [];
  const raw = line as Record<string, unknown>;
  // Codex wraps everything in {id, msg:{...}}; unwrap before matching.
  const node = (raw.msg && typeof raw.msg === 'object' ? raw.msg : raw) as Record<string, unknown>;
  const type = String(node.type ?? '');
  const out: Partial<RuntimeEvent>[] = [];

  switch (type) {
    case 'system':
    case 'session':
    case 'session_configured': {
      const sessionId = str(node.session_id ?? node.sessionId ?? node.id);
      if (sessionId) state.sessionId = sessionId;
      out.push({ type: 'session.started', sessionId, resumeCursor: sessionId });
      break;
    }
    case 'text':
    case 'agent_message_delta':
    case 'content_delta': {
      const delta = str(node.delta ?? node.text ?? node.content ?? node.data);
      if (delta) out.push({ type: 'content.delta', itemKind: 'assistant_text', delta });
      break;
    }
    case 'thought':
    case 'reasoning':
    case 'agent_reasoning_delta': {
      const delta = str(node.delta ?? node.text ?? node.data);
      if (delta) out.push({ type: 'content.delta', itemKind: 'reasoning', delta });
      break;
    }
    case 'assistant':
    case 'agent_message': {
      const text = extractText(node);
      if (text) out.push({ type: 'item.completed', itemKind: 'assistant_text', text, itemId: str(node.id) });
      for (const tool of extractToolUses(node)) {
        out.push({ type: 'item.started', itemKind: 'tool', toolName: tool.name, title: tool.title, itemId: tool.id });
      }
      break;
    }
    case 'tool':
    case 'tool_use':
    case 'exec_command_begin': {
      out.push({
        type: 'item.started',
        itemKind: 'tool',
        toolName: str(node.name ?? node.tool ?? 'command') ?? 'tool',
        title: str(node.title ?? node.command),
        itemId: str(node.id ?? node.call_id),
      });
      break;
    }
    case 'tool_result':
    case 'exec_command_end': {
      out.push({
        type: 'item.completed',
        itemKind: 'tool',
        toolName: str(node.name ?? node.tool ?? 'command') ?? 'tool',
        title: str(node.title ?? node.output),
        ok: node.is_error === true || node.exit_code ? Number(node.exit_code ?? 1) === 0 : node.ok !== false,
        itemId: str(node.id ?? node.call_id),
      });
      break;
    }
    case 'permission':
    case 'permission_request':
    case 'apply_patch_approval_request':
    case 'exec_approval_request': {
      const toolName = str(node.tool ?? node.name) ?? 'Command';
      out.push({
        type: 'request.opened',
        requestKind: 'permission',
        toolName,
        summary: str(node.summary ?? node.command ?? node.reason) ?? `${toolName} wants to run`,
        requestId: str(node.id ?? node.request_id) ?? randomUUID(),
        destructive: node.destructive === true,
        allowKey: allowKeyFor(toolName, str(node.command ?? node.summary)),
      });
      break;
    }
    case 'question':
    case 'input_request': {
      out.push({
        type: 'request.opened',
        requestKind: 'question',
        summary: str(node.summary ?? node.question ?? node.prompt) ?? 'The agent asked a question',
        requestId: str(node.id ?? node.request_id) ?? randomUUID(),
        choices: Array.isArray(node.choices)
          ? (node.choices as unknown[]).map((c, i) => ({ id: String(i), label: String(c) }))
          : undefined,
      });
      break;
    }
    case 'token_count':
    case 'usage': {
      const usage = readUsage(node.usage ?? node);
      if (usage) out.push({ type: 'thread.token-usage.updated', usage });
      break;
    }
    case 'result':
    case 'task_complete':
    case 'turn.completed':
    case 'end': {
      const sessionId = str(node.sessionId ?? node.session_id);
      if (sessionId && !state.sessionId) {
        state.sessionId = sessionId;
        out.push({ type: 'session.started', sessionId, resumeCursor: sessionId });
      }
      out.push({
        type: 'turn.completed',
        usage: readUsage(node.usage) ?? undefined,
        stopReason: node.is_error === true ? 'error' : 'completed',
        error: str(node.error ?? node.message),
      });
      break;
    }
    case 'error':
    case 'stream_error': {
      out.push({
        type: 'runtime.error',
        message: str(node.message ?? node.error) ?? 'Engine error',
        setup: node.setup === true,
      });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Server-issued narrow grant key. `Bash:git` remembers git, not every shell command;
 * broadening past the tool + first token is what "Always allow" must never do.
 */
/** Body for `--prompt-file`: system + unread transcript + this turn, never on argv. */
function promptFileBody(input: SendTurnInput, resume?: string): string {
  const parts: string[] = [];
  if (input.system) parts.push(input.system);
  if (!resume && input.transcript.length) {
    parts.push(input.transcript.map((line) => `${line.name ?? line.role}: ${line.text}`).join('\n'));
  }
  parts.push(input.text);
  return parts.filter(Boolean).join('\n\n');
}

export function allowKeyFor(toolName: string, detail?: string): string {
  const head = (detail ?? '').trim().split(/\s+/)[0]?.replace(/[^\w.-]/g, '') ?? '';
  return head ? `${toolName}:${head}` : toolName;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function extractText(node: Record<string, unknown>): string | undefined {
  const message = (node.message ?? node) as Record<string, unknown>;
  const content = message.content ?? node.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c): c is { type: string; text: string } => !!c && typeof c === 'object' && (c as any).type === 'text')
      .map((c) => c.text)
      .join('');
    return text || undefined;
  }
  return undefined;
}

/**
 * Label for the work line. A path's last two segments, or the first line of a
 * command. Never the file body: `content` stays off the status line.
 */
export function toolTraceTitle(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const file = typeof rec.file_path === 'string' ? rec.file_path : typeof rec.path === 'string' ? rec.path : '';
  if (file.trim()) {
    const parts = file.split(/[\\/]/).filter(Boolean);
    const label = parts.slice(-2).join('/');
    return label || undefined;
  }
  const command = typeof rec.command === 'string' ? rec.command : '';
  const head = command.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!head) return undefined;
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

function extractToolUses(node: Record<string, unknown>): { id?: string; name: string; title?: string }[] {
  const message = (node.message ?? node) as Record<string, unknown>;
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && (c as any).type === 'tool_use')
    .map((c) => ({ id: str(c.id), name: str(c.name) ?? 'tool', title: toolTraceTitle(c.input) }));
}

function readUsage(v: unknown): { input: number; output: number; cachedInput?: number; costUsd?: number } | null {
  if (!v || typeof v !== 'object') return null;
  const u = v as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.input ?? u.prompt_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.output ?? u.completion_tokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cachedInput: Number(u.cache_read_input_tokens ?? u.cachedInput ?? 0) || undefined,
    costUsd: Number(u.total_cost_usd ?? u.costUsd ?? 0) || undefined,
  };
}

// ---------------------------------------------------------------------------

interface LiveTurn {
  child: ChildProcessWithoutNullStreams;
  state: TurnState;
  /** Requests opened by this turn, cancelled when it ends so no card outlives it. */
  openRequests: Set<string>;
  settled: boolean;
}

function needsDesktopTransport(integrations: TurnIntegrations): boolean {
  return Boolean(integrations.localComputer || integrations.computer || integrations.browser || integrations.phone);
}

class CliAdapter implements ProviderAdapter {
  private turns = new Map<ThreadId, LiveTurn>();
  /** Grok desktop turns speak ACP. Kept only while that turn is in flight. */
  private hands: ProviderAdapter | null = null;
  private cachedSnapshot?: { at: number; value: InstanceSnapshot };

  private readonly spec: CliDriverSpec;
  private readonly config: CliDriverConfig;
  private readonly ctx: DriverContext;

  constructor(spec: CliDriverSpec, config: CliDriverConfig, ctx: DriverContext) {
    this.spec = spec;
    this.config = config;
    this.ctx = ctx;
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

  private childEnv(cwd?: string): Record<string, string | undefined> {
    // Start from the ambient env for PATH/HOME, then inject only this provider's key.
    const env: Record<string, string | undefined> = { ...process.env, ...this.config.env };
    if (this.spec.secretEnv) {
      const value = this.ctx.secret('primary');
      if (value) env[this.spec.secretEnv] = value;
    }
    if (cwd) env.PWD = cwd;
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
      models: this.spec.models,
      capabilities: cap(this.spec.capabilities),
    };
    const value: InstanceSnapshot = command
      ? { ...base, state: 'available' }
      : {
          ...base,
          state: 'unavailable',
          // The reason must name the next action, not just the failure.
          reason: `${this.spec.displayName} CLI not found - install it, or set an absolute path in Settings -> Engines`,
          errorCode: 'missing_cli',
          models: [],
          capabilities: cap({}),
        };
    this.cachedSnapshot = { at: now, value };
    return value;
  }

  private emit(state: TurnState, partial: Partial<RuntimeEvent>, raw?: unknown): void {
    this.ctx.emit({
      eventId: randomUUID(),
      provider: this.spec.kind,
      providerInstanceId: this.ctx.instanceId,
      threadId: state.threadId,
      createdAt: Date.now(),
      turnId: state.turnId,
      raw,
      ...partial,
    } as RuntimeEvent);
  }

  private async sendDesktopTurn(input: SendTurnInput): Promise<void> {
    const command = this.resolveCommand();
    const state: TurnState = { threadId: input.threadId, turnId: input.turnId };
    if (!command) {
      this.emit(state, {
        type: 'runtime.error',
        message: `${this.spec.displayName} CLI not found`,
        setup: true,
        errorCode: 'missing_cli',
      });
      this.emit(state, { type: 'turn.completed', stopReason: 'error' });
      return;
    }
    const { createHandsSession } = await import('./acp.ts');
    const { grokHandsArgs } = await import('./builtIn.ts');
    const hands = await createHandsSession(this.ctx, {
      command,
      args: grokHandsArgs(input.model, input.effort),
      env: this.config.env,
    });
    this.hands = hands;
    try {
      await hands.sendTurn({ ...input, resumeCursor: undefined });
    } finally {
      if (this.hands === hands) this.hands = null;
      await hands.dispose();
    }
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    if (this.spec.kind === 'grok' && needsDesktopTransport(input.integrations)) {
      await this.sendDesktopTurn(input);
      return;
    }
    const command = this.resolveCommand();
    const state: TurnState = { threadId: input.threadId, turnId: input.turnId };

    if (!command) {
      // Setup error, not a transient failure: offering "Retry" here would be a lie.
      this.emit(state, {
        type: 'runtime.error',
        message: `${this.spec.displayName} CLI not found`,
        setup: true,
        errorCode: 'missing_cli',
      });
      this.emit(state, { type: 'turn.completed', stopReason: 'error' });
      return;
    }

    const resume = typeof input.resumeCursor === 'string' ? input.resumeCursor : undefined;
    if (resume) state.sessionId = resume;

    let promptFile: string | undefined;
    const args = [...(this.config.args ?? []), ...this.spec.buildArgs({ input, resume })];
    if (this.spec.promptVia === 'file') {
      promptFile = path.join(os.tmpdir(), `hb-prompt-${input.turnId}.txt`);
      try {
        fs.writeFileSync(promptFile, promptFileBody(input, resume), 'utf8');
      } catch (err) {
        this.emit(state, { type: 'runtime.error', message: `Could not write prompt file: ${String(err)}` });
        this.emit(state, { type: 'turn.completed', stopReason: 'error' });
        return;
      }
      args.push('--prompt-file', promptFile);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCli(command, args, { cwd: input.cwd, env: this.childEnv(input.cwd) });
    } catch (err) {
      if (promptFile) {
        try {
          fs.unlinkSync(promptFile);
        } catch {
          /* ignore */
        }
      }
      this.emit(state, { type: 'runtime.error', message: `Could not start ${this.spec.bin}: ${String(err)}` });
      this.emit(state, { type: 'turn.completed', stopReason: 'error' });
      return;
    }

    const live: LiveTurn = { child, state, openRequests: new Set(), settled: false };
    this.turns.set(input.threadId, live);
    this.emit(state, { type: 'turn.started' });

    const parse = this.spec.parse ?? defaultParse;
    const nativeLog = threadLogPath('native', input.threadId);

    child.stdout.on(
      'data',
      lineReader((line) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return; // Vendors print banners and progress noise on stdout; ignore non-JSON.
        }
        if (nativeLog) appendNdjsonLimited(nativeLog, { at: Date.now(), dir: 'in', source: this.spec.kind, msg: json });
        for (const partial of parse(json, state)) {
          if (partial.type === 'request.opened' && partial.requestId) live.openRequests.add(partial.requestId);
          if (partial.type === 'request.resolved' && partial.requestId) live.openRequests.delete(partial.requestId);
          this.emit(state, partial, json);
        }
      }),
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    const settle = (partial: Partial<RuntimeEvent>): void => {
      if (live.settled) return;
      live.settled = true;
      // An unanswered card must never outlive its turn: fail closed, never act.
      for (const requestId of live.openRequests) {
        this.emit(state, { type: 'request.resolved', outcome: 'unavailable', source: 'system', requestId });
      }
      live.openRequests.clear();
      this.emit(state, partial);
      try {
        live.child.stdin.end();
      } catch {
        /* already closed */
      }
      this.turns.delete(input.threadId);
      if (promptFile) {
        try {
          fs.unlinkSync(promptFile);
        } catch {
          /* leftover temp file is not worth failing a turn over */
        }
      }
    };

    const onAbort = (): void => {
      killTree(child);
      settle({ type: 'turn.completed', stopReason: 'interrupted' });
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    await new Promise<void>((resolve) => {
      child.on('error', (err) => {
        this.emit(state, { type: 'runtime.error', message: err.message, setup: true });
        settle({ type: 'turn.completed', stopReason: 'error' });
        resolve();
      });
      child.on('close', (code, signal) => {
        input.signal.removeEventListener('abort', onAbort);
        this.emit(state, { type: 'session.exited', code, signal });
        if (code !== 0 && !live.settled) {
          const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
          // Word-bounded, and no bare "log in" / "sign in": argparse dumps its whole
          // subcommand list on a bad flag, and a `login` in that list was enough to
          // mark the bot dead with "needs setup". A missed auth error only costs a
          // Retry button; a false one strands the user.
          const auth = /unauthor|forbidden|\b401\b|\b403\b|not (?:authenticated|logged in)|credential|api[ _-]?key/i.test(
            detail,
          );
          this.emit(state, {
            type: 'runtime.error',
            message: detail || `${this.spec.bin} exited with code ${code}`,
            // Auth failures are setup errors. Retrying them just burns another turn.
            setup: auth,
            errorCode: auth ? 'invalid_credentials' : undefined,
          });
        }
        settle({ type: 'turn.completed', stopReason: code === 0 ? 'completed' : 'error' });
        resolve();
      });

      // Prompt goes on stdin, never on argv: `ps` must not leak what the user typed.
      // File-prompt CLIs (Grok Build) ignore stdin; the file is already on argv as a path.
      if (this.spec.promptVia !== 'file') {
        const payload = this.spec.encodeAnswer
          ? JSON.stringify({ type: 'prompt', text: input.text, system: input.system })
          : input.text;
        try {
          child.stdin.write(`${payload}\n`);
          // Interactive CLIs keep stdin open until the turn settles; without it a
          // permission answer would have nowhere to go and every card would time out.
          if (!this.spec.interactiveStdin) child.stdin.end();
        } catch {
          /* the close handler reports it */
        }
      } else {
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
      }
    });
  }

  async answerRequest(answer: AnswerRequestInput): Promise<void> {
    if (this.hands) {
      await this.hands.answerRequest(answer);
      return;
    }
    for (const live of this.turns.values()) {
      if (!live.openRequests.has(answer.requestId)) continue;
      live.openRequests.delete(answer.requestId);
      const encoded = this.spec.encodeAnswer?.(answer) ?? {
        type: 'permission_response',
        id: answer.requestId,
        approved: answer.outcome === 'allowed-once',
        answer: answer.answer,
      };
      try {
        live.child.stdin.write(`${JSON.stringify(encoded)}\n`);
      } catch {
        // Child already gone; the turn's close handler resolves the card as unavailable.
      }
      this.emit(live.state, {
        type: 'request.resolved',
        requestId: answer.requestId,
        outcome: answer.outcome,
        source: answer.source,
        answer: answer.answer,
      });
      return;
    }
  }

  async interrupt(threadId: ThreadId): Promise<void> {
    if (this.hands) {
      await this.hands.interrupt(threadId);
      return;
    }
    const live = this.turns.get(threadId);
    if (!live) return;
    killTree(live.child);
  }

  async dropSession(threadId: ThreadId): Promise<void> {
    if (this.hands) {
      const hands = this.hands;
      this.hands = null;
      await hands.dropSession(threadId);
      await hands.dispose();
    }
    const live = this.turns.get(threadId);
    if (live) killTree(live.child);
    this.turns.delete(threadId);
  }

  async dispose(): Promise<void> {
    if (this.hands) {
      const hands = this.hands;
      this.hands = null;
      await hands.dispose();
    }
    for (const live of this.turns.values()) killTree(live.child);
    this.turns.clear();
  }
}

export function defineCliDriver(spec: CliDriverSpec): ProviderDriver<CliDriverConfig> {
  return {
    kind: spec.kind,
    displayName: spec.displayName,
    decodeConfig(raw: unknown): CliDriverConfig {
      // Throws synchronously on bad config; create() is the async failure path.
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
      return new CliAdapter(spec, config, ctx);
    },
  };
}

/** Probe a CLI for a version string. Used by Settings -> Engines "Test". */
export async function probeCli(command: string, args = ['--version']): Promise<string> {
  const resolved = findCli(command);
  if (!resolved) throw new Error(`not found: ${command}`);
  const { stdout, stderr } = await execCli(resolved, args, { env: process.env });
  return (stdout || stderr).trim().split('\n')[0] ?? '';
}
