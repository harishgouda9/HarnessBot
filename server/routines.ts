import type { Routine, RoutineRun, RoutineSchedule, WebhookRecord } from '../shared/types.ts';
import { dataPath, newId, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { redactSecretsInText } from './redact.ts';
import { store } from './store.ts';
import { sendToBot, waitForSettle } from './turns.ts';

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

export function computeNextRun(schedule: RoutineSchedule, from = Date.now()): number | null {
  if (schedule.kind === 'once') return schedule.at > from ? schedule.at : null;

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

export function listRoutines(): Routine[] {
  return load().routines;
}

export function listRuns(filter?: { botId?: string; from?: number; to?: number }): RoutineRun[] {
  return load().runs.filter(
    (r) =>
      (!filter?.botId || r.botId === filter.botId) &&
      (!filter?.from || r.scheduledFor >= filter.from) &&
      (!filter?.to || r.scheduledFor <= filter.to),
  );
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

export function updateRoutine(id: string, patch: Partial<Routine>): Routine | null {
  const file = load();
  const routine = file.routines.find((r) => r.id === id);
  if (!routine) return null;
  Object.assign(routine, patch, { updatedAt: Date.now() });
  routine.nextRunAt = routine.enabled ? computeNextRun(routine.schedule) : null;
  save(file);
  return routine;
}

export function deleteRoutine(id: string): void {
  const file = load();
  file.routines = file.routines.filter((r) => r.id !== id);
  save(file);
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
  const bot = store.getBot(routine.botId);
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

  if (!bot) {
    run.status = 'failed';
    run.output = 'The bot for this routine no longer exists.';
    run.finishedAt = Date.now();
    upsertRun(run);
    return run;
  }

  // A fresh task per run: the bot's model, permissions, tools and computer, but
  // none of the previous conversation.
  const task = store.createTask(bot.id, routine.name);
  run.threadId = task?.threadId;
  run.status = 'running';
  run.startedAt = Date.now();
  upsertRun(run);

  try {
    await sendToBot({ botId: bot.id, threadId: run.threadId, text: routine.prompt, source: 'routine' });
    await waitForSettle(run.threadId!, routine.durationMinutes * 60_000);
    const last = store
      .visiblePath(run.threadId!)
      .filter((m) => m.role === 'bot' && m.kind === 'text')
      .at(-1);
    run.status = 'completed';
    run.output = redactSecretsInText(last?.text ?? '');
  } catch (err) {
    run.status = 'failed';
    run.output = redactSecretsInText(String(err));
  }
  run.finishedAt = Date.now();
  upsertRun(run);

  const file = load();
  const stored = file.routines.find((r) => r.id === routine.id);
  if (stored && stored.schedule.kind === 'daily') {
    stored.nextRunAt = computeNextRun(stored.schedule);
    save(file);
  } else if (stored && stored.schedule.kind === 'once') {
    stored.enabled = false;
    stored.nextRunAt = null;
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
    const file = load();
    const now = Date.now();
    let dirty = false;
    for (const routine of file.routines) {
      if (!routine.enabled || routine.nextRunAt === null) continue;
      if (routine.nextRunAt > now) continue;

      // More than one interval late means the process was not running when it was
      // due. That is a `missed` receipt, not a late run.
      const lateBy = now - routine.nextRunAt;
      if (lateBy > Math.max(intervalMs * 3, 5 * 60_000)) {
        upsertRun({
          id: newId('run'),
          routineId: routine.id,
          routineName: routine.name,
          prompt: routine.prompt,
          durationMinutes: routine.durationMinutes,
          botId: routine.botId,
          runOn: routine.runOn,
          scheduledFor: routine.nextRunAt,
          status: 'missed',
          manual: false,
          triggerSource: 'schedule',
          sourceThreadId: routine.sourceThreadId,
        });
        routine.nextRunAt = routine.schedule.kind === 'daily' ? computeNextRun(routine.schedule) : null;
        if (routine.schedule.kind === 'once') routine.enabled = false;
        dirty = true;
        continue;
      }

      const scheduledFor = routine.nextRunAt;
      routine.nextRunAt = routine.schedule.kind === 'daily' ? computeNextRun(routine.schedule) : null;
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
