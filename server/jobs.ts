import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { JOB_APPROVAL_LINE, type JobArtifact, type JobRecord, type JobStatus, type WorkLogEntry, type WorkLogKind } from '../shared/types.ts';
import { notify } from './notifications.ts';
import { dataPath, newId, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { redactSecretsInText } from './redact.ts';
import { holdRoutineThread, releaseRoutineThread } from './routine-hold.ts';
import { store } from './store.ts';
import { isTurnActive, sendToBot, waitForSettle } from './turns.ts';

export { JOB_APPROVAL_LINE };

/**
 * Jobs are how a bot does work without a person typing first.
 *
 * A queued job with no routine is picked up when that bot is idle: one turn, then
 * it stops. Done and blocked come from the reply. Send, pay, and delete are not
 * granted by a job or by the folder the job is allowed to use.
 */

const FILE = dataPath('jobs.json');
const MAX_JOBS_PER_BOT = 50;
const MAX_LOG = 200;
const JOB_TURN_MS = 30 * 60_000;

const STATUSES: JobStatus[] = ['queued', 'active', 'blocked', 'handed-off', 'done', 'cancelled'];
const ARTIFACT_KINDS = ['file', 'pull-request', 'document', 'calendar', 'note'] as const;

interface JobsFile {
  version: 1;
  jobs: JobRecord[];
  log: WorkLogEntry[];
}

export const jobEvents = new EventEmitter();

const load = (): JobsFile => readJsonSafe<JobsFile>(FILE, { version: 1, jobs: [], log: [] });
const save = (file: JobsFile): void => writeJsonAtomic(FILE, file);

const clip = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);

export function normalizeWorkFolder(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') return undefined;
  const folder = value.trim();
  if (!folder || folder.length > 500 || /[\0\r\n]/.test(folder)) return undefined;
  if (!path.isAbsolute(folder)) return undefined;
  return path.resolve(folder);
}

export function listJobs(botId?: string): JobRecord[] {
  const jobs = load().jobs;
  const mine = botId ? jobs.filter((job) => job.botId === botId) : jobs;
  return mine.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getJob(id: string): JobRecord | undefined {
  return load().jobs.find((job) => job.id === id);
}

export function listWorkLog(jobId: string): WorkLogEntry[] {
  return load()
    .log.filter((entry) => entry.jobId === jobId)
    .slice()
    .sort((a, b) => a.at - b.at);
}

function write(job: JobRecord): JobRecord {
  const file = load();
  const index = file.jobs.findIndex((item) => item.id === job.id);
  const next = { ...job, updatedAt: Date.now() };
  if (index === -1) file.jobs.push(next);
  else file.jobs[index] = next;
  save(file);
  jobEvents.emit('job', next);
  return next;
}

function log(job: JobRecord, kind: WorkLogKind, text: string): WorkLogEntry {
  const file = load();
  const entry: WorkLogEntry = {
    id: newId('log'),
    jobId: job.id,
    botId: job.botId,
    kind,
    text: redactSecretsInText(clip(text, 500)),
    at: Date.now(),
  };
  file.log.push(entry);
  const mine = file.log.filter((item) => item.jobId === job.id);
  if (mine.length > MAX_LOG) {
    const drop = new Set(mine.slice(0, mine.length - MAX_LOG).map((item) => item.id));
    file.log = file.log.filter((item) => !drop.has(item.id));
  }
  save(file);
  jobEvents.emit('log', entry);
  return entry;
}

export function createJob(input: {
  botId: string;
  title: string;
  outcome: string;
  acceptance: string;
  workflowId?: string;
  workflowRunId?: string;
  workflowStep?: number;
  handedFrom?: string;
}): JobRecord {
  const bot = store.getBot(input.botId);
  if (!bot) throw new Error('no such bot');
  if (load().jobs.filter((job) => job.botId === input.botId && job.status !== 'cancelled').length >= MAX_JOBS_PER_BOT) {
    throw new Error('this bot already has as many jobs as it can hold');
  }
  const title = clip(input.title, 200);
  const outcome = clip(input.outcome, 2000);
  const acceptance = clip(input.acceptance, 2000);
  if (!title || !outcome || !acceptance) throw new Error('a job needs a title, an outcome, and a definition of done');
  const now = Date.now();
  const job: JobRecord = {
    id: newId('job'),
    botId: input.botId,
    title,
    outcome,
    acceptance,
    status: 'queued',
    progress: '',
    remaining: '',
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowStep !== undefined ? { workflowStep: input.workflowStep } : {}),
    ...(input.handedFrom ? { handedFrom: input.handedFrom } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const saved = write(job);
  log(saved, 'note', `Queued: ${saved.title}`);
  return saved;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<JobRecord, 'title' | 'outcome' | 'acceptance' | 'progress' | 'remaining' | 'artifact'>>,
): JobRecord | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  const next: JobRecord = { ...job };
  if (patch.title !== undefined) next.title = clip(patch.title, 200) || job.title;
  if (patch.outcome !== undefined) next.outcome = clip(patch.outcome, 2000);
  if (patch.acceptance !== undefined) next.acceptance = clip(patch.acceptance, 2000);
  if (patch.progress !== undefined) next.progress = clip(patch.progress, 2000);
  if (patch.remaining !== undefined) next.remaining = clip(patch.remaining, 2000);
  if (patch.artifact !== undefined) next.artifact = sanitizeArtifact(patch.artifact);
  return write(next);
}

export function sanitizeArtifact(value: unknown): JobArtifact | undefined {
  if (value == null || value === '') return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { kind?: unknown; label?: unknown; href?: unknown };
  if (!ARTIFACT_KINDS.includes(raw.kind as (typeof ARTIFACT_KINDS)[number])) return undefined;
  const label = clip(raw.label, 200);
  if (!label) return undefined;
  const href = clip(raw.href, 1000);
  return { kind: raw.kind as JobArtifact['kind'], label, href: href || undefined };
}

/**
 * Queue it again. Active (paused), blocked, done, and cancelled all come back.
 * A handed-off job stays with the bot who received it.
 */
export function resumeJob(id: string): JobRecord | undefined {
  const job = getJob(id);
  if (!job || job.status === 'handed-off') return undefined;
  if (job.status === 'queued') return job;
  const next = write({ ...job, status: 'queued', finishedAt: undefined });
  log(next, 'note', 'Queued again.');
  return next;
}

export function blockJob(id: string, reason: string): JobRecord | undefined {
  const job = getJob(id);
  if (!job || job.status === 'handed-off' || job.status === 'cancelled' || job.status === 'done') return job;
  const next = write({ ...job, status: 'blocked' });
  log(next, 'blocked', reason);
  return next;
}

export function cancelJob(id: string): JobRecord | undefined {
  const job = getJob(id);
  if (!job || job.status === 'handed-off') return undefined;
  const next = write({ ...job, status: 'cancelled', finishedAt: Date.now() });
  log(next, 'note', 'Cancelled.');
  return next;
}

export function bindRoutine(jobId: string, routineId: string): JobRecord | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  return write({ ...job, routineId });
}

export function unbindRoutine(routineId: string): void {
  for (const job of load().jobs) {
    if (job.routineId === routineId) write({ ...job, routineId: undefined });
  }
}

export function handoffJob(jobId: string, toBotId: string): { ok: true; source: JobRecord; created: JobRecord } | { ok: false; reason: string } {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: 'no such job' };
  if (job.status === 'handed-off' || job.status === 'cancelled') return { ok: false, reason: 'that job is already closed' };
  if (toBotId === job.botId) return { ok: false, reason: 'a job cannot be handed to the same bot' };
  const target = store.getBot(toBotId);
  if (!target || target.hidden) return { ok: false, reason: 'no such bot' };
  if (load().jobs.filter((item) => item.botId === toBotId && item.status !== 'cancelled').length >= MAX_JOBS_PER_BOT) {
    return { ok: false, reason: 'that bot cannot take another job' };
  }

  const source = write({ ...job, status: 'handed-off', handedTo: toBotId, finishedAt: Date.now() });
  log(source, 'handed-off', `Handed to ${target.name}.`);

  const now = Date.now();
  const created = write({
    id: newId('job'),
    botId: toBotId,
    title: source.title,
    outcome: source.outcome,
    acceptance: source.acceptance,
    status: 'queued',
    progress: source.progress,
    remaining: source.remaining,
    artifact: source.artifact,
    handedFrom: source.botId,
    sourceJobId: source.id,
    createdAt: now,
    updatedAt: now,
  });
  const from = store.getBot(source.botId);
  log(created, 'handed-off', `Received from ${from?.name ?? 'another bot'}.`);
  return { ok: true, source, created };
}

export function forgetJobsForBot(botId: string): void {
  const file = load();
  const gone = file.jobs.filter((job) => job.botId === botId).map((job) => job.id);
  if (!gone.length) return;
  const ids = new Set(gone);
  file.jobs = file.jobs.filter((job) => !ids.has(job.id));
  file.log = file.log.filter((entry) => !ids.has(entry.jobId));
  save(file);
  for (const id of gone) jobEvents.emit('job.deleted', { id, botId });
}

export function jobPrompt(job: JobRecord, extra = '', folder?: string): string {
  const lines = [
    'You have a job to do. Do the work in this turn. Do not wait to be asked again.',
    '',
    `Job: ${job.title}`,
    `Outcome: ${job.outcome}`,
    `Done when: ${job.acceptance}`,
    '',
    'Progress so far:',
    job.progress.trim() || 'Nothing recorded yet.',
    '',
    'Still left:',
    job.remaining.trim() || 'Whatever the outcome still needs.',
    '',
    folder
      ? `Working folder (the only folder this job may change): ${folder}`
      : 'No folder grant is set. Do not change files outside a folder this bot was already given.',
    JOB_APPROVAL_LINE,
    '',
    'When you stop, end with exactly one of these lines:',
    'JOB_STATUS: done',
    'JOB_STATUS: blocked',
    'JOB_STATUS: paused',
    'Also add, each on its own line, when you have something to record:',
    'JOB_PROGRESS: what you completed',
    'JOB_REMAINING: what is left',
    'JOB_ARTIFACT: file | label | absolute path',
  ];
  if (extra.trim()) {
    lines.push('', 'Also follow this instruction:', extra.trim());
  }
  return lines.join('\n');
}

export interface JobMarkers {
  status?: 'done' | 'blocked' | 'paused';
  progress?: string;
  remaining?: string;
  artifact?: JobArtifact;
}

export function readJobMarkers(text: string): JobMarkers {
  const markers: JobMarkers = {};
  for (const line of text.split(/\r?\n/)) {
    const status = /^JOB_STATUS:\s*(done|blocked|paused)\s*$/i.exec(line.trim());
    if (status) {
      markers.status = status[1]!.toLowerCase() as JobMarkers['status'];
      continue;
    }
    const progress = /^JOB_PROGRESS:\s*(.+)$/i.exec(line.trim());
    if (progress) {
      markers.progress = clip(progress[1], 2000);
      continue;
    }
    const remaining = /^JOB_REMAINING:\s*(.+)$/i.exec(line.trim());
    if (remaining) {
      markers.remaining = clip(remaining[1], 2000);
      continue;
    }
    const artifact = /^JOB_ARTIFACT:\s*(file|pull-request|document|calendar|note)\s*\|\s*(.*)$/i.exec(line.trim());
    if (artifact) {
      const kind = artifact[1]!.toLowerCase() as JobArtifact['kind'];
      const rest = artifact[2] ?? '';
      const split = rest.split('|');
      const label = clip(split[0], 200);
      const href = clip(split.slice(1).join('|'), 1000);
      if (label) markers.artifact = { kind, label, href: href || undefined };
    }
  }
  return markers;
}

/** True when `file` is `grant` or a path inside it. */
export function pathInside(grant: string, file: string): boolean {
  const root = path.resolve(grant);
  const target = path.resolve(file);
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function decideJobOutcome(
  job: JobRecord,
  reply: string,
  opts: { fileExists: (href: string) => boolean; folder?: string },
): { status: JobStatus; progress: string; remaining: string; artifact?: JobArtifact; note: string } {
  const markers = readJobMarkers(reply);
  const artifact = markers.artifact ?? job.artifact;
  let progress = markers.progress ?? (reply.trim() ? clip(reply, 500) : job.progress);
  const remaining = markers.remaining ?? job.remaining;
  let status: JobStatus = 'active';
  let note = 'Paused. It will not run again until you resume it or a schedule fires.';

  if (markers.status === 'blocked') {
    status = 'blocked';
    note = 'Blocked. It stopped and is waiting on you.';
  } else if (markers.status === 'done') {
    status = 'done';
    note = 'Finished.';
  }

  // Only a claimed "done" is checked. A pause, or no marker, must not turn into blocked
  // because an older file path is missing — that would start the job again by itself.
  if (status === 'done' && artifact?.kind === 'file') {
    const href = artifact.href ?? '';
    const absolute = Boolean(href) && path.isAbsolute(href);
    const exists = absolute && opts.fileExists(path.resolve(href));
    const inside = !opts.folder || (absolute && pathInside(opts.folder, href));
    if (!exists || !inside) {
      status = 'blocked';
      note = !exists
        ? `Blocked. The file artifact is not on disk: ${href || '(no path)'}`
        : `Blocked. The file artifact is outside the granted folder: ${href}`;
    }
  }

  if (!markers.status) note = 'No JOB_STATUS line. Left in progress so it does not run again on its own.';

  return { status, progress, remaining, artifact, note };
}

function toolNames(threadId: string): string[] {
  const names = new Set<string>();
  for (const message of store.listMessages(threadId)) {
    if (message.tool?.name) names.add(message.tool.name);
  }
  return [...names];
}

export function claimForRun(jobId: string): JobRecord | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  if (job.status === 'done' || job.status === 'cancelled' || job.status === 'handed-off') return job;
  const next = write({ ...job, status: 'active', startedAt: job.startedAt ?? Date.now(), finishedAt: undefined });
  log(next, 'picked-up', `Picked up: ${next.title}`);
  return next;
}

/** Apply the reply from a finished turn. One turn, then stop. */
export function finishJobFromThread(jobId: string, threadId: string): JobRecord | undefined {
  const job = getJob(jobId);
  // A cancel or a handoff during the turn wins. The late reply must not reopen it.
  if (!job || job.status === 'cancelled' || job.status === 'handed-off' || job.status === 'done') return job;
  const bot = store.getBot(job.botId);
  const reply = store
    .listMessages(threadId)
    .filter((message) => message.role === 'bot' && message.kind === 'text' && message.text)
    .map((message) => message.text ?? '')
    .at(-1) ?? '';
  const folder = normalizeWorkFolder(bot?.workFolder);
  const decision = decideJobOutcome(job, reply, { fileExists: (href) => fs.existsSync(href), folder });
  const finished = decision.status === 'done' || decision.status === 'blocked';
  const next = write({
    ...job,
    status: decision.status,
    progress: decision.progress,
    remaining: decision.remaining,
    artifact: decision.artifact,
    finishedAt: finished ? Date.now() : undefined,
  });
  const tools = toolNames(threadId).filter((name) => name !== 'setup' && name !== 'error' && name !== 'timeout');
  if (tools.length) log(next, 'note', `Tools used: ${tools.join(', ')}`);
  log(next, decision.status === 'done' ? 'finished' : decision.status === 'blocked' ? 'blocked' : 'note', decision.note);
  if (decision.artifact) log(next, 'artifact', `${decision.artifact.kind}: ${decision.artifact.label}${decision.artifact.href ? ` (${decision.artifact.href})` : ''}`);
  if (bot && decision.status === 'blocked') notify(bot, { kind: 'needs-hands', threadId, preview: decision.note });
  if (bot && decision.status === 'done') notify(bot, { kind: 'finished', threadId, preview: `Job done: ${next.title}` });
  return next;
}

function botIsBusy(botId: string): boolean {
  const bot = store.getBot(botId);
  if (!bot) return true;
  if (bot.activity === 'working' || bot.activity === 'waiting-on-you') return true;
  if (isTurnActive(bot.threadId)) return true;
  for (const task of bot.tasks ?? []) {
    if (isTurnActive(task.threadId)) return true;
  }
  return false;
}

/** Oldest queued job that no schedule owns. The idle queue is the only caller. */
export function nextIdleJob(botId: string): JobRecord | undefined {
  return load()
    .jobs.filter((job) => job.botId === botId && job.status === 'queued' && !job.routineId)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

const running = new Set<string>();

export async function runQueuedJob(botId: string, jobId: string): Promise<void> {
  const job = getJob(jobId);
  const bot = store.getBot(botId);
  if (!job || !bot || job.botId !== botId || job.status !== 'queued' || job.routineId) return;
  if (botIsBusy(botId)) return;

  const claimed = claimForRun(job.id);
  if (!claimed || claimed.status !== 'active') return;
  const task = store.createTask(bot.id, claimed.title.slice(0, 60));
  if (!task) {
    blockJob(claimed.id, 'Could not open a task for this job.');
    return;
  }
  const folder = normalizeWorkFolder(bot.workFolder);
  if (folder) store.updateTask(bot.id, task.threadId, { cwd: folder });
  holdRoutineThread(task.threadId);
  const current = getJob(job.id) ?? claimed;
  try {
    const sent = await sendToBot({
      botId: bot.id,
      threadId: task.threadId,
      text: jobPrompt(current, '', folder),
      source: 'routine',
      origin: current.handedFrom
        ? { kind: 'handoff', id: current.workflowId ?? current.sourceJobId ?? current.handedFrom, label: current.title }
        : { kind: 'job', id: current.workflowId ?? current.id, label: current.title },
    });
    if (sent.error) {
      if (!isTurnActive(task.threadId)) releaseRoutineThread(task.threadId);
      blockJob(job.id, sent.error);
      return;
    }
    const outcome = await waitForSettle(task.threadId, JOB_TURN_MS);
    if (!isTurnActive(task.threadId)) releaseRoutineThread(task.threadId);
    if (outcome === 'timeout' && isTurnActive(task.threadId)) {
      const blocked = blockJob(job.id, 'The turn was still running when the time limit ended.');
      const owner = store.getBot(botId);
      if (owner && blocked?.status === 'blocked') {
        notify(owner, { kind: 'needs-hands', threadId: task.threadId, preview: 'A job is still running and needs you.' });
      }
      return;
    }
    finishJobFromThread(job.id, task.threadId);
  } catch (err) {
    if (!isTurnActive(task.threadId)) releaseRoutineThread(task.threadId);
    blockJob(job.id, String(err));
  }
}

/** Idle bots with a queued job take the oldest one. Scheduled jobs wait for their routine. */
export function pumpQueue(): void {
  for (const bot of store.listBots()) {
    if (bot.hidden || running.has(bot.id) || botIsBusy(bot.id)) continue;
    const job = nextIdleJob(bot.id);
    if (!job) continue;
    running.add(bot.id);
    void runQueuedJob(bot.id, job.id).finally(() => running.delete(bot.id));
  }
}

let timer: NodeJS.Timeout | null = null;

export function startJobQueue(intervalMs = 30_000): () => void {
  const tick = (): void => pumpQueue();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && STATUSES.includes(value as JobStatus);
}
