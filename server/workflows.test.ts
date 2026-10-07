import { describe, expect, it } from 'vitest';
import { finishJobFromThread, listJobs } from './jobs.ts';
import { store } from './store.ts';
import { cancelWorkflowRun, createWorkflow, getRun, handoffRun, listWorkflowRuns, retryWorkflowRun, runWorkflow, tickWorkflows } from './workflows.ts';

const bot = (name: string) => store.createBot({ name, modelSelection: { instanceId: 'fake', model: 'fake-1' } });

describe('workflows', () => {
  it('queues the next step on another bot as a handoff when the first step finishes', () => {
    const first = bot('One');
    const second = bot('Two');
    const workflow = createWorkflow({
      name: 'Ship',
      steps: [
        { botId: first.id, title: 'Draft', outcome: 'A draft exists', acceptance: 'The draft is written' },
        { botId: second.id, title: 'Review', outcome: 'The draft is reviewed', acceptance: 'Notes are recorded' },
      ],
    });
    const run = runWorkflow(workflow.id);
    expect(run.status).toBe('running');
    expect(listJobs(first.id).some((job) => job.workflowRunId === run.id && job.status === 'queued')).toBe(true);

    store.appendMessage(first.threadId, { role: 'bot', kind: 'text', text: 'JOB_STATUS: done' });
    finishJobFromThread(run.jobId!, first.threadId);

    const handed = listJobs(second.id).find((job) => job.workflowRunId === run.id);
    expect(handed).toMatchObject({ status: 'queued', handedFrom: first.id, title: 'Review' });
    expect(getRun(run.id)).toMatchObject({ status: 'running', stepIndex: 1, jobId: handed!.id });

    store.appendMessage(second.threadId, { role: 'bot', kind: 'text', text: 'JOB_STATUS: done' });
    finishJobFromThread(handed!.id, second.threadId);
    expect(getRun(run.id)?.status).toBe('completed');
  });

  it('starts a due workflow and waits when the due time was missed', () => {
    const owner = bot('Clock');
    const workflow = createWorkflow({
      name: 'Hourly',
      schedule: { kind: 'interval', everyMinutes: 60 },
      steps: [{ botId: owner.id, title: 'Check', outcome: 'The check ran', acceptance: 'A note exists' }],
    });
    const due = workflow.nextRunAt ?? 0;
    tickWorkflows(due + 1_000);
    expect(listJobs(owner.id).some((job) => job.workflowId === workflow.id)).toBe(true);
    expect(listWorkflowRuns(workflow.id).some((run) => run.status === 'running')).toBe(true);

    const later = createWorkflow({
      name: 'Missed',
      schedule: { kind: 'interval', everyMinutes: 60 },
      steps: [{ botId: owner.id, title: 'Late', outcome: 'It ran', acceptance: 'It ran' }],
    });
    tickWorkflows((later.nextRunAt ?? 0) + 20 * 60_000);
    expect(listWorkflowRuns(later.id)[0]).toMatchObject({ status: 'waiting' });
    expect(listJobs(owner.id).some((job) => job.workflowId === later.id)).toBe(false);
  });

  it('hands the current step to another bot and can cancel the run', () => {
    const first = bot('Author');
    const second = bot('Editor');
    const workflow = createWorkflow({
      name: 'Pass',
      steps: [{ botId: first.id, title: 'Write', outcome: 'A note exists', acceptance: 'The note is saved' }],
    });
    const run = runWorkflow(workflow.id);
    const moved = handoffRun(run.id, second.id);
    expect(moved.note).toContain('Editor');
    expect(listJobs(first.id).find((job) => job.workflowRunId === run.id)?.status).toBe('cancelled');
    const handed = listJobs(second.id).find((job) => job.workflowRunId === run.id);
    expect(handed).toMatchObject({ status: 'queued', handedFrom: first.id });
    expect(getRun(run.id)?.jobId).toBe(handed!.id);

    const cancelled = cancelWorkflowRun(run.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(listJobs(second.id).find((job) => job.id === handed!.id)?.status).toBe('cancelled');
  });

  it('gives the next step the previous progress and artifact, and keeps them on the run', () => {
    const first = bot('Writer');
    const second = bot('Editor');
    const workflow = createWorkflow({
      name: 'Carry',
      steps: [
        { botId: first.id, title: 'Draft', outcome: 'A draft exists', acceptance: 'The draft is written' },
        { botId: second.id, title: 'Review', outcome: 'The draft is reviewed', acceptance: 'Notes are recorded' },
      ],
    });
    const run = runWorkflow(workflow.id, 'AI news shorts');
    const firstJob = listJobs(first.id).find((job) => job.workflowRunId === run.id);
    expect(firstJob?.progress).toContain('AI news shorts');

    store.appendMessage(first.threadId, {
      role: 'bot',
      kind: 'text',
      text: 'JOB_PROGRESS: wrote the runbook\nJOB_ARTIFACT: note | runbook | workspace/pipe/runbook.md\nJOB_STATUS: done',
    });
    finishJobFromThread(run.jobId!, first.threadId);

    const handed = listJobs(second.id).find((job) => job.workflowRunId === run.id);
    expect(handed?.progress).toContain('wrote the runbook');
    expect(handed?.progress).toContain('runbook');
    expect(handed?.artifact).toMatchObject({ kind: 'note', label: 'runbook' });
    expect(getRun(run.id)?.results?.[0]).toMatchObject({ status: 'done', progress: 'wrote the runbook' });
  });

  it('stops on a blocked step, records why, and retries that same step', () => {
    const owner = bot('Owner');
    const workflow = createWorkflow({
      name: 'Stuck',
      steps: [{ botId: owner.id, title: 'Write', outcome: 'A note exists', acceptance: 'The note is saved' }],
    });
    const run = runWorkflow(workflow.id);
    store.appendMessage(owner.threadId, {
      role: 'bot',
      kind: 'text',
      text: 'JOB_PROGRESS: half\nJOB_REMAINING: need the script\nJOB_STATUS: blocked',
    });
    finishJobFromThread(run.jobId!, owner.threadId);
    expect(getRun(run.id)).toMatchObject({ status: 'failed' });
    expect(getRun(run.id)?.note).toContain('need the script');
    expect(getRun(run.id)?.results?.[0]).toMatchObject({ status: 'blocked' });

    const again = retryWorkflowRun(run.id);
    expect(again.status).toBe('running');
    const job = listJobs(owner.id).find((item) => item.id === again.jobId);
    expect(job).toMatchObject({ status: 'queued' });
    expect(job?.progress).toContain('half');
  });

  it('continues to the next step when a blocked step is allowed to', () => {
    const first = bot('Scout');
    const second = bot('Maker');
    const workflow = createWorkflow({
      name: 'Keep going',
      steps: [
        { botId: first.id, title: 'Look', outcome: 'A finding exists', acceptance: 'The finding is written', onBlocked: 'continue' },
        { botId: second.id, title: 'Build', outcome: 'The file exists', acceptance: 'The file is saved' },
      ],
    });
    const run = runWorkflow(workflow.id);
    store.appendMessage(first.threadId, {
      role: 'bot',
      kind: 'text',
      text: 'JOB_PROGRESS: source is down\nJOB_REMAINING: try the cache\nJOB_STATUS: blocked',
    });
    finishJobFromThread(run.jobId!, first.threadId);
    const handed = listJobs(second.id).find((job) => job.workflowRunId === run.id);
    expect(handed?.status).toBe('queued');
    expect(handed?.progress).toContain('source is down');
    expect(handed?.progress).toContain('blocked');
    expect(getRun(run.id)).toMatchObject({ status: 'running', stepIndex: 1 });
  });
});
