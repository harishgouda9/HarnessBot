import { EventEmitter } from 'node:events';
import type {
  BotRecord,
  GroupRecord,
  GroupTaskRecord,
  HarnessbotColor,
  Message,
  TaskRecord,
  TaskUsage,
  ThreadId,
} from '../shared/types.ts';
import { BOT_COLORS, isAvatarShape } from '../shared/types.ts';
import { dataPath, newId, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { redactDeep, redactSecretsInText } from './redact.ts';
import * as db from './message-db.ts';

/**
 * The store is the single persistence -> SSE joint (HB-TRD-001 consideration 1).
 * Every mutation persists AND emits exactly one StoreChange. There is no second
 * write path: the server maps StoreChange to SSE in one place, so "persisted but
 * not emitted" and "emitted but not persisted" are both impossible by construction.
 */

export type StoreChange =
  | { type: 'message'; threadId: ThreadId; message: Message }
  | { type: 'message.patch'; threadId: ThreadId; message: Message }
  | { type: 'thread'; threadId: ThreadId; activeLeafId: string | null }
  | { type: 'thread.deleted'; threadId: ThreadId }
  | { type: 'bot'; botId: string }
  | { type: 'bot.deleted'; botId: string }
  | { type: 'group'; groupId: string }
  | { type: 'group.deleted'; groupId: string };

const BOTS_FILE = dataPath('bots.json');
const GROUPS_FILE = dataPath('groups.json');

export const MAX_WORKSPACE_BOTS = 100;
export const MAX_REVIEW_ROUNDS = 3;

class Store extends EventEmitter {
  private bots: BotRecord[] = [];
  private groups: GroupRecord[] = [];

  constructor() {
    super();
    this.setMaxListeners(0);
    this.bots = readJsonSafe<BotRecord[]>(BOTS_FILE, []).map(loadBot);
    this.groups = readJsonSafe<GroupRecord[]>(GROUPS_FILE, []).map(loadGroup);
    repairOrg(this.bots);
    if (stripLegacyHelpers(this.bots)) this.persistBots();
  }

  private change(c: StoreChange): void {
    this.emit('change', c);
  }

  // -- persistence -----------------------------------------------------------

  private persistBots(): void {
    writeJsonAtomic(BOTS_FILE, this.bots);
  }

  private persistGroups(): void {
    writeJsonAtomic(GROUPS_FILE, this.groups);
  }

  // -- bots ------------------------------------------------------------------

  listBots(): BotRecord[] {
    return this.bots;
  }

  getBot(id: string): BotRecord | undefined {
    return this.bots.find((b) => b.id === id);
  }

  botByName(name: string): BotRecord | undefined {
    const lower = name.toLowerCase();
    return this.bots.find((b) => !b.hidden && b.name.toLowerCase() === lower);
  }

  createBot(input: Partial<BotRecord> & { name: string; modelSelection: BotRecord['modelSelection'] }): BotRecord {
    if (this.bots.length >= MAX_WORKSPACE_BOTS) throw new Error(`workspace is full (${MAX_WORKSPACE_BOTS} bots)`);
    const id = input.id ?? newId('bot');
    const threadId = input.threadId ?? newId('t');
    const bot: BotRecord = {
      id,
      threadId,
      tasks: [{ threadId, title: 'New task', createdAt: Date.now(), resumeCursors: {} }],
      name: input.name.slice(0, 100),
      title: (input.title ?? '').slice(0, 200),
      description: (input.description ?? '').slice(0, 4000),
      notifications: input.notifications ?? true,
      color: input.color ?? pickColor(this.bots),
      mascotExpression: input.mascotExpression ?? null,
      avatarUrl: input.avatarUrl,
      avatarShape: isAvatarShape(input.avatarShape) ? input.avatarShape : undefined,
      avatarCrop: input.avatarCrop,
      unread: false,
      modelSelection: input.modelSelection,
      resumeCursors: {},
      computer: input.computer,
      cwd: input.cwd,
      section: input.section,
      chiefOfStaff: false,
      activity: 'idle',
      createdAt: Date.now(),
      ...pick(input, [
        'autoApprove',
        'autoReview',
        'speakReplies',
        'voice',
        'composio',
        'browser',
        'peerTools',
        'customMcp',
        'browserProfile',
        'playbooks',
        'installedPackage',
        'reportsTo',
        'approvePeerComms',
        'reviewRounds',
        'lean',
        'cloudBackend',
        'autoStartVps',
        'spendCapUsd',
        'spendConfirmedUsd',
      ]),
    };
    if (input.chiefOfStaff) {
      this.bots.push(bot);
      this.setChiefOfStaff(bot.id, true);
      return bot;
    }
    this.bots.push(bot);
    this.persistBots();
    this.change({ type: 'bot', botId: bot.id });
    return bot;
  }

  updateBot(id: string, patch: Partial<BotRecord>): BotRecord | undefined {
    const bot = this.getBot(id);
    if (!bot) return undefined;
    Object.assign(bot, patch);
    if (patch.reviewRounds !== undefined) {
      bot.reviewRounds = Math.min(MAX_REVIEW_ROUNDS, Math.max(0, patch.reviewRounds ?? 0));
    }
    if (patch.reportsTo !== undefined) repairOrg(this.bots);
    this.persistBots();
    this.change({ type: 'bot', botId: id });
    return bot;
  }

  /** At most one Chief of Staff per section, including the unsectioned area. */
  setChiefOfStaff(id: string, value: boolean): void {
    const bot = this.getBot(id);
    if (!bot) return;
    if (value) {
      const section = bot.section ?? '';
      for (const other of this.bots) {
        if (other.id !== id && (other.section ?? '') === section && other.chiefOfStaff) {
          other.chiefOfStaff = false;
          this.change({ type: 'bot', botId: other.id });
        }
      }
    }
    bot.chiefOfStaff = value;
    this.persistBots();
    this.change({ type: 'bot', botId: id });
  }

  chiefOf(section: string | undefined): BotRecord | undefined {
    return this.bots.find((b) => b.chiefOfStaff && (b.section ?? '') === (section ?? ''));
  }

  deleteBot(id: string): void {
    const bot = this.getBot(id);
    if (!bot) return;
    for (const task of bot.tasks ?? []) db.deleteThread(task.threadId);
    db.deleteThread(bot.threadId);
    this.bots = this.bots.filter((b) => b.id !== id);
    for (const other of this.bots) {
      if (other.reportsTo === id) {
        delete other.reportsTo;
        this.change({ type: 'bot', botId: other.id });
      }
    }
    for (const group of this.groups) {
      if (group.memberIds.includes(id)) {
        group.memberIds = group.memberIds.filter((m) => m !== id);
        this.change({ type: 'group', groupId: group.id });
      }
    }
    this.persistBots();
    this.persistGroups();
    this.change({ type: 'bot.deleted', botId: id });
  }

  /** Transient; written through setActivity so every reader sees the same value. */
  setActivity(id: string, activity: BotRecord['activity']): void {
    const bot = this.getBot(id);
    if (!bot || bot.activity === activity) return;
    bot.activity = activity;
    bot.busy = activity === 'working' || activity === 'waiting-on-you' || activity === 'no-signal';
    this.change({ type: 'bot', botId: id });
  }

  // -- tasks -----------------------------------------------------------------

  tasksOf(bot: BotRecord): TaskRecord[] {
    if (!bot.tasks || bot.tasks.length === 0) {
      bot.tasks = [{ threadId: bot.threadId, title: 'New task', createdAt: bot.createdAt, resumeCursors: {} }];
    }
    return bot.tasks;
  }

  getTask(bot: BotRecord, threadId: ThreadId): TaskRecord | undefined {
    return this.tasksOf(bot).find((t) => t.threadId === threadId);
  }

  createTask(botId: string, title = 'New task'): TaskRecord | undefined {
    const bot = this.getBot(botId);
    if (!bot) return undefined;
    const task: TaskRecord = {
      threadId: newId('t'),
      title,
      createdAt: Date.now(),
      resumeCursors: {},
      // A new task inherits the bot's folder but is not pinned until its first turn.
      cwd: bot.cwd === undefined ? undefined : bot.cwd,
    };
    this.tasksOf(bot).unshift(task);
    bot.threadId = task.threadId;
    this.persistBots();
    this.change({ type: 'bot', botId });
    return task;
  }

  deleteTask(botId: string, threadId: ThreadId): void {
    const bot = this.getBot(botId);
    if (!bot) return;
    const tasks = this.tasksOf(bot).filter((t) => t.threadId !== threadId);
    if (tasks.length === 0) return;
    bot.tasks = tasks;
    db.deleteThread(threadId);
    if (bot.threadId === threadId) bot.threadId = tasks[0]!.threadId;
    this.persistBots();
    this.change({ type: 'thread.deleted', threadId });
    this.change({ type: 'bot', botId });
  }

  updateTask(botId: string, threadId: ThreadId, patch: Partial<TaskRecord>): void {
    const bot = this.getBot(botId);
    if (!bot) return;
    const task = this.getTask(bot, threadId);
    if (!task) return;
    Object.assign(task, patch);
    this.persistBots();
    this.change({ type: 'bot', botId });
  }

  /** Bank usage from turn.completed only. token-usage.updated means different things per driver. */
  addUsage(botId: string, threadId: ThreadId, usage: Partial<TaskUsage>): void {
    const bot = this.getBot(botId);
    if (!bot) return;
    const task = this.getTask(bot, threadId);
    if (!task) return;
    const current = task.usage ?? { input: 0, output: 0, turns: 0 };
    task.usage = {
      input: current.input + (usage.input ?? 0),
      output: current.output + (usage.output ?? 0),
      cachedInput: (current.cachedInput ?? 0) + (usage.cachedInput ?? 0),
      costUsd: (current.costUsd ?? 0) + (usage.costUsd ?? 0),
      turns: current.turns + (usage.turns ?? 1),
      leanSaved: (current.leanSaved ?? 0) + (usage.leanSaved ?? 0),
    };
    this.persistBots();
    this.change({ type: 'bot', botId });
  }

  /** Cursors are per task. Bot-level cursors exist only to read legacy data. */
  setResumeCursor(botId: string, threadId: ThreadId, instanceId: string, cursor: unknown): void {
    const bot = this.getBot(botId);
    if (!bot) return;
    const task = this.getTask(bot, threadId);
    if (!task) return;
    task.resumeCursors[instanceId] = cursor;
    task.lastInstanceId = instanceId;
    this.persistBots();
  }

  getResumeCursor(botId: string, threadId: ThreadId, instanceId: string): unknown {
    const bot = this.getBot(botId);
    if (!bot || bot.rewound) return undefined;
    return this.getTask(bot, threadId)?.resumeCursors[instanceId];
  }

  /** After a rewind the abandoned branch must not be resumed: drop every cursor. */
  dropCursors(botId: string, threadId: ThreadId): void {
    const bot = this.getBot(botId);
    if (!bot) return;
    const task = this.getTask(bot, threadId);
    if (task) task.resumeCursors = {};
    bot.resumeCursors = {};
    this.persistBots();
  }

  // -- groups ----------------------------------------------------------------

  listGroups(): GroupRecord[] {
    return this.groups;
  }

  getGroup(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  createGroup(input: Partial<GroupRecord> & { name: string; memberIds: string[] }): GroupRecord {
    const id = input.id ?? newId('grp');
    const threadId = input.threadId ?? newId('t');
    const group: GroupRecord = {
      id,
      threadId,
      tasks: [{ threadId, title: 'New task', createdAt: Date.now() }],
      name: input.name,
      memberIds: input.memberIds,
      // A bot-to-bot DM is mentions-only: nobody should answer by accident.
      defaultResponder: input.dm ? 'mentions' : (input.defaultResponder ?? 'member'),
      bulletin: input.bulletin ?? '',
      unread: false,
      createdAt: Date.now(),
      dm: input.dm,
      section: input.section,
      cwd: input.cwd,
    };
    this.groups.push(group);
    this.persistGroups();
    this.change({ type: 'group', groupId: id });
    return group;
  }

  updateGroup(id: string, patch: Partial<GroupRecord>): GroupRecord | undefined {
    const group = this.getGroup(id);
    if (!group) return undefined;
    Object.assign(group, patch);
    this.persistGroups();
    this.change({ type: 'group', groupId: id });
    return group;
  }

  deleteGroup(id: string): void {
    const group = this.getGroup(id);
    if (!group) return;
    for (const task of group.tasks ?? []) db.deleteThread(task.threadId);
    db.deleteThread(group.threadId);
    this.groups = this.groups.filter((g) => g.id !== id);
    this.persistGroups();
    this.change({ type: 'group.deleted', groupId: id });
  }

  groupTasks(group: GroupRecord): GroupTaskRecord[] {
    if (!group.tasks || group.tasks.length === 0) {
      group.tasks = [{ threadId: group.threadId, title: 'New task', createdAt: group.createdAt }];
    }
    return group.tasks;
  }

  createGroupTask(groupId: string, title = 'New task'): GroupTaskRecord | undefined {
    const group = this.getGroup(groupId);
    if (!group) return undefined;
    const task: GroupTaskRecord = { threadId: newId('t'), title, createdAt: Date.now() };
    this.groupTasks(group).unshift(task);
    group.threadId = task.threadId;
    this.persistGroups();
    this.change({ type: 'group', groupId });
    return task;
  }

  /** Find the DM channel two bots share, creating it on first use. */
  dmChannel(a: BotRecord, b: BotRecord): GroupRecord {
    const existing = this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a.id) && g.memberIds.includes(b.id),
    );
    if (existing) return existing;
    return this.createGroup({ name: `${a.name} & ${b.name}`, memberIds: [a.id, b.id], dm: true });
  }

  // -- messages --------------------------------------------------------------

  listMessages(threadId: ThreadId, limit?: number): Message[] {
    return db.listMessages(threadId, limit);
  }

  getMessage(threadId: ThreadId, id: string): Message | undefined {
    return db.getMessage(threadId, id);
  }

  countMessages(threadId: ThreadId): number {
    return db.countMessages(threadId);
  }

  /**
   * The one place a message enters the system. Bot-authored fields are redacted here,
   * so no caller can forget. User text is stored as typed.
   */
  appendMessage(threadId: ThreadId, input: Omit<Message, 'id' | 'at'> & Partial<Pick<Message, 'id' | 'at'>>): Message {
    const parentId = input.parentId === undefined ? db.getActiveLeaf(threadId) : input.parentId;
    const raw: Message = {
      id: input.id ?? newId('m'),
      at: input.at ?? Date.now(),
      ...input,
      parentId,
    };
    const message = raw.role === 'bot' ? redactMessage(raw) : raw;
    db.insertMessage(threadId, message);
    db.setActiveLeaf(threadId, message.id);
    this.change({ type: 'message', threadId, message });
    this.change({ type: 'thread', threadId, activeLeafId: message.id });
    return message;
  }

  patchMessage(threadId: ThreadId, id: string, patch: Partial<Message>): Message | undefined {
    const existing = db.getMessage(threadId, id);
    if (!existing) return undefined;
    const merged = { ...existing, ...patch } as Message;
    const message = merged.role === 'bot' ? redactMessage(merged) : merged;
    db.patchMessage(threadId, message);
    this.change({ type: 'message.patch', threadId, message });
    return message;
  }

  /** An idempotent send: the same sendId never produces two user messages. */
  findBySendId(threadId: ThreadId, sendId: string): Message | undefined {
    return db.listMessages(threadId).find((m) => m.sendId === sendId);
  }

  setActiveLeaf(threadId: ThreadId, leafId: string | null): void {
    db.setActiveLeaf(threadId, leafId);
    this.change({ type: 'thread', threadId, activeLeafId: leafId });
  }

  getActiveLeaf(threadId: ThreadId): string | null {
    return db.getActiveLeaf(threadId);
  }

  /**
   * The visible conversation: walk parentId from the active leaf back to a root.
   * Edited messages share a parentId, so an old branch stays on disk but off-screen.
   */
  visiblePath(threadId: ThreadId): Message[] {
    const all = db.listMessages(threadId);
    if (all.length === 0) return [];
    const byId = new Map(all.map((m) => [m.id, m]));
    const leafId = db.getActiveLeaf(threadId) ?? all[all.length - 1]!.id;
    const path: Message[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined = leafId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const m = byId.get(cursor);
      if (!m) break;
      path.push(m);
      cursor = m.parentId;
    }
    return path.reverse();
  }

  search(query: string, limit = 100) {
    // Legacy transcripts import on first open. A search that never opened the
    // thread would otherwise miss everything still sitting in messages-*.json.
    const threads = new Set<ThreadId>();
    for (const bot of this.bots) {
      threads.add(bot.threadId);
      for (const task of bot.tasks ?? []) threads.add(task.threadId);
    }
    for (const group of this.groups) {
      threads.add(group.threadId);
      for (const task of group.tasks ?? []) threads.add(task.threadId);
    }
    for (const threadId of threads) db.ensureHydrated(threadId);
    return db.searchMessages(query, limit);
  }
}

// -- helpers -----------------------------------------------------------------

function redactMessage(m: Message): Message {
  return {
    ...m,
    text: redactSecretsInText(m.text),
    card: m.card ? redactDeep(m.card) : undefined,
    tool: m.tool ? redactDeep(m.tool) : undefined,
    routineRun: m.routineRun ? redactDeep(m.routineRun) : undefined,
    goalRun: m.goalRun ? redactDeep(m.goalRun) : undefined,
    connector: m.connector ? redactDeep(m.connector) : undefined,
  };
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function pickColor(bots: BotRecord[]): HarnessbotColor {
  const counts = new Map<HarnessbotColor, number>(BOT_COLORS.map((c) => [c, 0]));
  for (const b of bots) counts.set(b.color, (counts.get(b.color) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0]![0];
}

function loadBot(bot: BotRecord): BotRecord {
  // Activity is derived, never durable: a bot cannot still be "working" after a restart.
  bot.activity = 'idle';
  bot.busy = false;
  if (!bot.tasks || bot.tasks.length === 0) {
    bot.tasks = [{ threadId: bot.threadId, title: 'New task', createdAt: bot.createdAt, resumeCursors: bot.resumeCursors ?? {} }];
  }
  bot.resumeCursors ??= {};
  return bot;
}

function loadGroup(group: GroupRecord): GroupRecord {
  group.busyBotId = null;
  // Old rooms predate defaultResponder. `everyone` would make them all answer at once,
  // so an unset value becomes `member` — quiet is the safe default.
  if (!group.defaultResponder) group.defaultResponder = group.dm ? 'mentions' : 'member';
  return group;
}

/** Repair reportsTo on load: self-links, dangling managers, and cycles all become roots. */
export function repairOrg(bots: BotRecord[]): void {
  const ids = new Set(bots.map((b) => b.id));
  for (const bot of bots) {
    if (bot.reportsTo === bot.id || (bot.reportsTo && !ids.has(bot.reportsTo))) delete bot.reportsTo;
  }
  const byId = new Map(bots.map((b) => [b.id, b]));
  for (const bot of bots) {
    const seen = new Set<string>([bot.id]);
    let cursor = bot.reportsTo;
    while (cursor) {
      if (seen.has(cursor)) {
        // Breaking the link at the bot that closed the ring keeps the rest of the chart.
        delete bot.reportsTo;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.reportsTo;
    }
  }
}

/** Drop leftover helper-lease records. That spawn path never shipped. */
export function stripLegacyHelpers(bots: BotRecord[]): boolean {
  let changed = false;
  for (let i = bots.length - 1; i >= 0; i--) {
    if (!Object.hasOwn(bots[i] as object, 'helper')) continue;
    bots.splice(i, 1);
    changed = true;
  }
  return changed;
}

export const store = new Store();
export type { Store };
