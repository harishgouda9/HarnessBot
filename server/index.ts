import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BotRecord, Routine, RoutineSchedule } from '../shared/types.ts';
import { CREDENTIAL_TARGETS, isAvatarShape, type CredentialTargetId } from '../shared/types.ts';
import { approvals, readDecisions } from './approvals.ts';
import { canonicalProfileId, getConfig, publicConfig, saveConfig, setSecret, SECRET_KEYS } from './config.ts';
import * as connectors from './connectors.ts';
import * as computer from './computer.ts';
import { probeCli } from './drivers/cli.ts';
import { findCli } from './drivers/spawn.ts';
import { registerBuiltInDrivers } from './drivers/builtIn.ts';
import { bus } from './harness/bus.ts';
import { registry } from './harness/registry.ts';
import * as memory from './memory.ts';
import * as org from './org.ts';
import { mimeForFilename } from './attachments.ts';
import { DATA_DIR, dataPath, ensureDir, findAppSource, newId, readNdjsonTail, threadLogPath } from './paths.ts';
import * as routines from './routines.ts';
import { filterMessages } from './search.ts';
import { buildRosterBackup } from './backup.ts';
import { packageStatus, explicitSecretValue } from './desktop.ts';
import { authorizePhoneAction, capturePhone, queryPhones } from './phone.ts';
import { botSpentUsd, evaluateSpend } from './spend.ts';
import * as plugins from './plugins.ts';
import * as providers from './providers.ts';
import { bridgeStatus } from './hermes-bridge.ts';
import * as skills from './skills.ts';
import { store, type StoreChange } from './store.ts';
import * as teams from './teams.ts';
import * as tts from './tts.ts';
import * as turns from './turns.ts';
import * as vm from './vm.ts';
import { notifications } from './notifications.ts';
import { botForToken, mintInternalToken, revokeInternalToken } from './internal-tokens.ts';
import { forgetBot } from './forget-bot.ts';
import * as jobs from './jobs.ts';
import { jobEvents } from './jobs.ts';
import { threadActivity } from './activity-feed.ts';
import { listHistory } from './history.ts';
import * as workflows from './workflows.ts';
import { workflowEvents } from './workflows.ts';
import { VERSION } from './version.ts';
import { botDuplicateFields } from './bot-copy.ts';
import { mergeModelSelection } from './model-selection.ts';
import { rejectionForSendError } from './send-http.ts';
import { staticMiss } from './static-miss.ts';
import { createWebhook, deleteWebhook, listWebhooks, rotateWebhook, startWebhookServer } from './webhooks.ts';

/**
 * The harness API. Plain node:http, JSON in and out, bound to 127.0.0.1 only.
 *
 * There is no authentication, by design: the trust boundary is the OS user account.
 * That is exactly why this must never bind anywhere but loopback, why the Host header
 * is checked (a DNS-rebinding page in a browser is otherwise a local-network client),
 * and why the webhook receiver lives on its own port and route set.
 */

const PORT = Number(process.env.HB_PORT ?? process.env.OGB_PORT ?? 8799);
const HOST = '127.0.0.1';
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

function hasIndexHtml(dir: string): boolean {
  try {
    return Boolean(dir) && fs.existsSync(path.join(dir, 'index.html'));
  } catch {
    return false;
  }
}

/**
 * Where GET / is served from.
 *
 * `HB_STATIC_DIR` always wins, including the empty string Electron-dev and the
 * test sandbox use to mean "API only". When the variable is unset — `pnpm
 * dev:server`, a preview pane, a stray `node` process — look next to the
 * server and in the checkout so a built UI is what answers rather than
 * `{"error":"not found"}`. That JSON at http://127.0.0.1:8799/ is the bug
 * Hermes Agent's preview hits.
 */
export function resolveStaticDir(input: { env?: string; cwd?: string; here?: string } = {}): string {
  // `env` omitted → process env. `env: undefined` → auto-detect. `env: ''` → API only.
  const env = Object.prototype.hasOwnProperty.call(input, 'env') ? input.env : process.env.HB_STATIC_DIR;
  const cwd = input.cwd ?? process.cwd();
  const here = input.here ?? SERVER_DIR;
  if (env !== undefined) return env;
  const candidates = [
    path.join(here, '..', 'ui'),
    path.join(here, '..', 'dist'),
    path.join(here, '..', '..', 'dist'),
    path.join(cwd, 'ui'),
    path.join(cwd, 'dist'),
  ];
  for (const dir of candidates) {
    if (hasIndexHtml(dir)) return dir;
  }
  return '';
}

const STATIC_DIR = resolveStaticDir();

// -- tiny router -------------------------------------------------------------

type Ctx = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<any>;
};
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

const routes: { method: string; parts: string[]; handler: Handler }[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
}

const get = (p: string, h: Handler) => route('GET', p, h);
const post = (p: string, h: Handler) => route('POST', p, h);
const patch = (p: string, h: Handler) => route('PATCH', p, h);
const put = (p: string, h: Handler) => route('PUT', p, h);
const del = (p: string, h: Handler) => route('DELETE', p, h);

function match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const spec = candidate.parts[i]!;
      if (spec.startsWith(':')) {
        try {
          params[spec.slice(1)] = decodeURIComponent(parts[i]!);
        } catch (err) {
          // A bare "%" is a bad request, not an uncaught exception that kills the process.
          if (err instanceof URIError) return null;
          throw err;
        }
      } else if (spec !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: candidate.handler, params };
  }
  return null;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (message: string): never => {
  throw new HttpError(400, message);
};
const notFound = (message = 'not found'): never => {
  throw new HttpError(404, message);
};
function rejectSend(error: string | undefined): void {
  const rejection = rejectionForSendError(error);
  if (rejection) throw new HttpError(rejection.status, rejection.message);
}

const MAX_JSON_BYTES = 32 * 1024 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// -- SSE ---------------------------------------------------------------------

interface Client {
  id: string;
  res: http.ServerResponse;
  screens: boolean;
}

const clients = new Map<string, Client>();
const REPLAY_MAX = 500;
const serverBootId = randomUUID();
let seq = 0;
const replay: { seq: number; kind: string; data: unknown }[] = [];

function dataFrame(kind: string, data: unknown, id?: number): string {
  const prefix = id === undefined ? '' : `id: ${id}\n`;
  return `${prefix}event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sendFrame(client: Client, frame: string): void {
  try {
    client.res.write(frame);
  } catch {
    // A disconnected client must not abort the write for everyone else.
    clients.delete(client.id);
  }
}

/** Integer cursor, or null when the client did not ask for one (full replay). */
function parseSince(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * True when `since` is older than the oldest frame we still hold, so replaying
 * the ring would skip a hole. An empty ring that has already advanced means the
 * same thing: everything the client missed has fallen out.
 */
function resumeGap(since: number): boolean {
  const oldest = replay[0]?.seq;
  if (oldest === undefined) return since < seq;
  return since < oldest - 1;
}

/**
 * The single place store changes and runtime events become SSE. Everything the UI
 * knows arrives through here, so there is exactly one write path to fold.
 */
function broadcast(kind: string, data: unknown): void {
  // Screen frames are large and worthless after the moment they happen: never
  // replay, and never spend a resume cursor on a frame a reconnect cannot see.
  if (kind === 'screen') {
    const frame = dataFrame(kind, data);
    for (const client of clients.values()) {
      if (!client.screens) continue;
      sendFrame(client, frame);
    }
    return;
  }
  const id = ++seq;
  replay.push({ seq: id, kind, data });
  if (replay.length > REPLAY_MAX) replay.shift();
  const frame = dataFrame(kind, data, id);
  for (const client of clients.values()) sendFrame(client, frame);
}

jobEvents.on('job', (job) => broadcast('job', job));
jobEvents.on('job.deleted', (data) => broadcast('job.deleted', data));
workflowEvents.on('workflow', (workflow) => broadcast('workflow', workflow));
workflowEvents.on('workflow.deleted', (data) => broadcast('workflow.deleted', data));
workflowEvents.on('workflow.run', (run) => broadcast('workflow.run', run));

function wireBot(botId: string): unknown {
  const bot = store.getBot(botId);
  if (!bot) return { id: botId, deleted: true };
  // Cursors are provider session handles. They are not the UI's business, and
  // stripping them here is cheaper than remembering to strip them per route.
  const { resumeCursors: _c, tasks, ...rest } = bot;
  return { ...rest, tasks: (tasks ?? []).map(({ resumeCursors: _t, ...task }) => task) };
}

store.on('change', (change: StoreChange) => {
  switch (change.type) {
    case 'message':
      broadcast('message', { threadId: change.threadId, message: change.message });
      break;
    case 'message.patch':
      broadcast('message.patch', { threadId: change.threadId, message: change.message });
      break;
    case 'thread':
      broadcast('thread', { threadId: change.threadId, activeLeafId: change.activeLeafId });
      break;
    case 'thread.deleted':
      broadcast('thread.deleted', { threadId: change.threadId });
      break;
    case 'bot':
      broadcast('bot', wireBot(change.botId));
      break;
    case 'bot.deleted':
      revokeInternalToken(change.botId);
      broadcast('bot.deleted', { id: change.botId });
      break;
    case 'group':
      broadcast('group', store.getGroup(change.groupId));
      break;
    case 'group.deleted':
      broadcast('group.deleted', { id: change.groupId });
      break;
  }
});

// Runtime events are the inspector's feed: streamed, never a second write path.
bus.subscribe((event) => broadcast('runtime', event));
notifications.on('notify', (n) => broadcast('notify', n));

// -- routes: health, events --------------------------------------------------

get('/api/health', () => ({
  app: 'harnessbot',
  version: VERSION,
  pid: process.pid,
  // True only when the process will actually answer GET / with the UI, not merely
  // when an env var is set. The Hermes desktop plugin uses this to decide whether
  // the harness it adopted is an old API-only process that needs a restart.
  static: Boolean(STATIC_DIR && fs.existsSync(path.join(STATIC_DIR, 'index.html'))),
}));

get('/api/events', ({ req, res, url }) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const client: Client = { id: randomUUID(), res, screens: url.searchParams.get('screens') !== 'off' };
  clients.set(client.id, client);

  const since = parseSince(url.searchParams.get('since'));
  const boot = url.searchParams.get('boot');
  // A cursor from a previous process, or a hole in the ring, cannot be resumed.
  // Say so. The client re-reads the roster instead of trusting a partial replay.
  const resync = (Boolean(boot) && boot !== serverBootId) || (since !== null && resumeGap(since));

  res.write(dataFrame('hello', { clientId: client.id, replay: replay.length, serverBootId }));
  if (resync) {
    res.write(dataFrame('resync', { serverBootId }));
  } else {
    for (const item of replay) {
      if (since !== null && item.seq <= since) continue;
      res.write(dataFrame(item.kind, item.data, item.seq));
    }
  }

  let ping: NodeJS.Timeout;
  const forget = (): void => {
    clearInterval(ping);
    clients.delete(client.id);
  };
  ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      forget();
    }
  }, 15_000);
  ping.unref?.();
  req.on('close', forget);
  // 'error' with no listener is an uncaught exception. A dropped socket emits one.
  res.on('error', forget);
  return undefined; // response already owned
});

get('/api/decisions', () => readDecisions());
get('/api/notifications', () => notifications.list());

// -- routes: bots ------------------------------------------------------------

get('/api/bots', () => store.listBots().map((b) => wireBot(b.id)));

post('/api/bots', async ({ body }) => {
  const input = await body();
  if (!input.name || typeof input.name !== 'string') bad('name is required');
  const snapshots = await registry.snapshots();
  const fallback = snapshots.find((s) => s.state === 'available');
  // Default to following the workspace. Freezing whichever engine happened to be up
  // the day a bot was created is what left whole rosters dead after a provider switch.
  const modelSelection = input.modelSelection ?? {
    instanceId: fallback?.instanceId ?? 'claude',
    model: fallback?.models.find((m) => m.default)?.id ?? fallback?.models[0]?.id ?? 'default',
    auto: true,
  };
  const computer = input.computer ?? getConfig().defaultComputer;
  return wireBot(store.createBot({ ...input, modelSelection, computer }).id);
});

/** Only these fields may be set from the client. A PATCH is not a way into the store. */
const BOT_PATCH_FIELDS: (keyof BotRecord)[] = [
  'name',
  'title',
  'description',
  'color',
  'mascotExpression',
  'avatarUrl',
  'avatarShape',
  'avatarCrop',
  'notifications',
  'modelSelection',
  'computer',
  'cloudBackend',
  'autoStartVps',
  'cwd',
  'workFolder',
  'autoApprove',
  'autoReview',
  'speakReplies',
  'voice',
  'pinned',
  'hidden',
  'unread',
  'section',
  'pinnedMessageId',
  'reportsTo',
  'orgPos',
  'reviewRounds',
  'approvePeerComms',
  'composio',
  'browser',
  'peerTools',
  'customMcp',
  'browserProfile',
  'threadId',
  'lean',
  'spendCapUsd',
];

patch('/api/bots/:id', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const clean: Partial<BotRecord> = {};
  for (const key of BOT_PATCH_FIELDS) if (key in input) (clean as any)[key] = input[key];
  if (clean.name !== undefined) clean.name = String(clean.name).slice(0, 100);
  if (clean.title !== undefined) clean.title = String(clean.title).slice(0, 200);
  if (clean.description !== undefined) clean.description = String(clean.description).slice(0, 4000);
  // autoReview is a safety switch: an unrecognised persisted value means off.
  if (clean.autoReview !== undefined && !['off', 'shadow', 'enforce'].includes(clean.autoReview)) clean.autoReview = 'off';
  // Detaching arrives as null: `undefined` does not survive JSON.stringify, so a
  // client sending it produced an empty PATCH and the manager silently stayed put.
  // Normalise a falsy manager to absent rather than storing a null nobody reads.
  if ('reportsTo' in input && !input.reportsTo) clean.reportsTo = undefined;
  if ('lean' in input && input.lean !== true && input.lean !== false) clean.lean = undefined;
  if ('workFolder' in input) {
    if (input.workFolder == null || input.workFolder === '') clean.workFolder = undefined;
    else {
      const folder = jobs.normalizeWorkFolder(input.workFolder);
      if (!folder) bad('work folder must be an absolute path');
      clean.workFolder = folder;
    }
  }
  if ('avatarShape' in input) {
    const shape = input.avatarShape;
    if (shape == null || shape === '') clean.avatarShape = undefined;
    else if (!isAvatarShape(shape)) bad('unknown avatar shape');
    else clean.avatarShape = shape;
  }
  if ('spendCapUsd' in input) {
    const cap = input.spendCapUsd;
    if (cap === null || cap === '' || cap === undefined) clean.spendCapUsd = undefined;
    else if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) clean.spendCapUsd = cap;
    else bad('spend cap must be a positive amount');
  }
  if (clean.browserProfile !== undefined) {
    const id = canonicalProfileId(String(clean.browserProfile));
    if (!id) bad('invalid browser profile id');
    clean.browserProfile = id!;
  }
  if ('modelSelection' in input) {
    try {
      clean.modelSelection = mergeModelSelection(bot.modelSelection, input.modelSelection);
    } catch (err) {
      bad(err instanceof Error ? err.message : 'invalid modelSelection');
    }
  }
  if ('chiefOfStaff' in input) store.setChiefOfStaff(bot.id, input.chiefOfStaff === true);
  return wireBot(store.updateBot(params.id!, clean)!.id);
});

del('/api/bots/:id', async ({ params }) => {
  await forgetBot(params.id!);
  return { ok: true };
});

post('/api/bots/:id/read', ({ params }) => wireBot(store.updateBot(params.id!, { unread: false })!.id));

post('/api/bots/:id/duplicate', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  return wireBot(store.createBot(botDuplicateFields(bot)).id);
});

get('/api/bots/:id/tasks', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  return store.tasksOf(bot).map(({ resumeCursors: _c, ...task }) => task);
});

post('/api/bots/:id/tasks', async ({ params, body }) => {
  const input = await body();
  const task = store.createTask(params.id!, input.title) ?? notFound('no such bot');
  const { resumeCursors: _c, ...rest } = task;
  return rest;
});

const APP_EDITORS = new Set(['claude', 'grok', 'hermes']);

get('/api/app-source', () => {
  const root = findAppSource([SERVER_DIR, process.cwd()]);
  return { available: Boolean(root), path: root };
});

/** Point this bot's current task at the HarnessBot checkout, or stop doing that. */
post('/api/bots/:id/work-on-app', async ({ params, body }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const root = findAppSource([SERVER_DIR, process.cwd()]) ?? bad('HarnessBot source was not found next to this process');
  const instance = (await registry.snapshot(bot.modelSelection.instanceId));
  if (!instance || !APP_EDITORS.has(instance.driver)) {
    bad('Only a Claude, Grok, or Hermes bot can edit this app');
  }
  const enabled = (await body()).enabled === true;
  if (enabled) {
    store.updateBot(bot.id, { cwd: root });
    store.updateTask(bot.id, bot.threadId, { cwd: root });
  } else if (bot.cwd === root || store.getTask(bot, bot.threadId)?.cwd === root) {
    if (bot.cwd === root) store.updateBot(bot.id, { cwd: undefined });
    store.updateTask(bot.id, bot.threadId, { cwd: null });
  }
  // The provider session is bound to the old folder. Drop it so the next turn starts clean.
  await turns.dropSessions(bot.id, bot.threadId);
  return { enabled, path: enabled ? root : null };
});

// Title only. A task's cursors, cwd and usage are the harness's business, not a rename's.
patch('/api/bots/:id/tasks/:threadId', async ({ params, body }) => {
  const input = await body();
  const title = String(input.title ?? '').trim();
  if (!title) bad('title is required');
  store.updateTask(params.id!, params.threadId!, { title: title.slice(0, 120) });
  return { ok: true };
});

del('/api/bots/:id/tasks/:threadId', ({ params }) => {
  store.deleteTask(params.id!, params.threadId!);
  return { ok: true };
});

post('/api/bots/:id/messages', async ({ params, body }) => {
  const input = await body();
  const text = typeof input.text === 'string' ? input.text : '';
  const attachments = Array.isArray(input.attachments) ? input.attachments : undefined;
  const images = Array.isArray(input.images) ? input.images : undefined;
  const context = typeof input.context === 'string' ? input.context : undefined;
  if (!text.trim() && !attachments?.length && !images?.length && !context?.trim()) {
    bad('text or an attachment is required');
  }
  if (input.injectNow) {
    await turns.injectNow({ botId: params.id!, ...input, text });
    return { ok: true };
  }
  const result = await turns.sendToBot({
    botId: params.id!,
    threadId: input.threadId,
    text,
    sendId: input.sendId,
    images,
    attachments,
    context,
    replyToId: input.replyToId,
  });
  rejectSend(result.error);
  return result;
});

post('/api/bots/:id/interrupt', async ({ params, body }) => {
  const input = await body().catch(() => ({}));
  await turns.interrupt(params.id!, input?.threadId);
  return { ok: true };
});

post('/api/bots/:id/respond', async ({ params, body }) => {
  const input = await body();
  if (!input.requestId || !input.choiceId) bad('requestId and choiceId are required');
  return turns.respondToApproval(params.id!, input.requestId, input.choiceId, input.answer);
});

get('/api/bots/:id/approvals', ({ params }) => approvals.listForBot(params.id!));

/** Remembered grants, split by scope so the UI can show them apart. */
get('/api/bots/:id/always-allow', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  return { tools: bot.alwaysAllow ?? [], localComputer: bot.alwaysAllowLocalComputer ?? [] };
});

del('/api/bots/:id/always-allow/:key', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  return wireBot(
    store.updateBot(bot.id, {
      alwaysAllow: (bot.alwaysAllow ?? []).filter((k) => k !== params.key),
      alwaysAllowLocalComputer: (bot.alwaysAllowLocalComputer ?? []).filter((k) => k !== params.key),
    })!.id,
  );
});

post('/api/bots/:id/rewind', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const threadId = input.threadId ?? bot.threadId;
  if (!input.messageId) bad('messageId is required');
  store.setActiveLeaf(threadId, input.messageId);
  // The abandoned branch must not come back through a resumed session.
  await turns.dropSessions(bot.id, threadId);
  return { ok: true };
});

post('/api/bots/:id/messages/:messageId/edit', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const threadId = input.threadId ?? bot.threadId;
  if (typeof input.text !== 'string' || !input.text.trim()) bad('text is required');
  const result = await turns.editUserMessage(bot.id, threadId, params.messageId!, input.text);
  rejectSend(result.error);
  return { messageId: result.messageId, queued: result.queued };
});

post('/api/bots/:id/active-branch', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  store.setActiveLeaf(input.threadId ?? bot.threadId, input.leafId ?? null);
  return { ok: true };
});

del('/api/bots/:id/queue/:queueId', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  // The send was queued on whichever task was busy, which may no longer be the active one.
  const threads = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
  let removed = false;
  for (const threadId of threads) {
    if (turns.cancelQueued(threadId, params.queueId!)) removed = true;
  }
  return { ok: removed };
});

// -- routes: threads ---------------------------------------------------------

get('/api/threads/:threadId/messages', ({ params, url }) => {
  const limit = Number(url.searchParams.get('limit') ?? 0) || undefined;
  const all = url.searchParams.get('all') === 'true';
  const messages = all ? store.listMessages(params.threadId!, limit) : store.visiblePath(params.threadId!);
  return {
    messages: limit && !all ? messages.slice(-limit) : messages,
    activeLeafId: store.getActiveLeaf(params.threadId!),
    total: store.countMessages(params.threadId!),
  };
});

post('/api/threads/:threadId/reactions', async ({ params, body }) => {
  const input = await body();
  const message = store.getMessage(params.threadId!, input.messageId) ?? notFound('no such message');
  const reactions = message.reactions ?? [];
  const existing = reactions.findIndex((r) => r.emoji === input.emoji && r.by === (input.by ?? 'user'));
  const next = existing >= 0 ? reactions.filter((_, i) => i !== existing) : [...reactions, { emoji: input.emoji, by: input.by ?? 'user' }];
  return store.patchMessage(params.threadId!, input.messageId, { reactions: next });
});

get('/api/threads/:threadId/events', ({ params, url }) => {
  const limit = Number(url.searchParams.get('limit') ?? 200);
  const file = threadLogPath('events', params.threadId!);
  if (!file) return [];
  return readNdjsonTail(file, limit);
});

get('/api/threads/:threadId/export', ({ params }) => ({
  threadId: params.threadId,
  exportedAt: Date.now(),
  messages: store.visiblePath(params.threadId!),
}));

// -- routes: groups ----------------------------------------------------------

get('/api/groups', () => store.listGroups());

post('/api/groups', async ({ body }) => {
  const input = await body();
  if (!input.name) bad('name is required');
  if (!Array.isArray(input.memberIds) || input.memberIds.length === 0) bad('memberIds is required');
  return store.createGroup(input);
});

patch('/api/groups/:id', async ({ params, body }) => {
  const input = await body();
  const allowed = ['name', 'memberIds', 'defaultResponder', 'bulletin', 'section', 'pinnedCwd', 'pinnedMessageId', 'unread', 'threadId'];
  const clean: Record<string, unknown> = {};
  for (const key of allowed) if (key in input) clean[key] = input[key];
  return store.updateGroup(params.id!, clean) ?? notFound('no such room');
});

del('/api/groups/:id', ({ params }) => {
  store.deleteGroup(params.id!);
  return { ok: true };
});

post('/api/groups/:id/messages', async ({ params, body }) => {
  const group = store.getGroup(params.id!) ?? notFound('no such room');
  const input = await body();
  const text = typeof input.text === 'string' ? input.text : '';
  const attachments = Array.isArray(input.attachments) ? input.attachments : undefined;
  const context = typeof input.context === 'string' ? input.context : undefined;
  if (!text.trim() && !attachments?.length && !context?.trim()) bad('text or an attachment is required');
  if (input.channelMode === 'goal') {
    void turns.runGoal(group.id, text);
    return { started: true };
  }
  return turns.sendToGroup(group.id, text, {
    threadId: input.threadId,
    sendId: input.sendId,
    attachments,
    context,
  });
});

post('/api/groups/:id/tasks', async ({ params, body }) => {
  const input = await body();
  return store.createGroupTask(params.id!, input.title) ?? notFound('no such room');
});

post('/api/groups/:id/interrupt', async ({ params }) => {
  const group = store.getGroup(params.id!) ?? notFound('no such room');
  if (group.busyBotId) await turns.interrupt(group.busyBotId, group.threadId);
  return { ok: true };
});

post('/api/groups/:id/read', ({ params }) => store.updateGroup(params.id!, { unread: false }));

// -- routes: search, files ---------------------------------------------------

get('/api/search', ({ url }) => {
  const query = url.searchParams.get('q') ?? '';
  if (query.length < 2) return { bots: [], messages: [] };
  const lower = query.toLowerCase();
  const cardRaw = url.searchParams.get('card');
  const card = cardRaw === 'approval' || cardRaw === 'tool' || cardRaw === 'goal' ? cardRaw : undefined;
  const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined;
  const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : undefined;
  return {
    bots: store
      .listBots()
      .filter((b) => !b.hidden && (b.name.toLowerCase().includes(lower) || b.title.toLowerCase().includes(lower)))
      .map((b) => ({ id: b.id, name: b.name, title: b.title, color: b.color })),
    messages: filterMessages({
      query,
      botId: url.searchParams.get('bot') || url.searchParams.get('botId') || undefined,
      roomId: url.searchParams.get('room') || url.searchParams.get('roomId') || undefined,
      from: from != null && Number.isFinite(from) ? from : undefined,
      to: to != null && Number.isFinite(to) ? to : undefined,
      card,
    }),
  };
});

get('/api/backup', () => buildRosterBackup());

get('/api/package-status', () => packageStatus());

get('/api/phone', async () => queryPhones());

post('/api/phone/:serial/screenshot', async ({ params }) => capturePhone(params.serial!));

post('/api/phone/actions', async ({ body }) => {
  const input = await body();
  const action = String(input.action ?? '');
  if (action !== 'send' && action !== 'pay' && action !== 'delete') bad('action must be send, pay, or delete');
  // The decision is the gate. Nothing is sent to the phone from this route.
  return authorizePhoneAction(action, input.approved === true);
});

const ATTACHMENTS = ensureDir(dataPath('attachments'));
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

post('/api/attachments', async ({ body }) => {
  const input = await body();
  if (typeof input.data !== 'string' || typeof input.name !== 'string') bad('name and data are required');
  const buffer = Buffer.from(input.data, 'base64');
  const isImage = String(input.mime ?? '').startsWith('image/');
  if (buffer.length > (isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) bad('attachment is too large');
  const id = newId('att');
  // Store under a generated id, never the client-supplied name: a name is a path.
  const ext = path.extname(input.name).replace(/[^.\w]/g, '').slice(0, 10);
  fs.writeFileSync(path.join(ATTACHMENTS, id + ext), buffer);
  return { id, name: input.name, mime: input.mime ?? 'application/octet-stream', url: `/api/attachments/${id}${ext}` };
});

get('/api/attachments/:name', ({ params, res }) => {
  const safe = path.basename(params.name!);
  const file = path.join(ATTACHMENTS, safe);
  // basename plus a containment check: neither alone is enough on Windows.
  if (!path.resolve(file).startsWith(path.resolve(ATTACHMENTS)) || !fs.existsSync(file)) notFound();
  res.writeHead(200, { 'content-type': mimeForFilename(safe), 'cache-control': 'private, max-age=3600' });
  res.end(fs.readFileSync(file));
  return undefined;
});

// -- routes: config, engines -------------------------------------------------

get('/api/config', () => publicConfig());

patch('/api/config', async ({ body }) => {
  const input = await body();
  // Secrets come in through this route and never go back out of it.
  if (input.secrets && typeof input.secrets === 'object') {
    for (const [key, value] of Object.entries(input.secrets)) {
      if (!(SECRET_KEYS as readonly string[]).includes(key)) bad(`unknown secret: ${key}`);
      setSecret(key, value === null || value === '' ? null : String(value));
    }
    delete input.secrets;
  }
  saveConfig(input);
  await registry.reload();
  broadcast('config', publicConfig());
  return publicConfig();
});

put('/api/config', async ({ body }) => {
  const input = await body();
  delete input.secrets;
  // publicConfig() hands out `environmentKeys` instead of `environment`, so a client
  // that reads config and writes it back would otherwise erase every instance's API
  // key. Carry the existing environment forward unless this PUT sets a real one.
  if (input.instances && typeof input.instances === 'object') {
    const current = getConfig().instances;
    for (const [id, instance] of Object.entries(input.instances as Record<string, any>)) {
      if (!instance || typeof instance !== 'object') continue;
      delete instance.environmentKeys;
      if (!instance.environment && current[id]?.environment) instance.environment = current[id]!.environment;
    }
  }
  saveConfig(input);
  await registry.reload();
  broadcast('config', publicConfig());
  return publicConfig();
});

get('/api/instances', async () => registry.snapshots());

post('/api/instances', async ({ body }) => {
  const input = await body();
  if (!input.instanceId || !input.driver) bad('instanceId and driver are required');
  // The id becomes a config key and a bot's stored pointer, so it is validated here
  // rather than trusted the way the rest of the body can be.
  const instanceId = String(input.instanceId).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) bad('instanceId must be 1-64 characters of A-Z, a-z, 0-9, _ or -');
  if (!registry.registeredKinds().includes(String(input.driver))) {
    bad(`unknown driver: ${input.driver}. Known: ${registry.registeredKinds().join(', ')}`);
  }
  const instances = { ...getConfig().instances, [instanceId]: { driver: input.driver, ...input.config } };
  saveConfig({ instances });
  await registry.reload();
  return registry.snapshots();
});

post('/api/instances/:id/models', async ({ params }) => {
  const adapter = registry.get(params.id!) ?? notFound('no such instance');
  await adapter.refreshModels?.();
  return (await registry.snapshot(params.id!)) ?? notFound('no such instance');
});

patch('/api/instances/:id', async ({ params, body }) => {
  const input = await body();
  const instances = { ...getConfig().instances };
  const existing = instances[params.id!] ?? notFound('no such instance');
  instances[params.id!] = { ...existing, ...input };
  saveConfig({ instances });
  await registry.reload();
  return registry.snapshot(params.id!);
});

del('/api/instances/:id', async ({ params }) => {
  const instances = { ...getConfig().instances };
  delete instances[params.id!];
  saveConfig({ instances });
  await registry.reload();
  return { ok: true };
});

// Loopback probe of the well-known local model runtimes. See providers.ts.
get('/api/local-models', async () => providers.detectLocalRuntimes());

// What the host Hermes lent us, if we are running inside one. Answers
// `connected: false` standalone rather than 404ing, so the UI can say so.
get('/api/hermes', () => bridgeStatus());

get('/api/cli-candidates', () => {
  const names = ['claude', 'codex', 'grok', 'cursor-agent', 'kimi', 'droid', 'antigravity', 'opencode', 'qwen', 'hermes', 'pi'];
  return names.map((name) => ({ name, path: findCli(name) }));
});

post('/api/cli-test', async ({ body }) => {
  const input = await body();
  if (!input.command) bad('command is required');
  try {
    return { ok: true, version: await probeCli(input.command, input.args) };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
});

get('/api/mcp-servers', () => getConfig().mcpServers);

post('/api/mcp-servers', async ({ body }) => {
  const input = await body();
  if (!input.name) bad('name is required');
  // A server with no command or no url mounts as an empty argv and fails at turn
  // time, far from the form that accepted it. Refuse it here instead.
  const transport = ['stdio', 'http', 'sse'].includes(input.transport) ? input.transport : 'stdio';
  if (transport === 'stdio' && !String(input.command ?? '').trim()) bad('command is required for a stdio server');
  if (transport !== 'stdio' && !String(input.url ?? '').trim()) bad(`url is required for an ${transport} server`);
  const servers = getConfig().mcpServers.filter((s) => s.name !== input.name);
  // Mounted without pre-allow: its tools ride the normal permission flow.
  servers.push({ enabled: true, ...input, transport });
  saveConfig({ mcpServers: servers });
  return servers;
});

patch('/api/mcp-servers/:name', async ({ params, body }) => {
  const input = await body();
  const servers = getConfig().mcpServers.map((s) => (s.name === params.name ? { ...s, ...input } : s));
  saveConfig({ mcpServers: servers });
  return servers;
});

del('/api/mcp-servers/:name', ({ params }) => {
  saveConfig({ mcpServers: getConfig().mcpServers.filter((s) => s.name !== params.name) });
  return { ok: true };
});

// -- routes: computers -------------------------------------------------------

get('/api/local-computer', () => computer.platformSummary());

get('/api/bots/:id/computer', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  return {
    placement: computer.resolvePlacement(bot),
    hostControl: computer.hostControlStatus(bot.id),
    held: computer.isHeld(bot.id),
  };
});

post('/api/bots/:id/computer/preview', async ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  if (computer.desktopSession() === 'wayland') bad('Wayland host preview is disabled.');
  const shot = await computer.capturePreview();
  broadcast('screen', { botId: bot.id, threadId: bot.threadId, png: shot.data, mime: shot.mime, at: Date.now() });
  return { ok: true, width: shot.width, height: shot.height };
});

post('/api/bots/:id/computer/opt-in', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  computer.setLocalOptIn(bot.id, input.enabled === true);
  return computer.hostControlStatus(bot.id);
});

post('/api/bots/:id/computer/control/take', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const token = computer.takeControl(bot.id);
  broadcast('computer-control', { botId: bot.id, held: true });
  return { token };
});

post('/api/bots/:id/computer/control/release', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  // Release requires the token from take: UI state alone must never assert it.
  const released = computer.releaseControl(bot.id, input.token ?? '');
  if (released) broadcast('computer-control', { botId: bot.id, held: false });
  return { released };
});

// -- routes: connectors ------------------------------------------------------

// Listing reconciles pending OAuth: a tab the user abandoned must not read as connected.
get('/api/connectors', async () => ({
  configured: connectors.composioConfigured(),
  connected: await connectors.refreshStatuses(),
}));
get('/api/connectors/catalog', async ({ url }) => connectors.catalog(url.searchParams.get('q') ?? undefined));
get('/api/connectors/connected', () => connectors.listConnected());

post('/api/connectors/authorize', async ({ body }) => {
  const input = await body();
  if (!input.slug) bad('slug is required');
  return connectors.authorize(input.slug, input.label);
});

del('/api/connectors/:accountId', ({ params }) => {
  connectors.disconnect(params.accountId!);
  return { ok: true };
});

// -- routes: secret request cards --------------------------------------------

post('/api/bots/:id/secret-cards/:messageId', async ({ params, body }) => {
  const input = await body();
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const message = store.getMessage(bot.threadId, params.messageId!) ?? notFound('no such card');
  const target = message.secret?.target;
  // Only allowlisted credential targets, and only ever written, never read back.
  // A bare `throw` rather than the bad() helper, so the compiler narrows `target` too.
  if (!target || !CREDENTIAL_TARGETS.includes(target)) throw new HttpError(400, 'not a credential card');
  const secretValue = explicitSecretValue(input.value);
  if (!secretValue) bad('an explicit value is required');
  const map: Record<CredentialTargetId, string> = {
    xaiApiKey: 'xai.key',
    boxToken: 'box.token',
    opencodeGoApiKey: 'opencodeGo.apiKey',
    ttsKey: 'elevenlabs.key',
    openaiImageApiKey: 'openai.imageKey',
  };
  setSecret(map[target], secretValue);
  store.patchMessage(bot.threadId, message.id, { secret: { ...message.secret!, provided: true } });
  await registry.reload();
  return { ok: true };
});

// -- routes: memory, skills --------------------------------------------------

/** One of the three durable tiers, or a 400 — never a silent fallback to `bot`. */
const memoryScope = (raw: unknown): memory.MemoryScopeName =>
  memory.MEMORY_SCOPES.includes(raw as never) ? (raw as memory.MemoryScopeName) : bad(`scope must be one of ${memory.MEMORY_SCOPES.join(', ')}`);

/** The workspace tier is a singleton, so its id is implied rather than demanded. */
const memoryId = (scope: memory.MemoryScopeName, raw: string | null): string =>
  scope === 'workspace' ? memory.WORKSPACE_ID : (raw ?? bad('id is required'));

get('/api/memory', ({ url }) => {
  const scope = memoryScope(url.searchParams.get('scope') ?? 'bot');
  const id = memoryId(scope, url.searchParams.get('id'));
  return memory.listMemory(scope, id, url.searchParams.get('q') ?? undefined);
});

post('/api/memory', async ({ body }) => {
  const input = await body();
  const scope = memoryScope(input.scope ?? 'bot');
  // A tier other bots read is not one a bot may edit on its own. The account-wide
  // tier has the widest blast radius of the three, so it is gated the same way.
  if (scope !== 'bot' && input.source !== 'user') {
    const grantId = scope === 'workspace' ? memory.WORKSPACE_ID : input.sectionId;
    if (!memory.canWriteSection(grantId)) {
      throw new HttpError(403, `${scope} memory requires an explicit user grant`);
    }
  }
  return memory.addMemory({ ...input, scope });
});

patch('/api/memory/:entryId', async ({ params, body }) => {
  const input = await body();
  const scope = memoryScope(input.scope ?? 'bot');
  return memory.updateMemory(scope, memoryId(scope, input.id ?? null), params.entryId!, input) ?? notFound('no such entry');
});

del('/api/memory/:entryId', ({ params, url }) => {
  const scope = memoryScope(url.searchParams.get('scope') ?? 'bot');
  const id = memoryId(scope, url.searchParams.get('id'));
  return { ok: memory.deleteMemory(scope, id, params.entryId!) };
});

// -- routes: shared artifacts (memory tier 4) --------------------------------

get('/api/artifacts', () => ({ dir: memory.sharedDir(), files: memory.listArtifacts() }));

get('/api/artifacts/:name', ({ params }) => {
  try {
    return { name: params.name!, body: memory.readArtifact(params.name!) };
  } catch (err) {
    return notFound(String(err instanceof Error ? err.message : err));
  }
});

post('/api/artifacts', async ({ body }) => {
  const input = await body();
  if (!input.name) bad('name is required');
  try {
    return memory.writeArtifact(String(input.name), String(input.body ?? ''));
  } catch (err) {
    // Containment failures are bad input, not a server fault.
    return bad(String(err instanceof Error ? err.message : err));
  }
});

del('/api/artifacts/:name', ({ params }) => ({ ok: memory.deleteArtifact(params.name!) }));

post('/api/memory/section-grant', async ({ body }) => {
  const input = await body();
  // `workspace` is a valid id here: the account-wide tier is granted the same way.
  memory.grantSectionMemory(String(input.sectionId ?? memory.WORKSPACE_ID), input.granted === true);
  return { ok: true };
});

/**
 * A scope is a bot id or the literal `global`. `botId` stays accepted so an older
 * renderer keeps working, and either way it is validated before it becomes a path.
 */
const scopeOf = (raw: unknown): string => {
  const value = String(raw ?? bad('scope is required'));
  try {
    return skills.scopeId(value);
  } catch {
    // A bad scope is bad input, not a server fault: it must not read as a 500.
    return bad('scope must be a bot id or "global"');
  }
};

const scopeFrom = (input: { scope?: unknown; botId?: unknown }): string => scopeOf(input.scope ?? input.botId);

get('/api/skills', ({ url }) => {
  const raw = url.searchParams.get('scope') ?? url.searchParams.get('botId');
  const scope = raw ? scopeOf(raw) : null;
  // Bodies are only sent when asked for. A skill list is browsed constantly; the
  // bytes are read once, right before someone approves them.
  const full = url.searchParams.get('full') === '1';
  const strip = <T extends { body: string }>(s: T) => (full ? s : { ...s, body: undefined });
  return {
    library: skills.librarySkills().map(strip),
    installed: scope ? skills.listSkills(scope).map(strip) : [],
    staged: scope ? skills.listStaged(scope) : [],
    // Always sent: a bot's page has to show what it inherits from the workspace.
    global: skills.listSkills(skills.GLOBAL_SCOPE).map(strip),
    plugins: plugins.listPlugins(),
  };
});

post('/api/skills/install', async ({ body }) => {
  const input = await body();
  if (!input.name) bad('name is required');
  return skills.installFromLibrary(scopeFrom(input), input.name);
});

/** Paste or upload a SKILL.md. It stages like every other proposal, never installs. */
post('/api/skills/add', async ({ body }) => {
  const input = await body();
  const text = String(input.body ?? '');
  if (!text.trim()) bad('a SKILL.md body is required');
  const meta = skills.summarize(text);
  const name = input.name || meta.name || skills.slugFromPath(String(input.filename ?? '')) || bad('name is required');
  return skills.stageSkill(scopeFrom(input), name as string, input.summary ?? meta.summary, text);
});

/** Fetch a SKILL.md from GitHub or any https URL and stage it for review. */
post('/api/skills/fetch', async ({ body }) => {
  const input = await body();
  if (!input.url) bad('url is required');
  return skills.stageFromUrl(scopeFrom(input), String(input.url), input.name);
});

post('/api/skills/confirm', async ({ body }) => {
  const input = await body();
  // The digest is what binds the card to the bytes the user actually read.
  return skills.confirmSkill(scopeFrom(input), input.name, input.sha256);
});

post('/api/skills/reject', async ({ body }) => {
  const input = await body();
  skills.rejectSkill(scopeFrom(input), input.name);
  return { ok: true };
});

del('/api/skills/:name', ({ params, url }) => {
  skills.removeSkill(scopeOf(url.searchParams.get('scope') ?? url.searchParams.get('botId')), params.name!);
  return { ok: true };
});

// -- routes: plugins ---------------------------------------------------------

get('/api/plugins', () => plugins.listPlugins());

/** Two phase, like team packages: parse to a plan the user reads, then install it. */
post('/api/plugins/parse', async ({ body }) => {
  const input = await body();
  if (!input.source) bad('source is required (a GitHub repo, owner/repo, or a SKILL.md URL)');
  return plugins.parsePlugin(String(input.source));
});

post('/api/plugins/install', async ({ body }) => {
  const input = await body();
  if (!input.plan) bad('plan is required (parse first, then install the reviewed plan)');
  return plugins.installPlugin(scopeFrom(input), input.plan);
});

del('/api/plugins/:id', ({ params }) => ({ ok: plugins.removePlugin(params.id!) }));

// -- routes: skill recorder (behind Experimental) ----------------------------

get('/api/recordings', ({ url }) => skills.listRecordings(url.searchParams.get('botId') ?? undefined));

function recentActions(botId: string): string[] {
  const bot = store.getBot(botId);
  if (!bot) return [];
  return store
    .visiblePath(bot.threadId)
    .filter((message) => message.text && (message.kind === 'activity' || message.tool))
    .map((message) => message.text!)
    .slice(-40);
}

post('/api/recordings', async ({ body }) => {
  const input = await body();
  if (!input.botId || !input.name) bad('botId and name are required');
  if (!store.getBot(input.botId)) notFound('no such bot');
  const session = skills.startRecording(input.botId, input.name);
  return skills.importSteps(session.id, recentActions(input.botId)) ?? session;
});

post('/api/recordings/:id/import', ({ params }) => {
  const session = skills.getRecording(params.id!) ?? notFound('no such recording');
  return skills.importSteps(session.id, recentActions(session.botId)) ?? notFound('no such recording');
});

post('/api/recordings/:id/steps', async ({ params, body }) => {
  const input = await body();
  const kind = ['action', 'note', 'check'].includes(input.kind) ? input.kind : 'action';
  return skills.addStep(params.id!, kind, String(input.text ?? '')) ?? notFound('no such recording');
});

del('/api/recordings/:id/steps/:index', ({ params }) =>
  skills.removeStep(params.id!, Number(params.index)) ?? notFound('no such recording'),
);

post('/api/recordings/:id/finish', async ({ params, body }) => {
  const input = await body();
  // Produces a staged proposal only. Installing still needs an explicit confirm.
  return skills.finishRecording(params.id!, String(input.summary ?? '')) ?? notFound('no such recording');
});

del('/api/recordings/:id', ({ params }) => {
  skills.cancelRecording(params.id!);
  return { ok: true };
});

// -- routes: teams, org ------------------------------------------------------

post('/api/teams/parse', async ({ body }) => {
  const input = await body();
  let markdown = input.markdown ?? '';
  if (!markdown && input.url) {
    // A GitHub URL is untrusted input like any other package source.
    const res = await fetch(String(input.url));
    if (!res.ok) bad(`could not fetch package: ${res.status}`);
    markdown = await res.text();
  }
  if (!markdown) bad('markdown or url is required');
  return teams.parseTeamPackage(markdown);
});

post('/api/teams/import', async ({ body }) => {
  const input = await body();
  if (!input.plan) bad('plan is required (parse first, then apply the reviewed plan)');
  const snapshots = await registry.snapshots();
  const fallback = snapshots.find((s) => s.state === 'available');
  const defaults = input.modelSelection ?? {
    instanceId: fallback?.instanceId ?? 'claude',
    model: fallback?.models.find((m) => m.default)?.id ?? 'default',
    auto: true,
  };
  const result = teams.applyTeamPlan(input.plan, defaults);
  return { ...result, bots: result.bots.map((b) => wireBot(b.id)) };
});

get('/api/teams/export', ({ url }) => ({
  markdown: teams.exportTeam(url.searchParams.get('ids')?.split(',').filter(Boolean)),
}));

get('/api/org-graph', () => org.orgGraph());

post('/api/org-graph/links', async ({ body }) => {
  const input = await body();
  if (!input.from || !input.to) bad('from and to are required');
  const result = org.addLink({ from: input.from, to: input.to, kind: input.kind ?? 'peer', label: input.label, step: input.step });
  if (!result.ok) bad(result.reason ?? 'could not add link');
  broadcast('org-graph', org.orgGraph());
  return result.link;
});

patch('/api/org-graph/links/:id', async ({ params, body }) => {
  const link = org.updateLink(params.id!, await body()) ?? notFound('no such link');
  broadcast('org-graph', org.orgGraph());
  return link;
});

del('/api/org-graph/links/:id', ({ params }) => {
  const removed = org.removeLink(params.id!);
  if (removed) broadcast('org-graph', org.orgGraph());
  return { ok: removed };
});

post('/api/org-graph/positions', async ({ body }) => {
  const input = await body();
  for (const [botId, pos] of Object.entries(input.positions ?? {})) org.setPosition(botId, pos as { x: number; y: number });
  return { ok: true };
});

get('/api/org-graph/auto-layout', () => org.autoLayout());

get('/api/org-graph/charts', () => org.listCharts());

post('/api/org-graph/charts', async ({ body }) => {
  const input = await body();
  if (!input.name || !Array.isArray(input.botIds)) bad('name and botIds are required');
  const result = org.saveChart(input);
  if (!result.ok) bad(result.reason ?? 'could not save chart');
  return result.chart;
});

del('/api/org-graph/charts/:id', ({ params }) => {
  org.deleteChart(params.id!);
  return { ok: true };
});

get('/api/team-map', () => org.teamMap());

// -- routes: local VM and browser workspaces ---------------------------------

get('/api/local-vm', async () => vm.vmState());

post('/api/local-vm/pull', async () => vm.pullImage());

post('/api/bots/:id/local-vm/:action', async ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const action = params.action;
  if (action === 'start') {
    const result = await vm.startVm(bot.id);
    if (result.ok) vm.touchVm(bot.id);
    broadcast('computer', { botId: bot.id, kind: 'vm', ...result });
    return result;
  }
  if (action === 'stop') return vm.stopVm(bot.id);
  if (action === 'remove') return vm.removeVm(bot.id);
  if (action === 'screenshot') {
    const shot = await vm.screenshotVm(bot.id);
    if (shot.ok && shot.png) {
      vm.touchVm(bot.id);
      // Frames are live-only: broadcast, never replay, never persisted here.
      broadcast('screen', { botId: bot.id, threadId: bot.threadId, png: shot.png, mime: 'image/png', at: Date.now() });
    }
    return shot;
  }
  return bad(`unknown local VM action: ${action}`);
});

get('/api/bots/:id/browser', ({ params, url }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const profileId = url.searchParams.get('profile') ?? bot.browserProfile ?? 'default';
  return { profileId, ...vm.browserState(bot.id, profileId) };
});

post('/api/bots/:id/browser/tab', async ({ params, body }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const input = await body();
  const profileId = canonicalProfileId(String(input.profileId ?? bot.browserProfile ?? 'default'));
  if (!profileId) bad('invalid browser profile id');
  const tab = vm.setBrowserTab({
    botId: bot.id,
    profileId: profileId!,
    url: String(input.url ?? ''),
    title: String(input.title ?? ''),
    loading: input.loading === true,
  });
  broadcast('browser', tab);
  return tab;
});

del('/api/bots/:id/browser/tab', ({ params, url }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  vm.clearBrowserTab(bot.id, url.searchParams.get('profile') ?? bot.browserProfile ?? 'default');
  return { ok: true };
});

/** Screen frames from a computer proxy. Live only, and never retained in the replay buffer. */
post('/api/internal/screen', async ({ req, body }) => {
  const botId = requireInternalBot(req);
  const input = await body();
  const bot = store.getBot(botId) ?? notFound('no such bot');
  if (typeof input.png !== 'string') bad('png is required');
  broadcast('screen', { botId, threadId: bot.threadId, png: input.png, mime: input.mime ?? 'image/png', at: Date.now() });
  // A frame worth keeping becomes a real message; the rest stay ephemeral.
  if (input.keep === true) {
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'screen', png: input.png, mime: input.mime ?? 'image/png' });
  }
  return { ok: true };
});

post('/api/sidebar-sections', async ({ body }) => {
  const input = await body();
  for (const botId of input.botIds ?? []) store.updateBot(botId, { section: input.section || undefined });
  return store.listBots().map((b) => wireBot(b.id));
});

// -- routes: automation ------------------------------------------------------

get('/api/routines', () => routines.listRoutines().map((routine) => ({ ...routine, spend: routines.routineSpendStatus(routine) })));

post('/api/bots/:id/spend-confirm', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const spent = botSpentUsd(bot);
  store.updateBot(bot.id, { spendConfirmedUsd: spent });
  turns.releaseSpendHold(bot.id);
  return { ...wireBot(bot.id) as object, verdict: evaluateSpend({ spentUsd: spent, capUsd: bot.spendCapUsd, confirmedUsd: spent }) };
});

get('/api/bots/:id/spend', ({ params }) => {
  const bot = store.getBot(params.id!) ?? notFound('no such bot');
  const spentUsd = botSpentUsd(bot);
  return {
    spentUsd,
    capUsd: bot.spendCapUsd ?? null,
    confirmedUsd: bot.spendConfirmedUsd ?? null,
    verdict: evaluateSpend({ spentUsd, capUsd: bot.spendCapUsd, confirmedUsd: bot.spendConfirmedUsd }),
  };
});

post('/api/routines', async ({ body }) => {
  const input = await body();
  if (!input.botId || !input.prompt) bad('botId and prompt are required');
  let schedule: RoutineSchedule;
  try {
    schedule = routines.parseSchedule(input.schedule);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'invalid schedule');
  }
  const cap = input.spendCapUsd;
  let routine: Routine;
  try {
    routine = routines.createBoundRoutine({
      name: input.name ?? 'Routine',
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn === 'cloud' ? 'cloud' : 'harnessbot',
      enabled: input.enabled !== false,
      schedule,
      durationMinutes: Math.min(240, Math.max(1, Number(input.durationMinutes ?? 30))),
      attachments: input.attachments,
      sourceThreadId: input.sourceThreadId,
      spendCapUsd: typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined,
      jobId: typeof input.jobId === 'string' ? input.jobId : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'could not create the routine';
    if (message === 'jobId must be a job on this bot' || message === 'this job already has a schedule') bad(message);
    throw err;
  }
  broadcast('routine', routine);
  return routine;
});

patch('/api/routines/:id', async ({ params, body }) => {
  const input = await body();
  const patch: Partial<Routine> = {};
  if ('name' in input) patch.name = String(input.name ?? '').slice(0, 200);
  if ('prompt' in input) patch.prompt = String(input.prompt ?? '');
  if ('enabled' in input) patch.enabled = input.enabled === true;
  if ('runOn' in input) patch.runOn = input.runOn === 'cloud' ? 'cloud' : 'harnessbot';
  if ('schedule' in input) {
    try {
      patch.schedule = routines.parseSchedule(input.schedule);
    } catch (err) {
      bad(err instanceof Error ? err.message : 'invalid schedule');
    }
  }
  if ('durationMinutes' in input) patch.durationMinutes = Math.min(240, Math.max(1, Number(input.durationMinutes ?? 30)));
  if ('spendCapUsd' in input) {
    const cap = input.spendCapUsd;
    patch.spendCapUsd = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined;
  }
  const routine = routines.updateRoutine(params.id!, patch) ?? notFound('no such routine');
  broadcast('routine', routine);
  return routine;
});

del('/api/routines/:id', ({ params }) => {
  routines.deleteRoutine(params.id!);
  jobs.unbindRoutine(params.id!);
  broadcast('routine.deleted', { id: params.id });
  return { ok: true };
});

get('/api/history', ({ url }) => listHistory(url.searchParams.get('q') ?? ''));

get('/api/threads/:threadId/activity', ({ params }) => threadActivity(params.threadId!));

get('/api/workflows', () => workflows.listWorkflows());

get('/api/workflows/runs', ({ url }) => workflows.listWorkflowRuns(url.searchParams.get('workflowId') ?? undefined));

post('/api/workflows', async ({ body }) => {
  const input = await body();
  try {
    return workflows.createWorkflow(input);
  } catch (err) {
    bad(err instanceof Error ? err.message : 'could not create the workflow');
  }
});

patch('/api/workflows/:id', async ({ params, body }) => {
  const input = await body();
  try {
    return workflows.updateWorkflow(params.id!, input) ?? notFound('no such workflow');
  } catch (err) {
    bad(err instanceof Error ? err.message : 'could not update the workflow');
  }
});

del('/api/workflows/:id', ({ params }) => {
  if (!workflows.deleteWorkflow(params.id!)) notFound('no such workflow');
  return { ok: true };
});

post('/api/workflows/:id/run', async ({ params, body }) => {
  const input = await body().catch(() => ({}));
  const note = input && typeof input.input === 'string' ? input.input : undefined;
  try {
    return workflows.runWorkflow(params.id!, note);
  } catch (err) {
    bad(err instanceof Error ? err.message : 'could not run the workflow');
  }
});

post('/api/workflows/runs/:id/handoff', async ({ params, body }) => {
  const input = await body();
  try {
    return workflows.handoffRun(params.id!, typeof input?.botId === 'string' ? input.botId : '');
  } catch (err) {
    bad(err instanceof Error ? err.message : 'could not hand off the step');
  }
});

post('/api/workflows/runs/:id/cancel', ({ params }) => {
  return workflows.cancelWorkflowRun(params.id!) ?? notFound('no such run');
});

post('/api/workflows/runs/:id/retry', ({ params }) => {
  try {
    return workflows.retryWorkflowRun(params.id!);
  } catch (err) {
    bad(err instanceof Error ? err.message : 'could not try the step again');
  }
});

// -- routes: jobs ------------------------------------------------------------

get('/api/jobs', ({ url }) => jobs.listJobs(url.searchParams.get('botId') ?? undefined));

get('/api/bots/:id/jobs', ({ params }) => {
  if (!store.getBot(params.id!)) notFound('no such bot');
  return jobs.listJobs(params.id);
});

post('/api/bots/:id/jobs', async ({ params, body }) => {
  if (!store.getBot(params.id!)) notFound('no such bot');
  const input = await body();
  try {
    return jobs.createJob({ botId: params.id!, title: input.title, outcome: input.outcome, acceptance: input.acceptance });
  } catch (err) {
    bad(err instanceof Error ? err.message : 'could not create the job');
  }
});

patch('/api/jobs/:id', async ({ params, body }) => {
  const input = await body();
  const job = jobs.updateJob(params.id!, {
    title: 'title' in input ? input.title : undefined,
    outcome: 'outcome' in input ? input.outcome : undefined,
    acceptance: 'acceptance' in input ? input.acceptance : undefined,
    progress: 'progress' in input ? input.progress : undefined,
    remaining: 'remaining' in input ? input.remaining : undefined,
    artifact: 'artifact' in input ? input.artifact : undefined,
  });
  return job ?? notFound('no such job');
});

post('/api/jobs/:id/resume', ({ params }) => jobs.resumeJob(params.id!) ?? notFound('that job cannot be resumed'));

post('/api/jobs/:id/cancel', ({ params }) => jobs.cancelJob(params.id!) ?? notFound('no such job'));

post('/api/jobs/:id/handoff', async ({ params, body }) => {
  const input = await body();
  const result = jobs.handoffJob(params.id!, String(input.toBotId ?? ''));
  if (!result.ok) bad(result.reason);
  return result;
});

get('/api/jobs/:id/log', ({ params }) => {
  if (!jobs.getJob(params.id!)) notFound('no such job');
  return jobs.listWorkLog(params.id!);
});

post('/api/jobs/:id/schedule', async ({ params, body }) => {
  const job = jobs.getJob(params.id!) ?? notFound('no such job');
  if (job.routineId) {
    const existing = routines.getRoutine(job.routineId);
    if (existing) return existing;
  }
  if (job.status === 'handed-off' || job.status === 'cancelled') bad('that job is already closed');
  const input = await body();
  const time = typeof input.time === 'string' && /^\d{2}:\d{2}$/.test(input.time) ? input.time : '09:00';
  const weekdays = Array.isArray(input.weekdays) && input.weekdays.length ? input.weekdays.map(Number) : [1, 2, 3, 4, 5];
  let schedule: RoutineSchedule;
  try {
    schedule = routines.parseSchedule({ kind: 'daily', time, weekdays });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'invalid schedule');
  }
  let routine: Routine;
  try {
    routine = routines.createBoundRoutine({
      name: job.title,
      prompt: job.outcome,
      botId: job.botId,
      runOn: 'harnessbot',
      enabled: true,
      schedule,
      durationMinutes: 30,
      jobId: job.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'could not create the routine';
    if (message === 'jobId must be a job on this bot' || message === 'this job already has a schedule') bad(message);
    throw err;
  }
  broadcast('routine', routine);
  return routine;
});

post('/api/routines/runs/:runId/confirm', async ({ params }) => {
  const run = (await routines.confirmCatchUp(params.runId!)) ?? notFound('no catch-up run');
  broadcast('routine.run', run);
  return run;
});

post('/api/routines/:id/spend-confirm', ({ params }) => {
  const routine = routines.confirmRoutineSpend(params.id!) ?? notFound('no such routine');
  broadcast('routine', routine);
  return routine;
});

get('/api/routines/review', () => routines.listReviewRuns());

post('/api/routines/:id/run', async ({ params }) => {
  const routine = routines.getRoutine(params.id!) ?? notFound('no such routine');
  const run = await routines.runRoutine(routine, { manual: true });
  broadcast('routine.run', run);
  return run;
});

get('/api/calendar-calls', ({ url }) => {
  const from = Number(url.searchParams.get('from') ?? 0) || undefined;
  const to = Number(url.searchParams.get('to') ?? 0) || undefined;
  return routines.listRuns({ botId: url.searchParams.get('botId') ?? undefined, from, to });
});

get('/api/webhooks', () => listWebhooks());

post('/api/webhooks', async ({ body }) => {
  const input = await body();
  if (!input.routineId) bad('routineId is required');
  const { record, secret } = createWebhook(input.name ?? 'Webhook', input.routineId);
  const port = process.env.HB_WEBHOOK_PORT ?? PORT + 1;
  // Shown exactly once. There is no route that can read it back.
  return {
    ...record,
    secretHash: undefined,
    secret,
    url: `http://127.0.0.1:${port}/hooks/${secret}`,
    hint: 'Prefer sending the secret as an Authorization: Bearer header.',
  };
});

post('/api/webhooks/:id/rotate', ({ params }) => {
  const secret = rotateWebhook(params.id!) ?? notFound('no such webhook');
  const port = process.env.HB_WEBHOOK_PORT ?? PORT + 1;
  // Same one-time shape as create: the old secret stops working the moment this returns.
  return { secret, url: `http://${HOST}:${port}/hooks/${secret}` };
});

del('/api/webhooks/:id', ({ params }) => {
  deleteWebhook(params.id!);
  return { ok: true };
});

// -- routes: voice -----------------------------------------------------------

get('/api/tts/voices', async () => ({ configured: tts.ttsConfigured(), voices: await tts.listVoices().catch(() => []) }));

post('/api/tts/prepare', async ({ body }) => {
  const input = await body();
  return { text: tts.speechFriendly(String(input.text ?? '')) };
});

post('/api/tts/speak', async ({ body, res }) => {
  const input = await body();
  const voice = input.voice || getConfig().voice;
  const { audio, mime } = await tts.speak(String(input.text ?? ''), voice);
  res.writeHead(200, { 'content-type': mime, 'content-length': audio.length });
  res.end(audio);
  return undefined;
});

// -- routes: internal (bot-originated tool calls) ----------------------------

/**
 * These are called by a bot's own MCP proxies, not by the app. They carry a per-boot
 * bearer so that "any local process" is not the same as "this bot".
 */
function requireInternalBot(req: http.IncomingMessage): string {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const botId = botForToken(token);
  if (!botId) throw new HttpError(401, 'unauthorized');
  return botId;
}

post('/api/internal/list-bots', ({ req }) => {
  const callerId = requireInternalBot(req);
  return store
    .listBots()
    .filter((b) => !b.hidden && b.id !== callerId && b.peerTools !== false)
    .map((b) => ({
      id: b.id,
      name: b.name,
      title: b.title,
      description: (b.description ?? '').slice(0, 160),
      section: b.section ?? '',
      activity: b.activity,
      reportsTo: b.reportsTo ? (store.getBot(b.reportsTo)?.name ?? null) : null,
      chiefOfStaff: b.chiefOfStaff === true,
    }));
});

post('/api/internal/ask-bot', async ({ req, body }) => {
  const callerId = requireInternalBot(req);
  const input = await body();
  return turns.contactPeer({
    callerId,
    targetId: typeof input.botId === 'string' ? input.botId : undefined,
    name: typeof input.name === 'string' ? input.name : undefined,
    text: String(input.text ?? ''),
    kind: input.kind === 'delegate' ? 'delegate' : 'ask',
  });
});

post('/api/internal/memory', async ({ req, body }) => {
  const botId = requireInternalBot(req);
  const input = await body();
  if (input.scope === 'section' && !memory.canWriteSection(input.sectionId)) {
    throw new HttpError(403, 'section memory requires a user grant');
  }
  return memory.addMemory({ ...input, botId, source: input.source ?? 'bot_inferred' });
});

post('/api/internal/stage-skill', async ({ req, body }) => {
  const botId = requireInternalBot(req);
  const input = await body();
  const staged = skills.stageSkill(botId, input.name, input.summary ?? '', input.body ?? '');
  const bot = store.getBot(botId)!;
  // Staged, not installed. The card is what installs it, and only after a confirm.
  store.appendMessage(bot.threadId, {
    role: 'bot',
    kind: 'options',
    card: {
      title: `Save "${staged.name}" as a skill?`,
      subtitle: staged.summary,
      options: [
        { id: 'deny', label: 'Discard', destructive: true },
        { id: 'confirm', label: 'Save skill' },
      ],
      skillRequest: { name: staged.name, summary: staged.summary, sha256: staged.sha256, staged: true },
    },
  });
  return { staged: true, sha256: staged.sha256 };
});

post('/api/internal/request-credential', async ({ req, body }) => {
  const botId = requireInternalBot(req);
  const input = await body();
  if (!CREDENTIAL_TARGETS.includes(input.target)) throw new HttpError(403, 'credential target is not allowlisted');
  const bot = store.getBot(botId)!;
  const message = store.appendMessage(bot.threadId, {
    role: 'bot',
    kind: 'secret',
    secret: { target: input.target, label: input.label ?? input.target, reason: String(input.reason ?? '').slice(0, 500) },
  });
  return { messageId: message.id };
});

post('/api/internal/connectors', async ({ req, body }) => {
  const botId = requireInternalBot(req);
  const input = await body();
  const card = connectors.requestConnection(botId, input.slug, input.reason ?? '', input.resumeKey ?? randomUUID());
  return { card };
});

post('/api/internal/computer-control', async ({ req, body }) => {
  const botId = requireInternalBot(req);
  const input = await body();
  const bot = store.getBot(botId) ?? notFound('no such bot');
  const placement = computer.resolvePlacement(bot);
  const held = computer.isHeld(botId);
  // Counting happens only when the driver is about to act on this computer.
  const actions =
    input.act === true && !held && placement.available && placement.backend === 'host'
      ? computer.countAction(botId)
      : computer.peekActions(botId);
  return { held, placement, actions, maxActions: computer.MAX_COMPUTER_ACTIONS };
});

// -- server ------------------------------------------------------------------

/** Only loopback Host headers. Otherwise a public DNS name could point at 127.0.0.1. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return true;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** True when `file` is `root` or a descendant. `startsWith` is not safe on Windows (`ui` vs `ui2`). */
function containedIn(root: string, file: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const rel = path.relative(resolvedRoot, resolvedFile);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function serveStatic(pathname: string, res: http.ServerResponse): boolean {
  if (!STATIC_DIR) return false;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = path.resolve(STATIC_DIR, rel);
  if (!containedIn(STATIC_DIR, file)) return false;
  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!exists && staticMiss(pathname) === 'missing') return false;
  const target = exists ? file : path.join(STATIC_DIR, 'index.html');
  if (!containedIn(STATIC_DIR, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const body = fs.readFileSync(target);
  const ext = path.extname(target);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
  return true;
}

/**
 * GET / with no UI to serve. A JSON 404 is what Hermes Agent's preview pane
 * rendered as `{"error":"not found"}`; this is still not the product, but it is
 * a page a browser can show and a sentence a human can act on.
 */
function serveRootFallback(res: http.ServerResponse, headOnly: boolean): void {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>HarnessBot</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; background: #111; color: #e8e8e8; }
    main { max-width: 40rem; margin: 12vh auto; padding: 0 1.5rem; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p { color: #b8b8b8; }
    code { font: 13px/1.4 ui-monospace, Consolas, monospace; background: #1c1c1c; padding: 0.1em 0.35em; border-radius: 4px; }
    a { color: #8cb4ff; }
  </style>
</head>
<body>
  <main>
    <h1>HarnessBot is running</h1>
    <p>This origin is the harness API. The interface is not being served here because no built UI was found.</p>
    <p>Open <a href="http://127.0.0.1:5199/"><code>http://127.0.0.1:5199/</code></a> if you started <code>pnpm dev:all</code>, or run <code>node scripts/build-hermes-plugin.mjs</code> and restart so GET <code>/</code> serves the product.</p>
    <p><a href="/api/health">Health</a></p>
  </main>
</body>
</html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(headOnly ? undefined : body);
}

export const server = http.createServer((req, res) => {
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'non-loopback Host header refused' }));
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad request' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const found = match(req.method ?? 'GET', url.pathname);
  if (!found) {
    if (!url.pathname.startsWith('/api/') && serveStatic(url.pathname, res)) return;
    const method = req.method ?? 'GET';
    if ((url.pathname === '/' || url.pathname === '') && (method === 'GET' || method === 'HEAD')) {
      serveRootFallback(res, method === 'HEAD');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let bodyPromise: Promise<any> | null = null;
  const ctx: Ctx = {
    req,
    res,
    url,
    params: found.params,
    body: () => (bodyPromise ??= readJsonBody(req)),
  };

  void Promise.resolve()
    .then(() => found.handler(ctx))
    .then((result) => {
      if (res.headersSent || result === undefined) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? null));
    })
    .catch((err: unknown) => {
      if (res.headersSent) return;
      const status = err instanceof HttpError ? err.status : 500;
      const messageText = err instanceof Error ? err.message : String(err);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: messageText }));
    });
});

export async function start(port = PORT): Promise<http.Server> {
  registerBuiltInDrivers(registry);
  await registry.reload();
  registry.watchConfig();
  turns.startEventRouting();
  routines.startScheduler();
  workflows.startWorkflowScheduler();
  jobs.startJobQueue();
  vm.startIdleReaper();
  for (const bot of store.listBots()) mintInternalToken(bot.id);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  startWebhookServer();
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  void start().then(() => {
    process.stdout.write(`harness  http://${HOST}:${PORT}\n`);
    process.stdout.write(`webhooks http://${HOST}:${process.env.HB_WEBHOOK_PORT ?? PORT + 1}  (health + hooks only)\n`);
    if (hasIndexHtml(STATIC_DIR)) {
      process.stdout.write(`ui       http://${HOST}:${PORT}/  (${STATIC_DIR})\n`);
    } else {
      process.stdout.write(`ui       not served on this origin (set HB_STATIC_DIR, or open Vite on :5199)\n`);
    }
    process.stdout.write(`data     ${DATA_DIR}\n`);
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  const shutdown = (): void => {
    void registry.disposeAll().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
