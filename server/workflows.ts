import { EventEmitter } from 'node:events';
import type { JobArtifact, JobRecord, RoutineSchedule, Workflow, WorkflowRun, WorkflowStep, WorkflowStepResult } from '../shared/types.ts';
import { dataPath, newId, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { cancelJob, createJob, getJob, jobEvents, updateJob } from './jobs.ts';
import { computeNextRun, dueDecision, parseSchedule } from './routines.ts';
import { store } from './store.ts';

/**
 * Workflows are ordered jobs.
 *
 * A step runs through the existing job queue. When it finishes, the next step
 * is queued and receives that step's progress and artifact. A different bot on
 * the next step is a handoff: the new job records who it came from, and that
 * turn does not inherit a chat grant.
 * There is no second runner and no node canvas.
 */

interface WorkflowFile {
  version: 1;
  workflows: Workflow[];
  runs: WorkflowRun[];
}

const FILE = dataPath('workflows.json');
const MAX_STEPS = 8;
const MAX_RUNS = 500;

const load = (): WorkflowFile => readJsonSafe<WorkflowFile>(FILE, { version: 1, workflows: [], runs: [] });

function save(file: WorkflowFile): void {
  const running = file.runs.filter((run) => run.status === 'running');
  const rest = file.runs.filter((run) => run.status !== 'running').slice(-MAX_RUNS);
  file.runs = [...running, ...rest];
  writeJsonAtomic(FILE, file);
}

export const workflowEvents = new EventEmitter();

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function stepsFrom(input: unknown): WorkflowStep[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_STEPS) {
    throw new Error(`a workflow needs 1 to ${MAX_STEPS} steps`);
  }
  return input.map((raw) => {
    const step = raw as {
      botId?: unknown;
      title?: unknown;
      outcome?: unknown;
      acceptance?: unknown;
      id?: unknown;
      onBlocked?: unknown;
    };
    const botId = typeof step.botId === 'string' ? step.botId : '';
    const bot = store.getBot(botId);
    if (!bot || bot.hidden) throw new Error('each step needs a bot on the roster');
    const title = clip(step.title, 200);
    const outcome = clip(step.outcome, 2000);
    const acceptance = clip(step.acceptance, 2000);
    if (!title || !outcome || !acceptance) {
      throw new Error('each step needs a title, an outcome, and a definition of done');
    }
    const id = typeof step.id === 'string' && step.id.startsWith('step_') ? step.id : newId('step');
    const onBlocked = step.onBlocked === 'continue' ? ('continue' as const) : undefined;
    return { id, botId, title, outcome, acceptance, ...(onBlocked ? { onBlocked } : {}) };
  });
}

/** Lines the next job reads as progress. The previous file is named, never inlined. */
function handoffLines(from: JobRecord | undefined, startNote?: string): string[] {
  const lines: string[] = [];
  if (startNote?.trim()) lines.push(`Start with: ${startNote.trim()}`);
  if (!from) return lines;
  if (from.progress.trim()) lines.push(from.progress.trim());
  if (from.artifact) {
    const href = from.artifact.href ? ` | ${from.artifact.href}` : '';
    lines.push(`Previous artifact: ${from.artifact.kind} | ${from.artifact.label}${href}`);
  }
  if (from.remaining.trim()) lines.push(`Still open from the previous step: ${from.remaining.trim()}`);
  if (from.status === 'blocked') lines.push('The previous step blocked. Continue from what it left.');
  return lines;
}

function seedJob(jobId: string, lines: string[], artifact?: JobArtifact): void {
  const progress = lines.map((line) => line.trim()).filter(Boolean).join('\n').slice(0, 2000);
  if (!progress && !artifact) return;
  updateJob(jobId, {
    ...(progress ? { progress } : {}),
    ...(artifact ? { artifact } : {}),
  });
}

function recordStep(run: WorkflowRun, step: WorkflowStep | undefined, job: JobRecord): void {
  if (!step) return;
  const progress = job.progress.trim().slice(0, 500);
  const entry: WorkflowStepResult = {
    index: run.stepIndex,
    stepId: step.id,
    botId: job.botId,
    status: job.status === 'blocked' ? 'blocked' : 'done',
    ...(progress ? { progress } : {}),
    ...(job.artifact ? { artifact: job.artifact } : {}),
    at: Date.now(),
  };
  run.results = [...(run.results ?? []), entry].slice(-24);
}

function queueStep(workflow: Workflow, run: WorkflowRun, index: number, from?: JobRecord, startNote?: string): JobRecord {
  const step = workflow.steps[index];
  if (!step) throw new Error('that step is gone');
  const prev = index > 0 ? workflow.steps[index - 1] : undefined;
  const created = createJob({
    botId: step.botId,
    title: step.title,
    outcome: step.outcome,
    acceptance: step.acceptance,
    workflowId: workflow.id,
    workflowRunId: run.id,
    workflowStep: index,
    handedFrom: prev && prev.botId !== step.botId ? prev.botId : undefined,
  });
  seedJob(created.id, handoffLines(from, index === 0 ? startNote : undefined), from?.artifact);
  return created;
}

function scheduleFrom(input: unknown): RoutineSchedule | undefined {
  if (input == null || input === '' || (typeof input === 'object' && input && (input as { kind?: string }).kind === 'manual')) {
    return undefined;
  }
  return parseSchedule(input);
}

export function listWorkflows(): Workflow[] {
  return load().workflows.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listWorkflowRuns(workflowId?: string): WorkflowRun[] {
  return load()
    .runs.filter((run) => !workflowId || run.workflowId === workflowId)
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 100);
}

export function getRun(id: string): WorkflowRun | undefined {
  return load().runs.find((run) => run.id === id);
}

function emitWorkflow(workflow: Workflow): void {
  workflowEvents.emit('workflow', workflow);
}

function emitRun(run: WorkflowRun): void {
  workflowEvents.emit('workflow.run', run);
}

export function createWorkflow(input: {
  name?: unknown;
  steps?: unknown;
  schedule?: unknown;
  enabled?: unknown;
}): Workflow {
  const name = clip(input.name, 200);
  if (!name) throw new Error('a workflow needs a name');
  const steps = stepsFrom(input.steps);
  const schedule = scheduleFrom(input.schedule);
  const now = Date.now();
  const workflow: Workflow = {
    id: newId('wf'),
    name,
    enabled: input.enabled !== false,
    ...(schedule ? { schedule } : {}),
    nextRunAt: schedule ? computeNextRun(schedule, now) : null,
    steps,
    createdAt: now,
    updatedAt: now,
  };
  const file = load();
  file.workflows.push(workflow);
  save(file);
  emitWorkflow(workflow);
  return workflow;
}

export function updateWorkflow(
  id: string,
  input: { name?: unknown; steps?: unknown; schedule?: unknown; enabled?: unknown },
): Workflow | undefined {
  const file = load();
  const workflow = file.workflows.find((item) => item.id === id);
  if (!workflow) return undefined;
  if ('name' in input) {
    const name = clip(input.name, 200);
    if (!name) throw new Error('a workflow needs a name');
    workflow.name = name;
  }
  if ('steps' in input) workflow.steps = stepsFrom(input.steps);
  if ('enabled' in input) workflow.enabled = input.enabled === true;
  if ('schedule' in input) {
    const schedule = scheduleFrom(input.schedule);
    if (schedule) {
      workflow.schedule = schedule;
      workflow.nextRunAt = computeNextRun(schedule, Date.now());
    } else {
      delete workflow.schedule;
      workflow.nextRunAt = null;
    }
  }
  workflow.updatedAt = Date.now();
  save(file);
  emitWorkflow(workflow);
  return workflow;
}

export function deleteWorkflow(id: string): boolean {
  const file = load();
  const workflow = file.workflows.find((item) => item.id === id);
  if (!workflow) return false;
  for (const run of file.runs) {
    if (run.workflowId !== id || run.status !== 'running') continue;
    run.status = 'cancelled';
    run.finishedAt = Date.now();
    run.note = 'Workflow deleted.';
    if (run.jobId) cancelIfOpen(run.jobId);
    emitRun(run);
  }
  file.workflows = file.workflows.filter((item) => item.id !== id);
  save(file);
  workflowEvents.emit('workflow.deleted', { id });
  return true;
}

function cancelIfOpen(jobId: string): void {
  const job = getJob(jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'active')) return;
  cancelJob(jobId);
}

/** Stop a run that is still going. A queued or active step is cancelled with it. */
export function cancelWorkflowRun(runId: string): WorkflowRun | undefined {
  const file = load();
  const run = file.runs.find((item) => item.id === runId);
  if (!run) return undefined;
  if (run.status !== 'running' && run.status !== 'waiting') return run;
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  run.note = 'Cancelled.';
  if (run.jobId) cancelIfOpen(run.jobId);
  save(file);
  emitRun(run);
  return run;
}

/**
 * Give the current step to another bot. The open job is cancelled and a new one
 * is queued, marked as a handoff, and the step remembers the new bot.
 */
export function handoffRun(runId: string, toBotId: string): WorkflowRun {
  const file = load();
  const run = file.runs.find((item) => item.id === runId);
  if (!run || run.status !== 'running') throw new Error('that run is not in progress');
  const workflow = file.workflows.find((item) => item.id === run.workflowId);
  if (!workflow) throw new Error('workflow is gone');
  const step = workflow.steps[run.stepIndex];
  if (!step) throw new Error('that step is gone');
  const bot = store.getBot(toBotId);
  if (!bot || bot.hidden) throw new Error('pick a bot on the roster');
  const current = run.jobId ? getJob(run.jobId) : undefined;
  if (current && (current.status === 'queued' || current.status === 'active') && current.botId === toBotId) {
    throw new Error('that bot already has this step');
  }
  if (current && current.status !== 'queued' && current.status !== 'active') {
    throw new Error('that step is no longer waiting on a bot');
  }
  const fromId = current?.botId ?? step.botId;
  if (run.jobId) cancelIfOpen(run.jobId);
  let created: JobRecord;
  try {
    created = createJob({
      botId: toBotId,
      title: step.title,
      outcome: step.outcome,
      acceptance: step.acceptance,
      workflowId: workflow.id,
      workflowRunId: run.id,
      workflowStep: run.stepIndex,
      handedFrom: fromId !== toBotId ? fromId : undefined,
    });
  } catch (err) {
    run.status = 'failed';
    run.finishedAt = Date.now();
    run.note = err instanceof Error ? err.message : 'could not hand off the step';
    save(file);
    emitRun(run);
    throw err;
  }
  if (current && (current.progress || current.remaining || current.artifact)) {
    updateJob(created.id, { progress: current.progress, remaining: current.remaining, artifact: current.artifact });
  }
  step.botId = toBotId;
  workflow.updatedAt = Date.now();
  run.jobId = created.id;
  run.note = `Handed step ${run.stepIndex + 1} to ${bot.name}.`;
  save(file);
  emitWorkflow(workflow);
  emitRun(run);
  return run;
}

function runningRun(file: WorkflowFile, workflowId: string): WorkflowRun | undefined {
  return file.runs.find((run) => run.workflowId === workflowId && run.status === 'running');
}

export function runWorkflow(id: string, input?: unknown): WorkflowRun {
  const file = load();
  const workflow = file.workflows.find((item) => item.id === id);
  if (!workflow) throw new Error('no such workflow');
  const existing = runningRun(file, id);
  if (existing) return existing;
  const step = workflow.steps[0];
  if (!step) throw new Error('this workflow has no steps');
  const startNote = clip(input, 500);
  const run: WorkflowRun = {
    id: newId('wfr'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    stepIndex: 0,
    startedAt: Date.now(),
    ...(startNote ? { input: startNote } : {}),
  };
  file.runs.push(run);
  save(file);
  try {
    const job = queueStep(workflow, run, 0, undefined, startNote || undefined);
    run.jobId = job.id;
    run.note = `Step 1 of ${workflow.steps.length} queued.`;
  } catch (err) {
    run.status = 'failed';
    run.finishedAt = Date.now();
    run.note = err instanceof Error ? err.message : 'could not start';
  }
  const fresh = load();
  const stored = fresh.runs.find((item) => item.id === run.id) ?? run;
  stored.jobId = run.jobId;
  stored.status = run.status;
  stored.note = run.note;
  stored.finishedAt = run.finishedAt;
  save(fresh);
  emitRun(stored);
  return stored;
}

/** Queue the same step again after a block, or start a run that waited while the harness was down. */
export function retryWorkflowRun(runId: string): WorkflowRun {
  const file = load();
  const run = file.runs.find((item) => item.id === runId);
  if (!run) throw new Error('no such run');
  if (run.status !== 'failed' && run.status !== 'waiting') throw new Error('that run is not waiting to be tried again');
  if (runningRun(file, run.workflowId)) throw new Error('a run is already in progress');
  const workflow = file.workflows.find((item) => item.id === run.workflowId);
  if (!workflow) throw new Error('workflow is gone');
  const previous = run.jobId ? getJob(run.jobId) : undefined;
  let created: JobRecord;
  try {
    created = queueStep(workflow, run, run.stepIndex, previous, run.input);
  } catch (err) {
    run.note = err instanceof Error ? err.message : 'could not try the step again';
    save(file);
    emitRun(run);
    throw err;
  }
  run.status = 'running';
  run.jobId = created.id;
  delete run.finishedAt;
  run.note = `Step ${run.stepIndex + 1} of ${workflow.steps.length} queued again.`;
  save(file);
  emitRun(run);
  return run;
}

function onJob(job: JobRecord): void {
  if (!job.workflowRunId) return;
  if (job.status !== 'done' && job.status !== 'blocked') return;
  const file = load();
  const run = file.runs.find((item) => item.id === job.workflowRunId);
  if (!run || run.status !== 'running') return;
  if (run.jobId && run.jobId !== job.id) return;
  const workflow = file.workflows.find((item) => item.id === run.workflowId);
  const step = workflow?.steps[run.stepIndex];
  if (step) recordStep(run, step, job);
  if (!workflow || !step) {
    run.status = 'failed';
    run.finishedAt = Date.now();
    run.note = 'Workflow is gone.';
    save(file);
    emitRun(run);
    return;
  }
  if (job.status === 'blocked' && step.onBlocked !== 'continue') {
    run.status = 'failed';
    run.finishedAt = Date.now();
    const why = job.remaining.trim() || job.progress.trim() || 'A step blocked.';
    run.note = clip(`Step ${run.stepIndex + 1} blocked. ${why}`, 240);
    save(file);
    emitRun(run);
    return;
  }
  const nextIndex = run.stepIndex + 1;
  const next = workflow.steps[nextIndex];
  if (!next) {
    run.status = 'completed';
    run.finishedAt = Date.now();
    run.note = 'Finished.';
    save(file);
    emitRun(run);
    return;
  }
  try {
    const created = queueStep(workflow, run, nextIndex, job);
    run.stepIndex = nextIndex;
    run.jobId = created.id;
    run.note = job.status === 'blocked'
      ? `Step ${nextIndex + 1} of ${workflow.steps.length} queued after a blocked step.`
      : `Step ${nextIndex + 1} of ${workflow.steps.length} queued.`;
    save(file);
    emitRun(run);
  } catch (err) {
    run.status = 'failed';
    run.finishedAt = Date.now();
    run.note = err instanceof Error ? err.message : 'could not queue the next step';
    save(file);
    emitRun(run);
  }
}

let watching = false;

export function watchWorkflowJobs(): void {
  if (watching) return;
  watching = true;
  jobEvents.on('job', onJob);
}

watchWorkflowJobs();

/** Due workflows start a run. A time that passed while the process was down waits. */
export function tickWorkflows(now = Date.now()): void {
  const file = load();
  const due: string[] = [];
  let dirty = false;
  for (const workflow of file.workflows) {
    if (!workflow.enabled || !workflow.schedule || workflow.nextRunAt === null) continue;
    const decision = dueDecision(workflow.nextRunAt, now);
    if (decision === 'wait') continue;
    workflow.nextRunAt = computeNextRun(workflow.schedule, now);
    workflow.updatedAt = now;
    dirty = true;
    if (decision === 'catch-up') {
      file.runs.push({
        id: newId('wfr'),
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: 'waiting',
        stepIndex: 0,
        startedAt: now,
        finishedAt: now,
        note: 'This was due while the harness was stopped. Run it when you are back.',
      });
      continue;
    }
    if (!runningRun(file, workflow.id)) due.push(workflow.id);
  }
  if (dirty) save(file);
  for (const id of due) {
    try {
      runWorkflow(id);
    } catch {
      // The run records its own failure. The schedule has already moved on.
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startWorkflowScheduler(intervalMs = 30_000): () => void {
  const tick = (): void => tickWorkflows();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
