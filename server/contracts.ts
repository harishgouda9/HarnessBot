/**
 * The architecture in one file (HB-TRD-001 s2.4).
 *
 * A driver's only job: own one vendor CLI and translate its native protocol into
 * the canonical RuntimeEvent union below. Everything else in the harness — store,
 * SSE, approvals, rooms, routines — consumes RuntimeEvent and nothing vendor-shaped.
 */

export type ThreadId = string;
export type DriverKind = string;

/** Capabilities must be honest: the UI never offers a knob the driver cannot turn. */
export interface DriverCapabilities {
  images: boolean;
  steer: boolean;
  queueing: boolean;
  effortLevels: EffortLevel[];
  sessionModelSwitch: boolean;
  computerMcp: boolean;
  composioMcp: boolean;
  agentsMcp: boolean;
  phoneMcp: boolean;
  browserMcp: boolean;
  customMcp: boolean;
}

export const NO_CAPABILITIES: DriverCapabilities = {
  images: false,
  steer: false,
  queueing: false,
  effortLevels: [],
  sessionModelSwitch: false,
  computerMcp: false,
  composioMcp: false,
  agentsMcp: false,
  phoneMcp: false,
  browserMcp: false,
  customMcp: false,
};

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
}

export interface ModelInfo {
  id: string;
  label: string;
  default?: boolean;
  /** True when the user added this id on top of the driver's built-in list. */
  extra?: boolean;
}

export type ProviderErrorCode =
  | 'missing_cli'
  | 'invalid_credentials'
  | 'inactive_subscription'
  | 'quota_or_region_restriction'
  | 'upstream_outage'
  | 'model_catalog_outage';

/** What the roster shows for one engine instance. `unavailable` is a first-class state. */
export interface InstanceSnapshot {
  instanceId: string;
  driver: DriverKind;
  /** The executable this instance runs. Sign-in hints and "Test" need the binary,
   *  not the driver kind: `cursor-agent` and `opencode-go` are not `cursor`/`opencodeGo`. */
  bin?: string;
  displayName: string;
  accentColor?: string;
  state: 'available' | 'unavailable';
  reason?: string;
  errorCode?: ProviderErrorCode;
  models: ModelInfo[];
  capabilities: DriverCapabilities;
}

// ---------------------------------------------------------------------------
// RuntimeEvent — the only thing that crosses the driver boundary.
// ---------------------------------------------------------------------------

export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: string;
  threadId: ThreadId;
  createdAt: number;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  /** Raw vendor payload, kept for the inspector and for protocol-drift debugging. */
  raw?: unknown;
}

export type ItemKind = 'assistant_text' | 'reasoning' | 'tool';

export interface TokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
  costUsd?: number;
}

export type RequestOutcome = 'allowed-once' | 'rejected' | 'answered' | 'unavailable';
export type RequestSource = 'user' | 'auto' | 'timeout' | 'system' | 'unavailable' | 'peer';

export interface PermissionChoice {
  id: string;
  label: string;
  destructive?: boolean;
}

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: 'session.started'; sessionId?: string; resumeCursor?: unknown }
    | { type: 'session.exited'; code: number | null; signal?: string | null }
    | { type: 'turn.started' }
    | { type: 'turn.retrying'; attempt: number; reason: string }
    | {
        type: 'turn.completed';
        usage?: TokenUsage;
        stopReason?: 'completed' | 'interrupted' | 'denied' | 'error' | 'timeout';
        error?: string;
      }
    | { type: 'item.started'; itemKind: ItemKind; title?: string; toolName?: string }
    | {
        type: 'item.updated';
        itemKind: ItemKind;
        title?: string;
        toolName?: string;
        ok?: boolean;
      }
    | {
        type: 'item.completed';
        itemKind: ItemKind;
        text?: string;
        title?: string;
        toolName?: string;
        ok?: boolean;
        setup?: boolean;
      }
    | { type: 'content.delta'; itemKind: 'assistant_text' | 'reasoning'; delta: string }
    | {
        type: 'request.opened';
        requestKind: 'permission' | 'question';
        toolName?: string;
        summary: string;
        choices?: PermissionChoice[];
        /** Server-issued narrow key for "Always allow", e.g. Bash:git. Never a blanket grant. */
        allowKey?: string;
        /** local-computer grants live in their own memory, never shared with cloud/tool grants. */
        approvalScope?: 'local-computer';
        destructive?: boolean;
      }
    | {
        type: 'request.resolved';
        outcome: RequestOutcome;
        source: RequestSource;
        answer?: string;
      }
    /** Live indicator only. Meanings differ per driver — never sum these. */
    | { type: 'thread.token-usage.updated'; usage: TokenUsage }
    | {
        type: 'runtime.error';
        message: string;
        /** setup:true means "install or configure", not "retry". */
        setup?: boolean;
        errorCode?: ProviderErrorCode;
      }
  );

// ---------------------------------------------------------------------------
// Integration mounts — how hands get attached to a turn.
// Each is a harness-controlled argv/env or URL. Never a user-supplied shell string.
// ---------------------------------------------------------------------------

export interface StdioMount {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HttpMount {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpMount = StdioMount | HttpMount;

export interface TurnIntegrations {
  composio?: McpMount;
  computer?: McpMount;
  localComputer?: McpMount;
  agents?: McpMount;
  phone?: McpMount;
  browser?: McpMount;
  dweb?: McpMount;
  custom?: Record<string, McpMount>;
}

export interface TranscriptLine {
  role: 'user' | 'bot';
  text: string;
  name?: string;
}

export interface SendTurnInput {
  threadId: ThreadId;
  turnId: string;
  text: string;
  system: string;
  model: string;
  effort?: EffortLevel;
  cwd?: string;
  /** Per-task, never shared across tasks (Claude sessions are per project directory). */
  resumeCursor?: unknown;
  /** Replayed when there is no resumeCursor (fresh session, or after a rewind). */
  transcript: TranscriptLine[];
  images?: { mime: string; data: string }[];
  integrations: TurnIntegrations;
  signal: AbortSignal;
}

export interface AnswerRequestInput {
  requestId: string;
  outcome: RequestOutcome;
  source: RequestSource;
  answer?: string;
  choiceId?: string;
}

/** A live engine instance. One per configured instanceId. */
export interface ProviderAdapter {
  readonly instanceId: string;
  readonly driver: DriverKind;
  snapshot(): Promise<InstanceSnapshot>;
  /** Ask the agent which models it can actually run. Optional: most CLIs already list theirs. */
  refreshModels?(): Promise<unknown>;
  sendTurn(input: SendTurnInput): Promise<void>;
  answerRequest(input: AnswerRequestInput): Promise<void>;
  interrupt(threadId: ThreadId): Promise<void>;
  /** Drop a provider session so the next turn replays the visible branch. */
  dropSession(threadId: ThreadId): Promise<void>;
  dispose(): Promise<void>;
}

export interface DriverContext {
  instanceId: string;
  displayName: string;
  accentColor?: string;
  /** Publish canonical events. The bus drops anything not tagged with this driver. */
  emit(event: RuntimeEvent): void;
  /** Resolved secret for this provider only — no cross-provider env inheritance. */
  secret(name: string): string | undefined;
  dataDir: string;
}

export interface ProviderDriver<Config = unknown> {
  readonly kind: DriverKind;
  readonly displayName: string;
  /** Throws synchronously on invalid config (HB-OPS-001 s8). */
  decodeConfig(raw: unknown): Config;
  /** Rejects asynchronously on failure — never throws sync, never hangs. */
  create(config: Config, ctx: DriverContext): Promise<ProviderAdapter>;
}
