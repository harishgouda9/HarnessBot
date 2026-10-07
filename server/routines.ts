import type { Routine, RoutineRun, RoutineSchedule, WebhookRecord } from '../shared/types.ts';
import { evaluateSpend } from './spend.ts';
import { dataPath, newId, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { redactSecretsInText } from './redact.ts';
import { bindRoutine, blockJob, claimForRun, finishJobFromThread, getJob, jobPrompt, normalizeWorkFolder } from './jobs.ts';
import { holdRoutineThread, releaseRoutineThread } from './routine-hold.ts';
import { store } from './store.ts';
import { isTurnActive, sendToBot, waitForSettle } from './turns.ts';

/**
 * Routines and their receipts (HB-PRD-001 F-AUTO-01/02).
 *
 * Each run starts a *fresh task* on the bot rather than appending to whatever the
 * user was doing, so a 7am standup never inherits last night's context or cwd. A run
 * that was due while the app was closed is `missed`, not silently run late.
 */

interface RoutinesFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
}

interface WebhooksFile {
  version: 1;
  webhooks: WebhookRecord[];
  deliveries: { id: string; webhookId: string; at: number; runId?: string }[];
}

const ROUTINES_FILE = dataPath('routines.json');
const WEBHOOKS_FILE = dataPath('webhooks.json');
const MAX_RUNS = 2000;

function load(): RoutinesFile {
  return readJsonSafe<RoutinesFile>(ROUTINES_FILE, { version: 1, routines: [], runs: [] });
}

function save(file: RoutinesFile): void {
  file.runs = file.runs.slice(-MAX_RUNS);
  writeJsonAtomic(ROUTINES_FILE, file);
}

export function loadWebhooks(): WebhooksFile {
  return readJsonSafe<WebhooksFile>(WEBHOOKS_FILE, { version: 1, webhooks: [], deliveries: [] });
}

export function saveWebhooks(file: WebhooksFile): void {
  file.deliveries = file.deliveries.slice(-500);
  writeJsonAtomic(WEBHOOKS_FILE, file);
}

/** A due time older than this was missed while the process was stopped. */
export const CATCH_UP_GRACE_MS = 5 * 60_000;

export function computeNextRun(schedule: RoutineSchedule, from = Date.now()): number | null {
  if (schedule.kind === 'once') return schedule.at > from ? schedule.at : null;

  if (schedule.kind === 'interval') {
    const step = schedule.everyMinutes * 60_000;
    if (!Number.isFinite(step) || step < 60_000) return null;
    return from + step;
  }

  if (schedule.kind === 'monthly') return nextMonthly(schedule.day, schedule.time, from);

  const [hh, mm] = schedule.time.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const weekdays = schedule.weekdays.length ? schedule.weekdays : [1, 2, 3, 4, 5];

  // Walk forward a day at a time. Cheap, and correct across DST because each
  // candidate is built from local calendar fields rather than by adding 24h.
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    day.setHours(hh ?? 0, mm ?? 0, 0, 0);
    if (day.getTime() > from && weekdays.includes(day.getDay())) return day.getTime();
  }
  return null;
}

/** The next calendar day-of-month at `time`. Months that lack that day are skipped. */
function nextMonthly(day: number, time: string, from: number): number | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const hours = Number(time.split(':')[0]);
  const minutes = Number(time.split(':')[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(from);
    candidate.setDate(1);
    candidate.setMonth(candidate.getMonth() + offset);
    const daysInMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
    if (day > daysInMonth) continue;
    candidate.setDate(day);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > from) return candidate.getTime();
  }
  return null;
}

/**
 * `wait` is not due. `run` is due and the process was up. `catch-up` was due
 * while the process was stopped and must not run on its own.
 */
export function dueDecision(nextRunAt: number | null, now: number, graceMs = CATCH_UP_GRACE_MS): 'wait' | 'run' | 'catch-up' {
  if (nextRunAt === null || !Number.isFinite(nextRunAt)) return 'wait';
  if (nextRunAt > now) return 'wait';
  if (now - nextRunAt > graceMs) return 'catch-up';
  return 'run';
}

export function parseSchedule(input: unknown): RoutineSchedule {
  if (!input || typeof input !== 'object') throw new Error('schedule is required');
  const schedule = input as Partial<RoutineSchedule> & { everyMinutes?: unknown; day?: unknown; time?: unknown; weekdays?: unknown; at?: unknown };
  if (schedule.kind === 'once') {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error('once schedule needs a time');
    return { kind: 'once', at };
  }
  if (schedule.kind === 'daily') {
    const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays.map((day) => Number(day)).filter((day) => day >= 0 && day <= 6) : [];
    return { kind: 'daily', time: String(schedule.time ?? ''), weekdays };
  }
  if (schedule.kind === 'interval') {
    const everyMinutes = Number(schedule.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) throw new Error('interval needs everyMinutes >= 1');
    return { kind: 'interval', everyMinutes };
  }
  if (schedule.kind === 'monthly') {
    const day = Number(schedule.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('monthly day must be 1-31');
    return { kind: 'monthly', day, time: String(schedule.time ?? '') };
  }
  throw new Error('unknown schedule');
}

function advanceSchedule(routine: Routine, from: number): void {
  if (routine.schedule.kind === 'once') {
    routine.enabled = false;
    routine.nextRunAt = null;
    return;
  }
  routine.nextRunAt = computeNextRun(routine.schedule, from);
}

export function listRoutines(): Routine[] {
  return load().routines;
}

export function listRuns(filter?: { botId?: string; from?: number; to?: number; status?: RoutineRun['status'][] }): RoutineRun[] {
  return load().runs.filter(
    (r) =>
      (!filter?.botId || r.botId === filter.botId) &&
      (!filter?.from || r.scheduledFor >= filter.from) &&
      (!filter?.to || r.scheduledFor <= filter.to) &&
      (!filter?.status || filter.status.includes(r.status)),
  );
}

/** Completed, failed, and catch-up runs the user still has to look at. */
export function listReviewRuns(): RoutineRun[] {
  return listRuns({ status: ['completed', 'failed', 'catch-up'] });
}

export function routineSpendStatus(routine: Routine): { spentUsd: number; capUsd: number | null; verdict: ReturnType<typeof evaluateSpend> } {
  const spentUsd = routineSpentUsd(routine.id);
  return {
    spentUsd,
    capUsd: routine.spendCapUsd ?? null,
    verdict: evaluateSpend({ spentUsd, capUsd: routine.spendCapUsd, confirmedUsd: routine.spendConfirmedUsd }),
  };
}

function routineSpentUsd(routineId: string): number {
  let total = 0;
  for (const run of listRuns({ botId: undefined }).filter((run) => run.routineId === routineId && run.threadId)) {
    const bot = store.getBot(run.botId);
    const task = bot?.tasks?.find((item) => item.threadId === run.threadId);
    total += task?.usage?.costUsd ?? 0;
  }
  return total;
}

export function createRoutine(input: Omit<Routine, 'id' | 'nextRunAt' | 'createdAt' | 'updatedAt'>): Routine {
  const file = load();
  const routine: Routine = {
    ...input,
    id: newId('rt'),
    nextRunAt: input.enabled ? computeNextRun(input.schedule) : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  file.routines.push(routine);
  save(file);
  return routine;
}

/**
 * Link a routine to a job only after the job checks out. A bad jobId must not
 * leave a routine saved behind a 400.
 */
export function createBoundRoutine(input: Omit<Routine, 'id' | 'nextRunAt' | 'createdAt' | 'updatedAt'>): Routine {
  const requested = typeof input.jobId === 'string' ? input.jobId.trim() : '';
  let jobId: string | undefined;
  if (requested) {
    const job = getJob(requested);
    if (!job || job.botId !== input.botId) throw new Error('jobId must be a job on this bot');
    if (job.routineId && getRoutine(job.routineId)) throw new Error('this job already has a schedule');
    jobId = job.id;
  }
  const routine = createRoutine({ ...input, jobId });
  if (jobId) bindRoutine(jobId, routine.id);
  return routine;
}

export function updateRoutine(id: string, patch: Partial<Routine>): Routine | null {
  const file = load();
  const routine = file.routines.find((r) => r.id === id);
  if (!routine) return null;
  const reschedule = 'schedule' in patch || 'enabled' in patch;
  Object.assign(routine, patch, { updatedAt: Date.now() });
  if (reschedule) routine.nextRunAt = routine.enabled ? computeNextRun(routine.schedule) : null;
  save(file);
  return routine;
}

export function deleteRoutine(id: string): void {
  const file = load();
  file.routines = file.routines.filter((r) => r.id !== id);
  save(file);
}

/** Drop every routine, receipt, and webhook that belongs to a deleted bot. */
export function deleteRoutinesForBot(botId: string): void {
  const file = load();
  const removed = new Set(file.routines.filter((routine) => routine.botId === botId).map((routine) => routine.id));
  const routines = file.routines.filter((routine) => routine.botId !== botId);
  const runs = file.runs.filter((run) => run.botId !== botId && !removed.has(run.routineId));
  if (routines.length !== file.routines.length || runs.length !== file.runs.length) {
    file.routines = routines;
    file.runs = runs;
    save(file);
  }
  if (!removed.size) return;
  const hooks = loadWebhooks();
  const dropped = new Set(hooks.webhooks.filter((hook) => removed.has(hook.routineId)).map((hook) => hook.id));
  if (!dropped.size) return;
  hooks.webhooks = hooks.webhooks.filter((hook) => !dropped.has(hook.id));
  hooks.deliveries = hooks.deliveries.filter((delivery) => !dropped.has(delivery.webhookId));
  saveWebhooks(hooks);
}

export function getRoutine(id: string): Routine | undefined {
  return load().routines.find((r) => r.id === id);
}

function upsertRun(run: RoutineRun): void {
  const file = load();
  const index = file.runs.findIndex((r) => r.id === run.id);
  if (index >= 0) file.runs[index] = run;
  else file.runs.push(run);
  save(file);

  // The receipt card lives in the chat that created the routine; the work itself
  // runs in its own thread. Opening a receipt takes you to the task, not here.
  if (run.sourceThreadId) {
    const existing = store
      .listMessages(run.sourceThreadId)
      .find((m) => m.kind === 'routine.run' && m.routineRun?.runId === run.id);
    const card = {
      runId: run.id,
      routineId: run.routineId,
      routineName: run.routineName,
      status: run.status,
      threadId: run.threadId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      output: run.output,
    };
    if (existing) store.patchMessage(run.sourceThreadId, existing.id, { routineRun: card });
    else store.appendMessage(run.sourceThreadId, { role: 'bot', kind: 'routine.run', routineRun: card });
  }
}

export async function runRoutine(
  routine: Routine,
  opts: { manual?: boolean; triggerSource?: RoutineRun['triggerSource']; webhookId?: string; deliveryId?: string; scheduledFor?: number } = {},
): Promise<RoutineRun> {
  const run: RoutineRun = {
    id: newId('run'),
    routineId: routine.id,
    routineName: routine.name,
    prompt: routine.prompt,
    durationMinutes: routine.durationMinutes,
    botId: routine.botId,
    runOn: routine.runOn,
    scheduledFor: opts.scheduledFor ?? Date.now(),
    status: 'queued',
    manual: opts.manual ?? false,
    triggerSource: opts.triggerSource ?? (opts.manual ? 'manual' : 'schedule'),
    webhookId: opts.webhookId,
    deliveryId: opts.deliveryId,
    sourceThreadId: routine.sourceThreadId,
  };
  upsertRun(run);
  return executeRun(routine, run);
}

/**
 * Runs that came due while the process was stopped. Writes a catch-up receipt
 * and moves the schedule forward. Does not start a task.
 */
export function offerCatchUps(now = Date.now(), graceMs = CATCH_UP_GRACE_MS): RoutineRun[] {
  const file = load();
  const offered: RoutineRun[] = [];
  let dirty = false;
  for (const routine of file.routines) {
    if (!routine.enabled || routine.nextRunAt === null) continue;
    if (dueDecision(routine.nextRunAt, now, graceMs) !== 'catch-up') continue;
    const scheduledFor = routine.nextRunAt;
    const already = file.runs.find((run) => run.routineId === routine.id && run.scheduledFor === scheduledFor && run.status === 'catch-up');
    if (!already) {
      const run: RoutineRun = {
        id: newId('run'),
        routineId: routine.id,
        routineName: routine.name,
        prompt: routine.prompt,
        durationMinutes: routine.durationMinutes,
        botId: routine.botId,
        runOn: routine.runOn,
        scheduledFor,
        status: 'catch-up',
        manual: false,
        triggerSource: 'schedule',
        sourceThreadId: routine.sourceThreadId,
      };
      file.runs.push(run);
      offered.push(run);
    }
    advanceSchedule(routine, now);
    dirty = true;
  }
  if (dirty) save(file);
  for (const run of offered) {
    if (run.sourceThreadId) upsertRun(run);
  }
  return offered;
}

/** The user asked for a catch-up. Until this is called the run has no task. */
export async function confirmCatchUp(runId: string): Promise<RoutineRun | null> {
  const run = load().runs.find((item) => item.id === runId);
  if (!run || run.status !== 'catch-up') return null;
  const routine = getRoutine(run.routineId);
  if (!routine) {
    run.status = 'failed';
    run.output = 'The routine no longer exists.';
    run.finishedAt = Date.now();
    upsertRun(run);
    return run;
  }
  return executeRun(routine, run);
}

export function confirmRoutineSpend(routineId: string): Routine | null {
  const routine = getRoutine(routineId);
  if (!routine) return null;
  return updateRoutine(routineId, { spendConfirmedUsd: routineSpentUsd(routineId) });
}

async function executeRun(routine: Routine, run: RoutineRun): Promise<RoutineRun> {
  const spent = routineSpentUsd(routine.id);
  if (evaluateSpend({ spentUsd: spent, capUsd: routine.spendCapUsd, confirmedUsd: routine.spendConfirmedUsd }) === 'block') {
    run.status = 'waiting';
    run.output = 'Spend cap reached. Confirm to continue this routine.';
    upsertRun(run);
    return run;
  }

  const bot = store.getBot(routine.botId);
  if (!bot) {
    run.status = 'failed';
    run.output = 'The bot for this routine no longer exists.';
    run.finishedAt = Date.now();
    upsertRun(run);
    return run;
  }

  // A routine tied to a job resumes that job. The prompt alone is the old path.
  let prompt = routine.prompt;
  const linked = routine.jobId ? getJob(routine.jobId) : undefined;
  if (routine.jobId) {
    if (!linked || linked.botId !== routine.botId) {
      run.status = 'failed';
      run.output = 'This routine is tied to a job that is not on this bot.';
      run.finishedAt = Date.now();
      upsertRun(run);
      return run;
    }
    if (linked.status === 'done' || linked.status === 'cancelled' || linked.status === 'handed-off') {
      run.status = 'completed';
      run.output = `Job is ${linked.status}. The schedule did not start another turn.`;
      run.finishedAt = Date.now();
      upsertRun(run);
      return run;
    }
    claimForRun(linked.id);
    prompt = jobPrompt(getJob(linked.id) ?? linked, routine.prompt, normalizeWorkFolder(bot.workFolder));
  }

  // A fresh task per run: the bot's model, permissions, tools and computer, but
  // none of the previous conversation.
  const task = store.createTask(bot.id, routine.name);
  run.threadId = task?.threadId;
  const folder = normalizeWorkFolder(bot.workFolder);
  if (linked && folder && task) store.updateTask(bot.id, task.threadId, { cwd: folder });
  run.status = 'running';
  run.startedAt = Date.now();
  upsertRun(run);
  if (run.threadId) holdRoutineThread(run.threadId);

  try {
    const sent = await sendToBot({
      botId: bot.id,
      threadId: run.threadId,
      text: prompt,
      source: 'routine',
      origin: { kind: 'routine', id: routine.id, label: routine.name },
    });
    if (sent.error === 'spend-cap') {
      if (routine.jobId) blockJob(routine.jobId, 'Spend cap reached.');
      run.status = 'waiting';
      run.output = 'Spend cap reached. Confirm to continue this routine.';
      run.finishedAt = Date.now();
      upsertRun(run);
      return run;
    }
    const outcome = await waitForSettle(run.threadId!, routine.durationMinutes * 60_000);
    const last = store
      .visiblePath(run.threadId!)
      .filter((m) => m.role === 'bot' && m.kind === 'text')
      .at(-1);
    if (outcome === 'timeout') {
      run.status = 'failed';
      const partial = redactSecretsInText(last?.text ?? '');
      run.output = partial
        ? `The turn was still running when the time limit ended.\n\n${partial}`
        : 'The turn was still running when the time limit ended.';
    } else {
      run.status = 'completed';
      run.output = redactSecretsInText(last?.text ?? '');
    }
    if (routine.jobId && run.threadId) {
      if (outcome === 'timeout') blockJob(routine.jobId, 'The turn was still running when the time limit ended.');
      else finishJobFromThread(routine.jobId, run.threadId);
    }
  } catch (err) {
    run.status = 'failed';
    run.output = redactSecretsInText(String(err));
    if (routine.jobId) blockJob(routine.jobId, String(err));
  } finally {
    // waitForSettle's timer resolves while the turn is still active. Releasing here
    // would let the next computer action on that thread auto-approve.
    if (run.threadId && !isTurnActive(run.threadId)) releaseRoutineThread(run.threadId);
  }
  run.finishedAt = Date.now();
  upsertRun(run);

  const file = load();
  const stored = file.routines.find((item) => item.id === routine.id);
  if (stored) {
    advanceSchedule(stored, Date.now());
    save(file);
  }
  return run;
}

let timer: NodeJS.Timeout | null = null;

/**
 * The scheduler ticks every 30s rather than setting a timer per routine: routines are
 * few, clocks drift, laptops sleep, and a sleeping laptop is exactly the case where a
 * per-routine timer never fires.
 */
export function startScheduler(intervalMs = 30_000): () => void {
  const tick = (): void => {
    const grace = Math.max(intervalMs * 3, CATCH_UP_GRACE_MS);
    // Late runs become catch-up receipts. They do not start until confirmed.
    offerCatchUps(Date.now(), grace);
    const file = load();
    const now = Date.now();
    let dirty = false;
    for (const routine of file.routines) {
      if (!routine.enabled || routine.nextRunAt === null) continue;
      if (dueDecision(routine.nextRunAt, now, grace) !== 'run') continue;

      const scheduledFor = routine.nextRunAt;
      advanceSchedule(routine, now);
      dirty = true;
      void runRoutine(routine, { scheduledFor });
    }
    if (dirty) save(file);
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
