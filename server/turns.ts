import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppSource } from './paths.ts';
import type { BotRecord, GroupRecord, Message, ThreadId } from '../shared/types.ts';
import type { InstanceSnapshot, RuntimeEvent, SendTurnInput, TranscriptLine, TurnIntegrations } from './contracts.ts';
import { approvals, outcomeForChoice } from './approvals.ts';
import { getConfig } from './config.ts';
import { computerMount, hostScreenServer } from './computer.ts';
import { findCli } from './drivers/spawn.ts';
import { bus } from './harness/bus.ts';
import { registry } from './harness/registry.ts';
import { composeTurnText, imagesFromAttachments } from './attachments.ts';
import { compactTranscript, externalise, memoryForPrompt, sharedDir } from './memory.ts';
import { clip, clipList, estimateTokens, isQuickTurn, limitsFor, pickRelevant, pickSmallerModel } from './prompt-budget.ts';
import { skillsForPrompt } from './skills.ts';
import { store } from './store.ts';
import { notify } from './notifications.ts';
import { internalMountEnv } from './internal-tokens.ts';

/**
 * Turn orchestration: the layer between "a user pressed send" and "a driver ran".
 *
 * It owns the things that are wrong to push down into drivers (task isolation, cwd
 * pinning, queueing, room routing) and the things that are wrong to push up into the
 * UI (capability gating, approval wiring, usage banking).
 */

export interface SendOptions {
  botId: string;
  threadId?: ThreadId;
  text: string;
  sendId?: string;
  images?: { mime: string; data: string }[];
  attachments?: Message['attachments'];
  /** One-turn notes, prepended to the prompt text. Not stored as a separate message. */
  context?: string;
  replyToId?: string;
  /** A routine or webhook run is not a user typing; it must not steal the active task. */
  source?: 'user' | 'routine' | 'peer' | 'webhook';
  groupId?: string;
  from?: Message['from'];
  /** The user message is already in the transcript. Do not append another copy. */
  recordedMessageId?: string;
  /** Set on a queued item so cancel can find it. Not a send idempotency key. */
  queueId?: string;
  /** `text` is already `composeTurnText` output. Draining a queue must not compose it again. */
  composed?: boolean;
}

interface ActiveTurn {
  botId: string;
  threadId: ThreadId;
  turnId: string;
  instanceId: string;
  controller: AbortController;
  /** Settled text accumulates here; only the finished reply becomes a message. */
  buffer: string;
  groupId?: string;
  startedAt: number;
  timeout?: NodeJS.Timeout;
  leanSaved?: number;
}

const active = new Map<ThreadId, ActiveTurn>();
/** Messages sent while a thread was busy, drained on settle. */
const queues = new Map<ThreadId, SendOptions[]>();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** `undefined` follows the workspace default. */
export function leanOn(bot: BotRecord): boolean {
  if (bot.lean === true) return true;
  if (bot.lean === false) return false;
  return getConfig().lean.enabled;
}

const HANDS_HINT =
  /desktop|computer|click|screen|mouse|keyboard|browser|chrome|firefox|edge|type this|open (the )?(app|file|url|browser)|take (over|control)/i;

const DESKTOP_LINE =
  'Desktop tools are attached this turn on the localComputer server: screenshot, click, move, scroll, type_text, key, and open_target. ' +
  'Call them by those names, with a localComputer__ prefix if that is how they are listed. ' +
  'Use them for what the user asked. Do not claim you have no desktop or browser. ' +
  'Take a screenshot first, then click and move using that image’s coordinates. ' +
  'open_target opens an http(s) page in the default browser or starts an app by name. It does not sign in. ' +
  'Never type a password, a one-time code, or a cookie. If a sign-in wall appears, stop and ask.';

export function asksForHands(text: string): boolean {
  return HANDS_HINT.test(text);
}

let appSource: string | null | undefined;

/** Cached. A packaged build has no checkout, and we should not stat the disk on every turn. */
function harnessSource(): string | null {
  if (appSource !== undefined) return appSource;
  const here = path.dirname(fileURLToPath(import.meta.url));
  appSource = findAppSource([process.cwd(), here, path.resolve(here, '..')]);
  return appSource;
}

function systemPrompt(
  bot: BotRecord,
  group?: GroupRecord,
  query = '',
  lean = false,
  quick = false,
  cwd?: string,
  hands = false,
): string {
  const limits = limitsFor(lean || quick);
  const parts: string[] = [
    `You are ${bot.name}${bot.title ? `, ${bot.title}` : ''}. You are one contact in the user's HarnessBot roster.`,
  ];
  if (quick && !hands) {
    parts.push('This is a short question. Answer in a few sentences. Do not call tools unless you cannot answer without them.');
  } else if (lean) {
    parts.push(
      'Lean mode is on: keep replies tight, skip restating context you already have, and ask rather than guessing at compacted history.',
    );
  }
  if (bot.description) parts.push(clip(bot.description, limits.description));

  if (!quick) {
    const playbookSource = bot.playbooks ?? [];
    const playbooks = query
      ? pickRelevant(playbookSource, query, (p) => `${p.name} ${(p.triggers ?? []).join(' ')} ${p.instructions}`, limits.playbookCount)
      : clipList(playbookSource, limits.playbookCount);
    if (playbooks.kept.length) {
      const lines = playbooks.kept.map((p) => `- ${p.name}: ${clip(p.instructions, limits.playbookInstructions)}`);
      if (playbooks.hidden) lines.push(`- (${playbooks.hidden} more not shown)`);
      parts.push(`Process guidance:\n${lines.join('\n')}`);
    }

    const skills = skillsForPrompt(bot.id, { query: query || undefined, limits });
    if (skills) parts.push(skills);
  }

  if (group) {
    parts.push(
      `You are in the room "${group.name}" with ${group.memberIds
        .map((id) => store.getBot(id)?.name)
        .filter(Boolean)
        .join(', ')}. Address people by name. Only answer when you are the right one to answer.`,
    );
    // The bulletin is injected into every member turn, not just the first.
    if (group.bulletin) parts.push(`Room bulletin:\n${clip(group.bulletin, limits.bulletin)}`);
  }

  if (bot.chiefOfStaff) {
    parts.push('You are Chief of Staff for your section: coordinate peers and keep the user out of the loop where you safely can.');
  }

  if (!quick && bot.peerTools !== false) {
    const others = store
      .listBots()
      .filter((peer) => peer.id !== bot.id && !peer.hidden && peer.peerTools !== false);
    if (others.length) {
      const lines = others.slice(0, 12).map((peer) => {
        const bits = [peer.title, peer.section, peer.activity && peer.activity !== 'idle' ? peer.activity : '']
          .filter(Boolean)
          .join(', ');
        return `- ${peer.name}${bits ? ` (${bits})` : ''}`;
      });
      parts.push(
        `Other agents in this workspace:\n${lines.join('\n')}\n` +
          'Ask one when you need their answer before you continue. Delegate when they should do the work on their own chat. Do not invent names that are not in this list.',
      );
    }
  }

  // Tier 4. A handoff directory nobody is told about is a directory nobody uses.
  parts.push(
    `Shared workspace: ${sharedDir()}. Every bot here can read and write it. Put large results ` +
      '(scraped data, generated files, reports) there and pass the filename on, rather than pasting ' +
      'the whole thing into a reply — that is what makes a handoff survive a turn.',
  );

  parts.push(
    'Ask before destructive actions. Prefer small, verifiable steps. Never print credentials back to the user.',
  );
  if (hands) parts.push(DESKTOP_LINE);

  const source = harnessSource();
  if (cwd && source && path.resolve(cwd) === path.resolve(source)) {
    parts.push(
      `Your working folder is the HarnessBot source checkout at ${cwd}. ` +
        'You may fix bugs and change this app. Keep edits small and matching the surrounding code. ' +
        'Do not read or write the data directory (~/.harnessbot), secrets, or the decision log.',
    );
  }

  // Memory last, deliberately. Everything above changes rarely, and a provider's
  // prompt cache only pays off on a stable *prefix* — memory is the one section
  // that can change between two turns of the same conversation, so putting it at
  // the end keeps the cached span as long as possible.
  const memory = memoryForPrompt(bot.id, bot.section);
  if (memory) parts.push(memory);

  return parts.join('\n\n');
}

/**
 * Recent visible turns, replayed when there is no provider session to resume.
 *
 * Two tier-1 maintenance routines run here rather than at the call sites: oversized
 * lines spill to the shared workspace and leave a pointer, and anything past the
 * window is compacted into a digest instead of being silently dropped.
 */
function transcriptFor(
  threadId: ThreadId,
  limit: number = limitsFor(false).transcriptKeep,
  omitMessageId?: string,
): TranscriptLine[] {
  const lines = store
    .visiblePath(threadId)
    // The current turn is passed separately as the prompt. Leaving it in the replay
    // makes the model see the same message twice.
    .filter((m) => m.id !== omitMessageId)
    .filter((m) => (m.kind === 'text' || m.kind === 'comm') && m.text)
    .map((m) => ({
      role: (m.role === 'user' ? 'user' : 'bot') as 'user' | 'bot',
      text: externalise(m.text!, m.from?.name ?? m.role).text,
      name: m.from?.name,
    }));
  return compactTranscript(lines, limit);
}

// ---------------------------------------------------------------------------
// Integration gating
// ---------------------------------------------------------------------------

/** Harness-shipped proxies. A missing one must not be offered as a tool that cannot start. */
function harnessBinaryInstalled(command: string): boolean {
  return Boolean(findCli(command));
}

/**
 * Mount only what the driver can actually hold and the bot is allowed to use.
 * Offering a tool the engine cannot mount produces a bot that plans around hands it
 * does not have (HB-TRD-001 consideration 3).
 */
export function buildIntegrations(
  bot: BotRecord,
  snapshot: InstanceSnapshot,
  query?: string,
): { integrations: TurnIntegrations; notes: string[] } {
  const caps = snapshot.capabilities;
  const integrations: TurnIntegrations = {};
  const notes: string[] = [];
  const config = getConfig();

  // A short ask should not wait on MCP servers spinning up.
  if (query !== undefined && isQuickTurn(query)) {
    return { integrations, notes };
  }

  if (caps.computerMcp && bot.computer !== 'off') {
    // Lean will not provision Auto hands for a chat that did not ask for them.
    // An explicit placement still mounts — the user already chose.
    if (leanOn(bot) && !bot.computer && query !== undefined && !asksForHands(query)) {
      notes.push('Lean skipped computer this turn. Ask for the desktop if you need it.');
    } else {
      const { mount, kind, reason } = computerMount(bot);
      if (mount?.transport === 'stdio' && mount.command.startsWith('hb-') && !harnessBinaryInstalled(mount.command)) {
        notes.push(`No computer this turn: ${mount.command} is not installed.`);
      } else if (mount) {
        if (kind === 'localComputer' && mount.transport === 'stdio') {
          mount.env = { ...mount.env, ...internalMountEnv(bot.id) };
        }
        integrations[kind] = mount;
      } else if (reason) notes.push(`No computer this turn: ${reason}`);
    }
  }

  if (caps.composioMcp && bot.composio !== false) {
    const key = config.secrets['composio.apiKey'] ?? process.env.COMPOSIO_API_KEY;
    if (key && harnessBinaryInstalled('hb-composio-bridge')) {
      integrations.composio = {
        transport: 'stdio',
        command: 'hb-composio-bridge',
        args: ['--bot', bot.id],
        // The key goes to the bridge child only. It never reaches the model's argv.
        env: { COMPOSIO_API_KEY: key },
      };
    } else if (key) {
      notes.push('Connected apps bridge (hb-composio-bridge) is not installed.');
    }
  }

  if (caps.agentsMcp && bot.peerTools !== false) {
    integrations.agents = {
      transport: 'stdio',
      command: process.execPath,
      args: [new URL('./mcp/agents-proxy.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), bot.id],
      env: internalMountEnv(bot.id),
    };
  }

  if (caps.browserMcp && bot.browser !== false) {
    if (harnessBinaryInstalled('hb-browser-proxy')) {
      const profile = bot.browserProfile ?? 'default';
      integrations.browser = { transport: 'stdio', command: 'hb-browser-proxy', args: ['--bot', bot.id, '--profile', profile] };
    } else if (query && /browser|chrome|firefox|edge/i.test(query)) {
      notes.push('The built-in browser driver is not installed. With This computer opted in, open_target opens your own browser.');
    }
  }

  if (caps.phoneMcp && harnessBinaryInstalled('hb-phone-proxy')) {
    integrations.phone = { transport: 'stdio', command: 'hb-phone-proxy', args: ['--bot', bot.id] };
  }

  if (caps.customMcp && bot.customMcp !== false) {
    const screen = integrations.computer ? hostScreenServer()?.name : undefined;
    const custom: Record<string, NonNullable<TurnIntegrations['custom']>[string]> = {};
    for (const server of config.mcpServers) {
      if (!server.enabled) continue;
      if (screen && server.name === screen) continue;
      custom[server.name] =
        server.transport === 'stdio'
          ? { transport: 'stdio', command: server.command ?? '', args: server.args ?? [], env: server.env }
          : { transport: server.transport, url: server.url ?? '', headers: server.headers };
    }
    if (Object.keys(custom).length) integrations.custom = custom;
  }

  return { integrations, notes };
}

// ---------------------------------------------------------------------------
// Choosing an engine
// ---------------------------------------------------------------------------

const defaultModelOf = (snapshot: InstanceSnapshot): string =>
  snapshot.models.find((m) => m.default)?.id ?? snapshot.models[0]?.id ?? 'default';

/**
 * The engine a bot actually runs on this turn.
 *
 * A pinned bot uses exactly what it was given and fails loudly when that is gone. A
 * bot on `auto` follows whatever engine is connected now, which is the difference
 * between switching providers and having to re-point every bot in the roster by hand.
 *
 * Auto never moves a bot off a working engine — rotating providers mid-conversation
 * would drop the provider session for no reason. It moves only when the current one
 * cannot serve the turn.
 *
 * The resolved choice is written back before the turn starts, so resume cursors,
 * approvals and every later read of `modelSelection` see one stable answer.
 */
export async function resolveEngine(bot: BotRecord): Promise<InstanceSnapshot | null> {
  const pinned = await registry.snapshot(bot.modelSelection.instanceId);

  if (pinned?.state === 'available') {
    // The instance is fine but the model went away — a provider retiring an id.
    if (bot.modelSelection.model && !pinned.models.some((m) => m.id === bot.modelSelection.model)) {
      const model = defaultModelOf(pinned);
      store.updateBot(bot.id, { modelSelection: { ...bot.modelSelection, model } });
    }
    return pinned;
  }

  // Pinned and broken: that is the user's choice, and the reason belongs on screen.
  if (!bot.modelSelection.auto) return null;

  const next = (await registry.snapshots()).find((s) => s.state === 'available');
  if (!next) return null;
  store.updateBot(bot.id, {
    // Effort is per-driver; carrying it across a provider switch would be nonsense.
    modelSelection: { instanceId: next.instanceId, model: defaultModelOf(next), auto: true },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function sendToBot(opts: SendOptions): Promise<{ queued?: boolean; messageId?: string; error?: string }> {
  const bot = store.getBot(opts.botId);
  if (!bot) return { error: 'no such bot' };

  const threadId = opts.threadId ?? bot.threadId;

  // At-most-once: a retried POST with the same sendId must not send twice.
  // A drain of an already-recorded message has no sendId on purpose, so this
  // short-circuit must not swallow it.
  if (opts.sendId && !opts.recordedMessageId) {
    const existing = store.findBySendId(threadId, opts.sendId);
    if (existing) return { messageId: existing.id };
  }

  if (opts.recordedMessageId) {
    const recorded = store.getMessage(threadId, opts.recordedMessageId);
    // Cancelled before it ran. Nothing left to send.
    if (recorded && recorded.kind !== 'text') return { messageId: recorded.id };
  }

  const snapshot = await resolveEngine(bot);
  const adapter = snapshot ? registry.get(snapshot.instanceId) : undefined;
  const text = opts.composed ? opts.text : composeTurnText(opts.text, opts.attachments, opts.context);

  const recordUser = (extra: Partial<Message> = {}): Message => {
    if (opts.recordedMessageId) {
      const existing = store.getMessage(threadId, opts.recordedMessageId);
      if (existing) {
        const patch: Partial<Message> = {};
        if (extra.queued !== undefined) patch.queued = extra.queued;
        if (extra.queueId !== undefined) patch.queueId = extra.queueId;
        if (extra.steered !== undefined) patch.steered = extra.steered;
        if (Object.keys(patch).length) return store.patchMessage(threadId, existing.id, patch) ?? existing;
        return existing;
      }
    }
    return store.appendMessage(threadId, {
      role: 'user',
      kind: 'text',
      text,
      sendId: opts.sendId,
      replyToId: opts.replyToId,
      attachments: opts.attachments,
      from: opts.from,
      ...extra,
    });
  };

  if (!adapter || !snapshot || snapshot.state !== 'available') {
    const userMessage = recordUser();
    store.appendMessage(threadId, {
      role: 'bot',
      kind: 'text',
      text: snapshot?.reason ?? 'This engine is not available. Open Settings -> Engines to set it up.',
      tool: { name: 'setup', ok: false, setup: true },
    });
    store.setActivity(bot.id, 'dead');
    return { messageId: userMessage.id };
  }

  // Busy: queue if the engine drains queues, steer if it accepts mid-turn input,
  // and otherwise refuse rather than starting a second overlapping turn.
  if (active.has(threadId)) {
    if (snapshot.capabilities.queueing) {
      const queueId = opts.queueId ?? randomUUID();
      const message = recordUser({ queued: true, queueId });
      const queue = queues.get(threadId) ?? [];
      queue.push({
        ...opts,
        text,
        threadId,
        // Cleared so the drain is not treated as a retry of the original POST.
        sendId: undefined,
        recordedMessageId: message.id,
        queueId,
        composed: true,
      });
      queues.set(threadId, queue);
      return { queued: true, messageId: message.id };
    }
    if (snapshot.capabilities.steer) {
      const message = recordUser({ steered: true });
      return { messageId: message.id };
    }
    return { error: 'busy' };
  }

  const message = recordUser();
  if (message.queued) store.patchMessage(threadId, message.id, { queued: false });
  await dispatch(bot, threadId, { ...opts, text, threadId, composed: true }, snapshot, undefined, message.id);
  return { messageId: message.id };
}

/**
 * Fork the transcript at an edited user message and run that text as the next turn.
 * The edited line is the message; sending must not write it a second time.
 */
export async function editUserMessage(
  botId: string,
  threadId: ThreadId,
  messageId: string,
  text: string,
): Promise<{ messageId?: string; queued?: boolean; error?: string }> {
  const bot = store.getBot(botId);
  if (!bot) return { error: 'no such bot' };
  const original = store.getMessage(threadId, messageId);
  if (!original || original.role !== 'user' || original.kind !== 'text') return { error: 'no such message' };
  const trimmed = text.trim();
  if (!trimmed) return { error: 'text is required' };

  // A queued follow-up belongs to the branch being abandoned.
  cancelAllQueued(threadId);
  if (active.has(threadId)) await interrupt(botId, threadId);

  const forked = store.appendMessage(threadId, {
    role: 'user',
    kind: 'text',
    text: trimmed,
    parentId: original.parentId ?? null,
  });
  await dropSessions(botId, threadId);
  const sent = await sendToBot({ botId, threadId, text: trimmed, recordedMessageId: forked.id });
  return { messageId: forked.id, queued: sent.queued, error: sent.error };
}

async function dispatch(
  bot: BotRecord,
  threadId: ThreadId,
  opts: SendOptions,
  snapshot: InstanceSnapshot,
  groupId?: string,
  omitMessageId?: string,
): Promise<void> {
  // The caller already resolved this; re-reading the bot could pick a different one.
  const adapter = registry.get(snapshot.instanceId);
  if (!adapter) return;

  const task = store.getTask(bot, threadId);
  const group = groupId ? store.getGroup(groupId) : undefined;

  // Title the task from the first user line, and pin cwd on the first turn. Pinning
  // late would let a later `cd` move an existing provider session's project root.
  if (task) {
    const patch: Partial<typeof task> = {};
    if (task.title === 'New task' && opts.text.trim()) patch.title = opts.text.trim().slice(0, 60);
    if (task.cwd === undefined) patch.cwd = group?.pinnedCwd ?? bot.cwd ?? null;
    if (Object.keys(patch).length) store.updateTask(bot.id, threadId, patch);
  }
  // A room with a shared desk overrides each member's own folder.
  const pinned = group?.pinnedCwd ?? store.getTask(bot, threadId)?.cwd ?? bot.cwd ?? null;
  const cwd = pinned ?? os.homedir();

  const lean = leanOn(bot);
  const quick = isQuickTurn(opts.text, { attachments: opts.attachments, context: opts.context });
  const { integrations, notes } = buildIntegrations(bot, snapshot, opts.text);
  for (const note of notes) {
    store.appendMessage(threadId, { role: 'bot', kind: 'activity', text: note, tool: { name: 'computer', ok: false } });
  }

  let model = bot.modelSelection.model;
  const wantSmall = quick || (lean && getConfig().lean.preferSmallModel && !opts.attachments?.length && opts.text.length < 280 && !asksForHands(opts.text));
  if (wantSmall) {
    const smaller = pickSmallerModel(snapshot.models, model);
    if (smaller && smaller !== model) {
      model = smaller;
    }
  }

  const turnId = randomUUID();
  const controller = new AbortController();
  const hands = Boolean(integrations.localComputer || integrations.computer);
  // Grok's headless CLI cannot receive MCP. A desktop turn goes through ACP, which
  // does not resume the CLI session, so the transcript has to travel with the prompt.
  const desktopForGrok = snapshot.driver === 'grok' && hands;
  if (desktopForGrok) store.dropCursors(bot.id, threadId);
  const resumeCursor = desktopForGrok ? undefined : store.getResumeCursor(bot.id, threadId, bot.modelSelection.instanceId);
  const system = systemPrompt(bot, group, opts.text, lean, quick, cwd, hands);
  const transcript = resumeCursor ? [] : transcriptFor(threadId, quick ? 8 : limitsFor(lean).transcriptKeep, omitMessageId);
  const leanSaved =
    lean && !quick
      ? Math.max(
          0,
          estimateTokens(systemPrompt(bot, group, opts.text, false, false, cwd, hands)) -
            estimateTokens(system) +
            estimateTokens(JSON.stringify(resumeCursor ? [] : transcriptFor(threadId, limitsFor(false).transcriptKeep, omitMessageId))) -
            estimateTokens(JSON.stringify(transcript)),
        )
      : 0;
  const images = snapshot.capabilities.images
    ? opts.images?.length
      ? opts.images
      : imagesFromAttachments(opts.attachments)
    : undefined;

  const turn: ActiveTurn = {
    botId: bot.id,
    threadId,
    turnId,
    instanceId: bot.modelSelection.instanceId,
    controller,
    buffer: '',
    groupId,
    startedAt: Date.now(),
    leanSaved,
  };

  if (group) {
    // One stuck participant must not block the room forever.
    const minutes = getConfig().room.turnTimeoutMinutes;
    turn.timeout = setTimeout(() => {
      void interrupt(bot.id, threadId);
      store.appendMessage(threadId, {
        role: 'bot',
        kind: 'activity',
        text: `${bot.name} timed out after ${minutes} minute(s).`,
        tool: { name: 'timeout', ok: false },
      });
    }, minutes * 60_000);
    turn.timeout.unref?.();
    store.updateGroup(group.id, { busyBotId: bot.id });
  }

  active.set(threadId, turn);
  store.setActivity(bot.id, 'working');

  const input: SendTurnInput = {
    threadId,
    turnId,
    text: opts.text,
    system,
    model,
    effort: snapshot.capabilities.effortLevels.length ? bot.modelSelection.effort : undefined,
    cwd,
    resumeCursor,
    // With a live session the vendor already holds history; replay only when it does not.
    transcript,
    images,
    integrations,
    signal: controller.signal,
  };

  // Deliberately not awaited. A turn can stay open for minutes waiting on an approval
  // card, and the HTTP request that started it must not hold a socket that long. The
  // caller gets "accepted"; everything after that arrives over SSE.
  void adapter.sendTurn(input).catch((err: unknown) => {
    store.appendMessage(threadId, {
      role: 'bot',
      kind: 'text',
      text: `The engine failed to start this turn: ${String(err)}`,
      tool: { name: 'engine', ok: false, setup: true },
    });
    settle(threadId, 'error');
  });
}

/** Clear a rewound bot's cursors so the next turn replays the surviving branch. */
export async function dropSessions(botId: string, threadId: ThreadId): Promise<void> {
  const bot = store.getBot(botId);
  if (!bot) return;
  store.dropCursors(botId, threadId);
  for (const instanceId of Object.keys(getConfig().instances)) {
    await registry.get(instanceId)?.dropSession(threadId).catch(() => {});
  }
  store.updateBot(botId, { rewound: true });
}

export async function interrupt(botId: string, threadId?: ThreadId): Promise<void> {
  const bot = store.getBot(botId);
  if (!bot) return;
  const target = threadId ?? bot.threadId;
  const turn = active.get(target);
  const turnId = turn?.turnId;
  turn?.controller.abort();
  await registry.get(bot.modelSelection.instanceId)?.interrupt(target).catch(() => {});
  approvals.cancelForThread(target);
  // Abort may already have settled this turn and started whatever was queued.
  // Settling again would cancel that next turn.
  const current = active.get(target);
  if (current && current.turnId === turnId) settle(target, 'interrupted');
}

function markCancelled(threadId: ThreadId, messageId: string | undefined): void {
  if (!messageId) return;
  const existing = store.getMessage(threadId, messageId);
  if (!existing || existing.kind !== 'text') return;
  store.patchMessage(threadId, existing.id, {
    queued: false,
    kind: 'activity',
    text: existing.text ? `Cancelled: ${existing.text}` : 'Cancelled before it was sent',
    tool: { name: 'queue', ok: false },
  });
}

export function cancelQueued(threadId: ThreadId, queueId: string): boolean {
  const queue = queues.get(threadId);
  if (!queue) return false;
  const hit = queue.find((item) => item.queueId === queueId);
  if (!hit) return false;
  queues.set(
    threadId,
    queue.filter((item) => item.queueId !== queueId),
  );
  markCancelled(threadId, hit.recordedMessageId);
  return true;
}

function cancelAllQueued(threadId: ThreadId): void {
  const queue = queues.get(threadId);
  if (!queue?.length) return;
  queues.set(threadId, []);
  for (const item of queue) markCancelled(threadId, item.recordedMessageId);
}

/** "Inject now": interrupt the live turn and send immediately. */
export async function injectNow(opts: SendOptions): Promise<void> {
  const bot = store.getBot(opts.botId);
  if (!bot) return;
  await interrupt(opts.botId, opts.threadId);
  await sendToBot(opts);
}

export async function respondToApproval(
  botId: string,
  requestId: string,
  choiceId: string,
  answer?: string,
): Promise<{ ok: boolean; allowKey?: string | null }> {
  const pending = approvals.get(requestId);
  if (!pending || pending.botId !== botId) return { ok: false };

  // Remembering is a separate step, and only ever for the key the server issued.
  const allowKey = choiceId === 'always' ? approvals.remember(botId, requestId) : null;
  const outcome = outcomeForChoice(choiceId);
  approvals.resolve(requestId, outcome, 'user', answer);
  return { ok: true, allowKey };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Longest name first, on word boundaries, so "@Ana" never matches inside "@Anabel". */
export function mentionedBots(text: string, members: BotRecord[]): BotRecord[] {
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  const hits: BotRecord[] = [];
  for (const bot of sorted) {
    const escaped = bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`@${escaped}\\b`, 'i').test(text)) hits.push(bot);
  }
  return hits;
}

export async function sendToGroup(
  groupId: string,
  text: string,
  opts: {
    threadId?: ThreadId;
    sendId?: string;
    channelMode?: 'chat' | 'goal';
    from?: Message['from'];
    attachments?: Message['attachments'];
    context?: string;
    /** When set, only these members answer. A DM defaults to @mentions, which would drop a peer ask. */
    onlyBotIds?: string[];
  } = {},
): Promise<{ responders: string[]; messageId?: string }> {
  const group = store.getGroup(groupId);
  if (!group) return { responders: [] };
  const threadId = opts.threadId ?? group.threadId;
  const composed = composeTurnText(text, opts.attachments, opts.context);

  if (opts.sendId) {
    const existing = store.findBySendId(threadId, opts.sendId);
    if (existing) return { responders: [], messageId: existing.id };
  }

  const message = store.appendMessage(threadId, {
    role: opts.from ? 'bot' : 'user',
    kind: 'text',
    text: composed,
    sendId: opts.sendId,
    channelMode: opts.channelMode,
    from: opts.from,
    attachments: opts.attachments,
  });

  const members = group.memberIds.map((id) => store.getBot(id)).filter((b): b is BotRecord => !!b);
  const mentioned = mentionedBots(text, members);

  // An explicit @mention always wins over the room's default routing.
  // onlyBotIds wins over both: a peer ask must reach that bot even when the DM only answers mentions.
  let responders: BotRecord[];
  if (opts.onlyBotIds?.length) {
    const wanted = new Set(opts.onlyBotIds);
    responders = members.filter((member) => wanted.has(member.id));
  } else if (mentioned.length) responders = mentioned;
  else if (group.defaultResponder === 'mentions') responders = [];
  else if (group.defaultResponder === 'everyone') responders = members;
  else responders = members.slice(0, 1);

  for (const bot of responders) {
    const snapshot = await resolveEngine(bot);
    if (!snapshot || snapshot.state !== 'available') continue;
    if (active.has(threadId)) break; // Serialise the room: one speaker at a time.
    await dispatch(
      bot,
      threadId,
      { botId: bot.id, text: composed, source: 'user', attachments: opts.attachments, context: opts.context },
      snapshot,
      groupId,
      message.id,
    );
  }

  return { responders: responders.map((b) => b.id), messageId: message.id };
}

export interface PeerContactResult {
  ok: boolean;
  kind: 'ask' | 'delegate';
  peerName: string;
  dmGroupId?: string;
  threadId?: string;
  reply?: string;
  error?: string;
}

/** Bots currently waiting on a peer. Stops A → B → A and chains longer than two. */
const peerWaiters = new Set<string>();

/**
 * How one bot talks to another.
 *
 * Ask waits for the answer in their shared DM and returns it. Delegate starts the
 * work on the other bot's own chat and returns immediately — the caller is not
 * blocked on a job it handed off.
 */
export async function contactPeer(input: {
  callerId: string;
  targetId?: string;
  name?: string;
  text: string;
  kind?: 'ask' | 'delegate';
}): Promise<PeerContactResult> {
  const kind = input.kind === 'delegate' ? 'delegate' : 'ask';
  const caller = store.getBot(input.callerId);
  if (!caller) return { ok: false, kind, peerName: '', error: 'no such bot' };
  const target =
    (input.targetId ? store.getBot(input.targetId) : undefined) ?? store.botByName(String(input.name ?? ''));
  if (!target) return { ok: false, kind, peerName: input.name ?? '', error: 'no such peer' };
  if (target.id === caller.id) return { ok: false, kind, peerName: target.name, error: 'a bot cannot message itself' };
  if (caller.peerTools === false) return { ok: false, kind, peerName: target.name, error: 'peer tools are off for this bot' };
  if (target.peerTools === false) {
    return { ok: false, kind, peerName: target.name, error: `${target.name} is not taking messages from other bots` };
  }
  if (peerWaiters.has(target.id) || peerWaiters.size >= 2) {
    return { ok: false, kind, peerName: target.name, error: 'peer chain is too deep' };
  }
  const text = String(input.text ?? '').trim();
  if (!text) return { ok: false, kind, peerName: target.name, error: 'text is required' };

  const from = { botId: caller.id, name: caller.name, color: caller.color };

  if (kind === 'delegate') {
    const dm = store.dmChannel(caller, target);
    store.appendMessage(caller.threadId, {
      role: 'bot',
      kind: 'comm',
      text,
      comm: { peerBotId: target.id, peerName: target.name, dmGroupId: dm.id, kind: 'delegate' },
    });
    await sendToBot({
      botId: target.id,
      text: `${caller.name} delegated this task to you. Do it and reply with the result.\n\n${text}`,
      from,
      source: 'peer',
    });
    return { ok: true, kind, peerName: target.name, threadId: target.threadId, dmGroupId: dm.id };
  }

  const dm = store.dmChannel(caller, target);
  store.appendMessage(caller.threadId, {
    role: 'bot',
    kind: 'comm',
    text,
    comm: { peerBotId: target.id, peerName: target.name, dmGroupId: dm.id, kind: 'ask' },
  });
  peerWaiters.add(caller.id);
  try {
    const sent = await sendToGroup(dm.id, `${caller.name} asks: ${text}`, { from, onlyBotIds: [target.id] });
    if (!sent.responders.length) {
      return { ok: false, kind, peerName: target.name, dmGroupId: dm.id, error: `${target.name} has no engine available` };
    }
    await waitForSettle(dm.threadId);
    const path = store.visiblePath(dm.threadId);
    const start = path.findIndex((message) => message.id === sent.messageId);
    const reply = [...(start >= 0 ? path.slice(start + 1) : path)]
      .reverse()
      .find((message) => message.kind === 'text' && message.role === 'bot' && message.from?.botId !== caller.id);
    if (!reply?.text) return { ok: false, kind, peerName: target.name, dmGroupId: dm.id, error: `${target.name} did not reply` };
    return { ok: true, kind, peerName: target.name, dmGroupId: dm.id, reply: reply.text };
  } finally {
    peerWaiters.delete(caller.id);
  }
}

export const MAX_GOAL_TURNS = 13;

/**
 * Bounded multi-bot run. A coordinator drives the room for at most MAX_GOAL_TURNS,
 * and workers never recruit anyone outside it.
 */
export async function runGoal(groupId: string, goal: string): Promise<void> {
  const group = store.getGroup(groupId);
  if (!group) return;
  const members = group.memberIds.map((id) => store.getBot(id)).filter((b): b is BotRecord => !!b);
  if (!members.length) return;

  const coordinator = members.find((b) => b.chiefOfStaff) ?? members[0]!;
  const goalId = randomUUID();
  const card = store.appendMessage(group.threadId, {
    role: 'bot',
    kind: 'goal.run',
    goalRun: { goalId, goal, coordinatorId: coordinator.id, status: 'working', turns: 0, maxTurns: MAX_GOAL_TURNS },
  });

  let turns = 0;
  let status: 'completed' | 'limit-reached' | 'failed' = 'completed';
  try {
    while (turns < MAX_GOAL_TURNS) {
      turns++;
      const snapshot = await resolveEngine(coordinator);
      if (!snapshot || snapshot.state !== 'available') {
        status = 'failed';
        break;
      }
      await dispatch(
        coordinator,
        group.threadId,
        { botId: coordinator.id, text: turns === 1 ? goal : 'Continue toward the goal, or say DONE.' },
        snapshot,
        groupId,
      );
      await waitForSettle(group.threadId);
      const last = store.visiblePath(group.threadId).at(-1);
      if (last?.text?.includes('DONE')) break;
      if (turns >= MAX_GOAL_TURNS) status = 'limit-reached';
    }
  } catch {
    status = 'failed';
  }

  store.patchMessage(group.threadId, card.id, {
    goalRun: { goalId, goal, coordinatorId: coordinator.id, status, turns, maxTurns: MAX_GOAL_TURNS },
  });
}

export function waitForSettle(threadId: ThreadId, timeoutMs = 10 * 60_000): Promise<void> {
  if (!active.has(threadId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    settleWaiters.set(threadId, [...(settleWaiters.get(threadId) ?? []), finish]);
    function finish() {
      clearTimeout(timer);
      resolve();
    }
  });
}

const settleWaiters = new Map<ThreadId, (() => void)[]>();

// ---------------------------------------------------------------------------
// Event routing: RuntimeEvent -> store. One subscription, one direction.
// ---------------------------------------------------------------------------

function settle(threadId: ThreadId, reason: string): void {
  const turn = active.get(threadId);
  if (!turn) return;
  clearTimeout(turn.timeout);
  active.delete(threadId);

  const bot = store.getBot(turn.botId);
  if (bot) store.setActivity(bot.id, 'idle');
  if (turn.groupId) store.updateGroup(turn.groupId, { busyBotId: null });

  for (const waiter of settleWaiters.get(threadId) ?? []) waiter();
  settleWaiters.delete(threadId);

  // Drain anything queued while this turn held the thread.
  const queue = queues.get(threadId);
  if (queue?.length) {
    const next = queue.shift()!;
    queues.set(threadId, queue);
    void sendToBot(next);
  }
  void reason;
}

function threadOwner(threadId: ThreadId): BotRecord | undefined {
  const turn = active.get(threadId);
  if (turn) return store.getBot(turn.botId);
  return store.listBots().find((b) => b.threadId === threadId || (b.tasks ?? []).some((t) => t.threadId === threadId));
}

export function startEventRouting(): () => void {
  return bus.subscribe((event: RuntimeEvent) => {
    const bot = threadOwner(event.threadId);
    if (!bot) return;
    const turn = active.get(event.threadId);
    const threadId = event.threadId;

    // A late event from a turn we already left must not settle, or write into, the next one.
    if (turn && event.turnId && event.turnId !== turn.turnId) return;

    switch (event.type) {
      case 'session.started': {
        if (event.resumeCursor !== undefined) {
          store.setResumeCursor(bot.id, threadId, event.providerInstanceId ?? bot.modelSelection.instanceId, event.resumeCursor);
          // A fresh session means the rewind has been honoured.
          if (bot.rewound) store.updateBot(bot.id, { rewound: false });
        }
        break;
      }

      case 'content.delta': {
        // Deltas stream to the inspector over SSE; they are not painted into the
        // bubble and not persisted. Only the settled reply becomes a message.
        if (turn && event.itemKind === 'assistant_text') turn.buffer += event.delta;
        break;
      }

      case 'item.completed': {
        if (event.itemKind === 'assistant_text' && event.text) {
          store.appendMessage(threadId, { role: 'bot', kind: 'text', text: event.text });
          if (turn) turn.buffer = '';
          notify(bot, { kind: 'finished', threadId, preview: event.text.slice(0, 120) });
        } else if (event.itemKind === 'tool') {
          store.appendMessage(threadId, {
            role: 'bot',
            kind: 'activity',
            text: event.title,
            // Spoken label computed once here so voice mode never re-derives it.
            tool: {
              name: event.toolName ?? 'tool',
              ok: event.ok,
              setup: event.setup,
              spoken: `${event.toolName ?? 'tool'} ${event.ok === false ? 'failed' : 'finished'}`,
            },
          });
        }
        break;
      }

      case 'item.started': {
        if (event.itemKind === 'tool' && getConfig().showToolCalls) {
          store.appendMessage(threadId, {
            role: 'bot',
            kind: 'activity',
            text: event.title,
            tool: { name: event.toolName ?? 'tool', spoken: `running ${event.toolName ?? 'a tool'}` },
          });
        }
        break;
      }

      case 'request.opened': {
        const autoAnswered = approvals.open(bot, event, event.providerInstanceId ?? bot.modelSelection.instanceId);
        if (!autoAnswered) notify(bot, { kind: 'needs-approval', threadId, preview: event.summary });
        break;
      }

      case 'request.resolved': {
        if (event.requestId) approvals.resolve(event.requestId, event.outcome, event.source, event.answer);
        break;
      }

      case 'turn.completed': {
        const leanSaved = turn?.leanSaved;
        if (event.usage || leanSaved) {
          // Bank usage here and only here: the live indicator is not additive.
          store.addUsage(bot.id, threadId, { ...event.usage, leanSaved });
        }
        if (turn?.buffer.trim()) {
          // The driver streamed text but never emitted a completed item; keep it
          // rather than losing the reply to a protocol gap.
          store.appendMessage(threadId, { role: 'bot', kind: 'text', text: turn.buffer });
        }
        approvals.cancelForThread(threadId);
        settle(threadId, event.stopReason ?? 'completed');
        break;
      }

      case 'runtime.error': {
        store.appendMessage(threadId, {
          role: 'bot',
          kind: 'activity',
          text: event.message,
          tool: { name: event.setup ? 'setup' : 'error', ok: false, setup: event.setup },
        });
        if (event.setup) store.setActivity(bot.id, 'dead');
        notify(bot, { kind: 'failed', threadId, preview: event.message });
        break;
      }

      case 'session.exited':
      case 'turn.started':
      case 'turn.retrying':
      case 'item.updated':
      case 'thread.token-usage.updated':
        break;
    }
  });
}

/** Wire the broker's outcomes back into whichever adapter is holding the request. */
approvals.onResolve((req, outcome, source, answer) => {
  const adapter = registry.get(req.instanceId);
  void adapter?.answerRequest({ requestId: req.requestId, outcome, source, answer }).catch(() => {});
  const bot = store.getBot(req.botId);
  if (bot && active.has(req.threadId)) store.setActivity(bot.id, 'working');
});
