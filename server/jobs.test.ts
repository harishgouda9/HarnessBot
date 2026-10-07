import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botDuplicateFields } from './bot-copy.ts';
import { forgetBot } from './forget-bot.ts';
import { saveConfig } from './config.ts';
import { registry } from './harness/registry.ts';
import {
  JOB_APPROVAL_LINE,
  bindRoutine,
  cancelJob,
  createJob,
  decideJobOutcome,
  finishJobFromThread,
  forgetJobsForBot,
  getJob,
  handoffJob,
  jobEvents,
  jobPrompt,
  listJobs,
  listWorkLog,
  nextIdleJob,
  normalizeWorkFolder,
  pathInside,
  pumpQueue,
  readJobMarkers,
  resumeJob,
  runQueuedJob,
  unbindRoutine,
  updateJob,
} from './jobs.ts';
import { routineHoldsApprovals } from './routine-hold.ts';
import {
  CATCH_UP_GRACE_MS,
  confirmCatchUp,
  createBoundRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  offerCatchUps,
  runRoutine,
} from './routines.ts';
import { store } from './store.ts';
import { fakeDriver } from './testing/fake-driver.ts';
import { interrupt, isTurnActive, startEventRouting } from './turns.ts';
import type { JobRecord } from '../shared/types.ts';

function bot(name: string) {
  return store.createBot({ name, modelSelection: { instanceId: 'fake', model: 'fake-1' } });
}

function queued(owner: { id: string }, title = 'Write the notes') {
  return createJob({ botId: owner.id, title, outcome: `Ship ${title}`, acceptance: `${title} is on disk` });
}

const later = () => ({ kind: 'once' as const, at: Date.now() + 86_400_000 });

describe('job markers and stop rule', () => {
  const sample = {
    id: 'job_1',
    botId: 'bot_1',
    title: 'Notes',
    outcome: 'A written note',
    acceptance: 'The note exists',
    status: 'queued',
    progress: '',
    remaining: '',
    createdAt: 1,
    updatedAt: 1,
  } satisfies JobRecord;

  it('keeps the last marker and the rest of an artifact path', () => {
    const markers = readJobMarkers(
      ['JOB_STATUS: done', 'JOB_PROGRESS: first', 'JOB_STATUS: blocked', 'JOB_PROGRESS: second', 'JOB_ARTIFACT: note | summary | extra|bit'].join('\n'),
    );
    expect(markers.status).toBe('blocked');
    expect(markers.progress).toBe('second');
    expect(markers.artifact).toEqual({ kind: 'note', label: 'summary', href: 'extra|bit' });
  });

  it('leaves a reply with no marker in progress so the queue does not run it again', () => {
    const decision = decideJobOutcome(sample, 'I started the outline.', { fileExists: () => true });
    expect(decision.status).toBe('active');
    expect(decision.note).toMatch(/No JOB_STATUS/);
    expect(decision.progress).toContain('outline');
  });

  it('treats paused as in progress, not as a new queue entry', () => {
    const decision = decideJobOutcome(sample, 'JOB_STATUS: paused\nJOB_REMAINING: the last page', { fileExists: () => true });
    expect(decision.status).toBe('active');
    expect(decision.note).toMatch(/Paused/);
    expect(decision.remaining).toBe('the last page');
  });

  it('blocks a done file that is missing, relative, or outside the grant', () => {
    const folder = path.resolve(os.tmpdir(), 'hb-job-grant');
    const inside = path.join(folder, 'note.txt');
    const outside = path.resolve(os.tmpdir(), 'hb-job-other', 'note.txt');
    const done = (href: string, exists: boolean) =>
      decideJobOutcome(sample, `JOB_STATUS: done\nJOB_ARTIFACT: file | note | ${href}`, {
        fileExists: () => exists,
        folder,
      });

    expect(done(inside, true).status).toBe('done');
    expect(done(inside, false).status).toBe('blocked');
    expect(done(inside, false).note).toMatch(/not on disk/);
    expect(done(outside, true).status).toBe('blocked');
    expect(done(outside, true).note).toMatch(/outside the granted folder/);
    expect(done('notes\\relative.txt', true).status).toBe('blocked');
    expect(decideJobOutcome(sample, 'JOB_STATUS: done\nJOB_ARTIFACT: file | note', { fileExists: () => true, folder }).note).toMatch(/no path/);
  });

  it('does not block a pause because an older file artifact is missing', () => {
    const folder = path.resolve(os.tmpdir(), 'hb-job-grant');
    const decision = decideJobOutcome(
      { ...sample, artifact: { kind: 'file', label: 'old', href: path.join(folder, 'missing.txt') } },
      'JOB_STATUS: paused',
      { fileExists: () => false, folder },
    );
    expect(decision.status).toBe('active');
  });

  it('puts the outcome, the definition of done, and the approval line in the prompt', () => {
    const folder = path.resolve(os.tmpdir(), 'hb-job-grant');
    const prompt = jobPrompt({ ...sample, progress: 'Outline saved' }, 'Mention the date', folder);
    expect(prompt).toContain('Outcome: A written note');
    expect(prompt).toContain('Done when: The note exists');
    expect(prompt).toContain('Outline saved');
    expect(prompt).toContain(folder);
    expect(prompt).toContain('Mention the date');
    expect(prompt).toContain(JOB_APPROVAL_LINE);
    expect(prompt).not.toContain('on the phone');
    expect(jobPrompt(sample)).toContain('No folder grant is set');
  });
});

describe('work folder grant', () => {
  it('accepts one absolute folder and rejects a relative path', () => {
    const folder = path.resolve(os.tmpdir(), 'hb-job-grant');
    expect(normalizeWorkFolder(folder)).toBe(path.resolve(folder));
    expect(normalizeWorkFolder('notes')).toBeUndefined();
    expect(normalizeWorkFolder('')).toBeUndefined();
    expect(normalizeWorkFolder(null)).toBeUndefined();
    expect(normalizeWorkFolder(`${folder}\nsecret`)).toBeUndefined();
    expect(pathInside(folder, path.join(folder, 'a', 'b.txt'))).toBe(true);
    expect(pathInside(folder, folder)).toBe(true);
    expect(pathInside(folder, path.join(folder, '..', 'secret.txt'))).toBe(false);
    expect(pathInside(folder, path.join(`${folder}-extra`, 'a.txt'))).toBe(false);
  });

  it('is not copied onto a duplicated bot', () => {
    const owner = bot('FolderBot');
    const folder = path.resolve(os.tmpdir(), 'hb-job-grant');
    store.updateBot(owner.id, { workFolder: folder, cwd: path.resolve(os.tmpdir(), 'hb-main-cwd') });
    const fields = botDuplicateFields(store.getBot(owner.id)!);
    expect(fields.workFolder).toBeUndefined();
    expect(fields.cwd).toBe(path.resolve(os.tmpdir(), 'hb-main-cwd'));
  });
});

describe('job queue, handoff, and schedule binding', () => {
  it('requires a title, an outcome, and a definition of done, and caps the queue', () => {
    const owner = bot('CapBot');
    expect(() => createJob({ botId: owner.id, title: ' ', outcome: 'x', acceptance: 'y' })).toThrow(/title, an outcome, and a definition of done/);
    expect(() => createJob({ botId: 'missing', title: 'T', outcome: 'O', acceptance: 'A' })).toThrow(/no such bot/);
    for (let i = 0; i < 50; i += 1) queued(owner, `Job ${i}`);
    expect(() => queued(owner, 'one more')).toThrow(/as many jobs as it can hold/);
    const first = listJobs(owner.id)[0]!;
    cancelJob(first.id);
    expect(queued(owner, 'after a cancel').status).toBe('queued');
  });

  it('checks a file artifact on disk and records tool names without their arguments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-job-disk-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-job-out-'));
    try {
      const file = path.join(dir, 'report.txt');
      fs.writeFileSync(file, 'ok');
      const outside = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outside, 'no');
      const owner = bot('DiskBot');
      store.updateBot(owner.id, { workFolder: dir });

      const done = queued(owner, 'Report');
      store.appendMessage(owner.threadId, { role: 'bot', kind: 'activity', text: 'warming up', tool: { name: 'setup' } });
      store.appendMessage(owner.threadId, { role: 'bot', kind: 'activity', text: 'read the brief', tool: { name: 'Read' } });
      store.appendMessage(owner.threadId, {
        role: 'bot',
        kind: 'text',
        text: `JOB_PROGRESS: wrote it\nJOB_STATUS: done\nJOB_ARTIFACT: file | report | ${file}`,
      });
      expect(finishJobFromThread(done.id, owner.threadId)?.status).toBe('done');
      expect(getJob(done.id)?.artifact?.href).toBe(file);
      const lines = listWorkLog(done.id).map((entry) => entry.text);
      expect(lines.some((line) => line.includes('Tools used: Read'))).toBe(true);
      expect(lines.some((line) => line.includes('setup'))).toBe(false);
      expect(lines).toContain('Finished.');

      const missing = queued(owner, 'Missing');
      store.appendMessage(owner.threadId, {
        role: 'bot',
        kind: 'text',
        text: `JOB_STATUS: done\nJOB_ARTIFACT: file | report | ${path.join(dir, 'missing.txt')}`,
      });
      expect(finishJobFromThread(missing.id, owner.threadId)?.status).toBe('blocked');
      expect(listWorkLog(missing.id).some((entry) => entry.text.includes('not on disk'))).toBe(true);

      const leaked = queued(owner, 'Leaked');
      store.appendMessage(owner.threadId, {
        role: 'bot',
        kind: 'text',
        text: `JOB_STATUS: done\nJOB_ARTIFACT: file | report | ${outside}`,
      });
      expect(finishJobFromThread(leaked.id, owner.threadId)?.status).toBe('blocked');
      expect(listWorkLog(leaked.id).some((entry) => entry.text.includes('outside the granted folder'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not requeue a pause, and resume puts it back on the idle queue', () => {
    const owner = bot('PauseBot');
    const job = queued(owner);
    store.appendMessage(owner.threadId, { role: 'bot', kind: 'text', text: 'JOB_STATUS: paused' });
    expect(finishJobFromThread(job.id, owner.threadId)?.status).toBe('active');
    expect(nextIdleJob(owner.id)).toBeUndefined();
    expect(resumeJob(job.id)?.status).toBe('queued');
    expect(nextIdleJob(owner.id)?.id).toBe(job.id);
    expect(resumeJob(job.id)?.status).toBe('queued');
    expect(listWorkLog(job.id).filter((entry) => entry.text === 'Queued again.')).toHaveLength(1);
  });

  it('keeps a cancel when a late reply says the job is done', () => {
    const owner = bot('CancelBot');
    const job = queued(owner);
    cancelJob(job.id);
    store.appendMessage(owner.threadId, { role: 'bot', kind: 'text', text: 'JOB_STATUS: done' });
    expect(finishJobFromThread(job.id, owner.threadId)?.status).toBe('cancelled');
    expect(resumeJob(job.id)?.status).toBe('queued');
  });

  it('moves the job to the other bot and does not copy the schedule', () => {
    const source = bot('Ada');
    const target = bot('Bea');
    const hidden = bot('Hidden');
    store.updateBot(hidden.id, { hidden: true });
    const job = queued(source, 'Handoff');
    updateJob(job.id, { progress: 'half', remaining: 'the rest', artifact: { kind: 'note', label: 'scratch' } });
    const routine = createBoundRoutine({
      name: 'Handoff',
      prompt: 'continue',
      botId: source.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: later(),
      durationMinutes: 5,
      jobId: job.id,
    });

    expect(handoffJob(job.id, source.id)).toEqual({ ok: false, reason: 'a job cannot be handed to the same bot' });
    expect(handoffJob(job.id, hidden.id)).toEqual({ ok: false, reason: 'no such bot' });
    const moved = handoffJob(job.id, target.id);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.source.status).toBe('handed-off');
    expect(moved.source.handedTo).toBe(target.id);
    expect(moved.created.status).toBe('queued');
    expect(moved.created.botId).toBe(target.id);
    expect(moved.created.routineId).toBeUndefined();
    expect(moved.created.sourceJobId).toBe(job.id);
    expect(moved.created.outcome).toBe(job.outcome);
    expect(moved.created.acceptance).toBe(job.acceptance);
    expect(moved.created.progress).toBe('half');
    expect(moved.created.remaining).toBe('the rest');
    expect(moved.created.artifact).toEqual({ kind: 'note', label: 'scratch' });
    expect(resumeJob(job.id)).toBeUndefined();
    expect(handoffJob(job.id, target.id).ok).toBe(false);
    expect(handoffJob(moved.created.id, target.id).ok).toBe(false);
    expect(nextIdleJob(target.id)?.id).toBe(moved.created.id);
    expect(nextIdleJob(source.id)).toBeUndefined();

    return runRoutine(getRoutine(routine.id)!, { manual: true }).then((run) => {
      expect(run.status).toBe('completed');
      expect(run.threadId).toBeUndefined();
      expect(run.output).toMatch(/handed-off/);
      expect(getJob(moved.created.id)?.status).toBe('queued');
    });
  });

  it('skips a scheduled job when the idle queue ticks', async () => {
    const owner = bot('Scheduled');
    const job = queued(owner);
    bindRoutine(job.id, 'rt_not_started');
    expect(nextIdleJob(owner.id)).toBeUndefined();
    pumpQueue();
    await runQueuedJob(owner.id, job.id);
    expect(getJob(job.id)?.status).toBe('queued');
    expect(getJob(job.id)?.startedAt).toBeUndefined();
  });

  it('rejects a bad job link before a routine is saved', () => {
    const owner = bot('Binder');
    const other = bot('Other');
    const job = queued(owner);
    const before = listRoutines().length;
    expect(() =>
      createBoundRoutine({
        name: 'Bad',
        prompt: 'go',
        botId: owner.id,
        runOn: 'harnessbot',
        enabled: false,
        schedule: later(),
        durationMinutes: 5,
        jobId: 'job_missing',
      }),
    ).toThrow(/job on this bot/);
    expect(() =>
      createBoundRoutine({
        name: 'Wrong bot',
        prompt: 'go',
        botId: other.id,
        runOn: 'harnessbot',
        enabled: false,
        schedule: later(),
        durationMinutes: 5,
        jobId: job.id,
      }),
    ).toThrow(/job on this bot/);
    expect(listRoutines()).toHaveLength(before);

    const routine = createBoundRoutine({
      name: 'Good',
      prompt: 'go',
      botId: owner.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: later(),
      durationMinutes: 5,
      jobId: `  ${job.id}  `,
    });
    expect(routine.jobId).toBe(job.id);
    expect(getJob(job.id)?.routineId).toBe(routine.id);
    expect(() =>
      createBoundRoutine({
        name: 'Second',
        prompt: 'go',
        botId: owner.id,
        runOn: 'harnessbot',
        enabled: false,
        schedule: later(),
        durationMinutes: 5,
        jobId: job.id,
      }),
    ).toThrow(/already has a schedule/);
    expect(listRoutines().filter((item) => item.botId === owner.id)).toHaveLength(1);

    deleteRoutine(routine.id);
    unbindRoutine(routine.id);
    expect(getJob(job.id)?.routineId).toBeUndefined();
  });

  it('does not start a turn for a finished job, and a catch-up stays unconfirmed', async () => {
    const owner = bot('Finished');
    const job = queued(owner, 'Digest');
    store.appendMessage(owner.threadId, { role: 'bot', kind: 'text', text: 'JOB_STATUS: done' });
    expect(finishJobFromThread(job.id, owner.threadId)?.status).toBe('done');
    const routine = createBoundRoutine({
      name: 'Digest',
      prompt: 'Summarise.',
      botId: owner.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'interval', everyMinutes: 15 },
      durationMinutes: 5,
      jobId: job.id,
    });

    const manual = await runRoutine(routine, { manual: true });
    expect(manual.status).toBe('completed');
    expect(manual.threadId).toBeUndefined();
    expect(manual.output).toMatch(/did not start another turn/);
    expect(getJob(job.id)?.status).toBe('done');

    const due = getRoutine(routine.id)!.nextRunAt!;
    const offered = offerCatchUps(due + CATCH_UP_GRACE_MS + 1_000).find((run) => run.routineId === routine.id)!;
    expect(offered.status).toBe('catch-up');
    expect(offered.threadId).toBeUndefined();
    expect(getJob(job.id)?.status).toBe('done');
    const confirmed = await confirmCatchUp(offered.id);
    expect(confirmed?.status).toBe('completed');
    expect(confirmed?.threadId).toBeUndefined();
    expect(confirmed?.output).toMatch(/did not start another turn/);
    expect(getJob(job.id)?.status).toBe('done');
  });

  it('offers a catch-up for a queued job without picking it up', () => {
    const owner = bot('Waiting');
    const job = queued(owner, 'Overnight');
    const routine = createBoundRoutine({
      name: 'Overnight',
      prompt: 'Look.',
      botId: owner.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'interval', everyMinutes: 15 },
      durationMinutes: 5,
      jobId: job.id,
    });
    const due = getRoutine(routine.id)!.nextRunAt!;
    const offered = offerCatchUps(due + CATCH_UP_GRACE_MS + 1_000).find((run) => run.routineId === routine.id)!;
    expect(offered.status).toBe('catch-up');
    expect(offered.startedAt).toBeUndefined();
    expect(getJob(job.id)?.status).toBe('queued');
  });

  it('forgets the jobs and the work log with the bot', async () => {
    const owner = bot('Gone');
    const job = queued(owner);
    const seen: string[] = [];
    const onDeleted = (data: { id: string }) => seen.push(data.id);
    jobEvents.on('job.deleted', onDeleted);
    try {
      expect(await forgetBot(owner.id)).toBe(true);
    } finally {
      jobEvents.off('job.deleted', onDeleted);
    }
    expect(seen).toContain(job.id);
    expect(getJob(job.id)).toBeUndefined();
    expect(listJobs(owner.id)).toEqual([]);
    expect(listWorkLog(job.id)).toEqual([]);
    expect(store.getBot(owner.id)).toBeUndefined();
  });

  it('drops only that bot when jobs are forgotten directly', () => {
    const owner = bot('Direct');
    const other = bot('Stays');
    queued(owner);
    const kept = queued(other);
    forgetJobsForBot(owner.id);
    expect(listJobs(owner.id)).toEqual([]);
    expect(getJob(kept.id)?.botId).toBe(other.id);
  });
});

describe('one job turn', () => {
  let stopRouting: (() => void) | undefined;

  beforeAll(async () => {
    saveConfig({ instances: { fake: { driver: 'fake', displayName: 'Fake' } } });
    registry.register(fakeDriver as never);
    await registry.reload();
    stopRouting = startEventRouting();
  });

  afterAll(async () => {
    stopRouting?.();
    await registry.disposeAll();
  });

  it('pins the granted folder, asks before send pay and delete, and stops after one turn', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-job-cwd-'));
    try {
      const owner = bot('Idle');
      const home = path.resolve(os.tmpdir(), 'hb-bot-home');
      store.updateBot(owner.id, { cwd: home, workFolder: folder });
      const job = createJob({
        botId: owner.id,
        title: 'Notes',
        outcome: 'Write the notes /tool',
        acceptance: 'The note is saved',
      });
      await runQueuedJob(owner.id, job.id);
      const finished = getJob(job.id);
      expect(finished?.status).toBe('active');
      expect(finished?.progress).toMatch(/pong:/);
      const task = store.getBot(owner.id)?.tasks?.find((item) => item.cwd === path.resolve(folder));
      expect(task?.cwd).toBe(path.resolve(folder));
      expect(store.getBot(owner.id)?.cwd).toBe(home);
      expect(store.getBot(owner.id)?.workFolder).toBe(folder);
      const user = store.listMessages(task!.threadId).find((message) => message.role === 'user');
      expect(user?.text).toContain(JOB_APPROVAL_LINE);
      expect(user?.text).toContain('Done when: The note is saved');
      expect(user?.text).not.toContain('on the phone');
      expect(listWorkLog(job.id).some((entry) => entry.kind === 'picked-up')).toBe(true);
      expect(listWorkLog(job.id).some((entry) => entry.text.includes('Tools used: Read'))).toBe(true);
      expect(listWorkLog(job.id).some((entry) => entry.text.includes('No JOB_STATUS'))).toBe(true);
      expect(isTurnActive(task!.threadId)).toBe(false);
      expect(routineHoldsApprovals(task!.threadId)).toBe(false);
      expect(nextIdleJob(owner.id)).toBeUndefined();
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('runs the job from a schedule and blocks it when the turn is still going', async () => {
    const owner = bot('OnTime');
    const job = createJob({
      botId: owner.id,
      title: 'Standup',
      outcome: 'Post the standup',
      acceptance: 'The standup is posted',
    });
    const routine = createBoundRoutine({
      name: 'Standup',
      prompt: 'please /permission before you click',
      botId: owner.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: later(),
      durationMinutes: 1 / 60,
      jobId: job.id,
    });

    const run = await runRoutine(routine, { manual: true });
    expect(run.threadId).toBeTruthy();
    expect(run.status).toBe('failed');
    expect(run.output).toMatch(/time limit/);
    const user = store.listMessages(run.threadId!).find((message) => message.role === 'user');
    expect(user?.text).toContain(JOB_APPROVAL_LINE);
    expect(user?.text).toContain('Post the standup');
    expect(user?.text).toContain('/permission');
    expect(getJob(job.id)?.status).toBe('blocked');
    expect(listWorkLog(job.id).some((entry) => entry.text.includes('time limit'))).toBe(true);
    expect(isTurnActive(run.threadId!)).toBe(true);
    expect(routineHoldsApprovals(run.threadId!)).toBe(true);

    await interrupt(owner.id, run.threadId!);
    expect(isTurnActive(run.threadId!)).toBe(false);
    expect(routineHoldsApprovals(run.threadId!)).toBe(false);
  });
});
