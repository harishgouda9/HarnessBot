/** Records shared by the harness and the app (HB-SCHEMA-001 s4-s6). */

export type ThreadId = string;

export type HarnessbotColor =
  | 'green'
  | 'blue'
  | 'red'
  | 'orange'
  | 'purple'
  | 'cyan'
  | 'pink'
  | 'yellow'
  | 'teal'
  | 'coral';

export const BOT_COLORS: HarnessbotColor[] = [
  'green',
  'blue',
  'red',
  'orange',
  'purple',
  'cyan',
  'pink',
  'yellow',
  'teal',
  'coral',
];

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
  /**
   * Follow whatever engine is connected rather than staying on this one. `instanceId`
   * and `model` still hold the last resolved choice, so the UI always has something
   * concrete to show — auto only decides what happens when that choice stops working.
   */
  auto?: boolean;
}

/** Extra models the user added on top of a provider's built-in catalogue. */
export interface ExtraModel {
  id: string;
  label?: string;
}

export type ComputerPlacement = 'cloud' | 'vm' | 'local' | 'off';
export type CloudBackend = 'box' | 'vps';
export type AutoReview = 'off' | 'shadow' | 'enforce';

export type BotActivity = 'idle' | 'working' | 'waiting-on-you' | 'no-signal' | 'dead';

export interface TaskUsage {
  input: number;
  output: number;
  cachedInput?: number;
  costUsd?: number;
  turns: number;
  /** Estimated tokens Lean kept out of the prompt, banked per completed turn. */
  leanSaved?: number;
}

export interface TaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  /** THIS task only. Sharing cursors across tasks would undo task isolation. */
  resumeCursors: Record<string, unknown>;
  lastInstanceId?: string;
  usage?: TaskUsage;
  /** Pinned on first turn. null = home; absent = not pinned yet. */
  cwd?: string | null;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  /** Process guidance only — never executable code, credentials, or grants. */
  instructions: string;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release?: string;
  requiredApps: { slug: string; label: string; reason: string; optional?: boolean }[];
  skills?: string[];
  mcpServers?: string[];
}

export interface BotRecord {
  id: string;
  /** ACTIVE task thread. All turns read this. */
  threadId: ThreadId;
  tasks?: TaskRecord[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: HarnessbotColor;
  mascotExpression?: string | null;
  avatarUrl?: string;
  avatarCrop?: 'mascot' | 'circle' | 'rounded' | 'square';
  unread: boolean;
  modelSelection: ModelSelection;
  /** Legacy bot-level cursors. Tasks have their own. */
  resumeCursors: Record<string, unknown>;
  computer?: ComputerPlacement;
  /**
   * Lean prompt mode. `undefined` follows the workspace default; `true`/`false` pin
   * this bot on or off. Lean cuts transcript, skills and playbooks so each turn
   * costs less, and can route a short message to a smaller model on the same provider.
   */
  lean?: boolean;
  cloudBackend?: CloudBackend;
  autoStartVps?: boolean;
  cwd?: string;
  autoApprove?: boolean;
  autoReview?: AutoReview;
  /** Narrow keys from "Always allow" — e.g. Bash:git. Never a blanket grant. */
  alwaysAllow?: string[];
  /** Separate memory from alwaysAllow so a cloud grant can never authorise the real seat. */
  alwaysAllowLocalComputer?: string[];
  speakReplies?: boolean;
  voice?: string;
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  section?: string;
  pinnedMessageId?: string;
  chiefOfStaff?: boolean;
  reportsTo?: string;
  orgPos?: { x: number; y: number };
  reviewRounds?: number;
  approvePeerComms?: boolean;
  composio?: boolean;
  browser?: boolean;
  peerTools?: boolean;
  customMcp?: boolean;
  browserProfile?: string;
  playbooks?: InstalledPlaybook[];
  installedPackage?: InstalledPackageMetadata;
  busy?: boolean;
  activity?: BotActivity;
  createdAt: number;
}

export type DefaultResponder = 'member' | 'everyone' | 'mentions';
export type ChannelMode = 'chat' | 'goal';

export interface GroupTaskRecord {
  threadId: ThreadId;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

export interface GroupRecord {
  id: string;
  threadId: ThreadId;
  tasks?: GroupTaskRecord[];
  name: string;
  memberIds: string[];
  defaultResponder: DefaultResponder;
  /** Injected into every member turn. */
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** Auto-created bot-to-bot channel. Always routes mentions-only. */
  dm?: boolean;
  busyBotId?: string | null;
  cwd?: string;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
  section?: string;
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
}

export type MessageKind =
  | 'text'
  | 'options'
  | 'activity'
  | 'screen'
  | 'connector'
  | 'secret'
  | 'routine.run'
  | 'goal.run'
  | 'comm';

export interface OptionCardChoice {
  id: string;
  label: string;
  destructive?: boolean;
}

export interface OptionCardData {
  title: string;
  subtitle?: string;
  options: OptionCardChoice[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  /** Destructive command held even under autoApprove; carries the reason. */
  held?: string;
  allowKey?: string;
  approvalScope?: 'local-computer';
  routineRequest?: RoutineRequest;
  skillRequest?: SkillRequest;
}

export interface RoutineRequest {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  durationMinutes: number;
  applied?: boolean;
}

export interface SkillRequest {
  name: string;
  summary: string;
  /** Binds the card to exact SKILL.md bytes. Mismatch makes the card deny-only. */
  sha256: string;
  staged: boolean;
}

export type ConnectorStatus = 'required' | 'authorizing' | 'connected' | 'failed';

export interface ConnectorCardData {
  slug: string;
  label: string;
  status: ConnectorStatus;
  resumeKey: string;
  reason?: string;
  authorizeUrl?: string;
}

export type CredentialTargetId =
  | 'xaiApiKey'
  | 'boxToken'
  | 'opencodeGoApiKey'
  | 'ttsKey'
  | 'openaiImageApiKey';

export const CREDENTIAL_TARGETS: CredentialTargetId[] = [
  'xaiApiKey',
  'boxToken',
  'opencodeGoApiKey',
  'ttsKey',
  'openaiImageApiKey',
];

export interface SecretRequestCardData {
  target: CredentialTargetId;
  label: string;
  reason: string;
  provided?: boolean;
}

export interface RoutineRunCardData {
  runId: string;
  routineId: string;
  routineName: string;
  status: RoutineRunStatus;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
}

export type GoalRunStatus =
  | 'working'
  | 'completed'
  | 'needs-input'
  | 'blocked'
  | 'limit-reached'
  | 'stopped'
  | 'failed';

export interface GoalRunCardData {
  goalId: string;
  goal: string;
  coordinatorId: string;
  status: GoalRunStatus;
  turns: number;
  maxTurns: number;
  summary?: string;
}

export interface Message {
  id: string;
  role: 'bot' | 'user';
  kind: MessageKind;
  /** Redacted before persist when role === 'bot'. */
  text?: string;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  secret?: SecretRequestCardData;
  routineRun?: RoutineRunCardData;
  goalRun?: GoalRunCardData;
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  steered?: boolean;
  queued?: boolean;
  queueId?: string;
  png?: string;
  mime?: string;
  at: number;
  /** Branching. An edit shares the original's parentId, forking the path. */
  parentId?: string | null;
  replyToId?: string;
  sendId?: string;
  channelMode?: ChannelMode;
  from?: { botId: string; name: string; color: HarnessbotColor };
  reactions?: { emoji: string; by: string }[];
  comm?: { peerBotId: string; peerName: string; dmGroupId: string; kind: 'ask' | 'delegate' };
  attachments?: { id: string; name: string; mime: string; url: string }[];
}

export type RoutineRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'missed';

export type RoutineSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string; weekdays: number[] };

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: 'harnessbot' | 'cloud';
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  attachments?: { name: string; mime: string; data: string }[];
  sourceThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  /** Snapshotted: editing a routine must not rewrite history. */
  routineName: string;
  prompt: string;
  durationMinutes: number;
  botId: string;
  runOn: 'harnessbot' | 'cloud';
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: 'schedule' | 'manual' | 'webhook';
  webhookId?: string;
  deliveryId?: string;
  sourceThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
}

export interface WebhookRecord {
  id: string;
  name: string;
  routineId: string;
  /** Only the hash is stored. The secret is shown once on create/rotate. */
  secretHash: string;
  createdAt: number;
  lastDeliveryAt?: number;
}

export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'correction'
  | 'entity'
  | 'decision'
  | 'task_outcome'
  | 'reference';

export type MemorySource = 'user' | 'bot_verified' | 'bot_inferred' | 'imported';

/**
 * Memory scopes, narrowest first.
 *
 * `workspace` is the account-wide tier: one set of facts every bot reads, which is
 * what makes "tell it once" true across the roster instead of once per bot. `section`
 * is a department, `bot` is one teammate's own.
 */
export type MemoryScope = 'bot' | 'section' | 'workspace';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  botId?: string;
  sectionId?: string;
  kind: MemoryKind;
  text: string;
  entities: string[];
  topics: string[];
  confidence: number;
  source: MemorySource;
  provenance: { threadId?: string; turnId?: string; createdBy: string; importedFrom?: string };
  createdAt: string;
  updatedAt: string;
}

export interface SkillRecord {
  name: string;
  summary: string;
  sha256: string;
  body: string;
  installedAt: number;
  staged?: boolean;
  botId?: string;
  /** Ships with the app. Not something the user recorded. */
  builtin?: boolean;
}

export interface BrowserProfile {
  id: string;
  name: string;
}

export interface McpServerRecord {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface DecisionLogEntry {
  at: number;
  botId: string;
  threadId: string;
  requestId: string;
  tool?: string;
  summary: string;
  outcome: string;
  source: string;
  allowKey?: string;
  approvalScope?: string;
}
