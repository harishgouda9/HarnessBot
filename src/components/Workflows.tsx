import { useEffect, useState } from 'react';
import type { RoutineSchedule, Workflow, WorkflowRun, WorkflowStep } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { PageHeader } from './PageHeader.tsx';

/**
 * Workflows are ordered jobs: a bot, an outcome, and a definition of done per step.
 * A finished step hands its progress and artifact to the next job. This page
 * creates, edits, retries, and hands a step to another bot.
 */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

type ScheduleChoice = 'manual' | 'weekdays' | 'daily' | 'hourly';

interface DraftStep {
  id?: string;
  botId: string;
  title: string;
  outcome: string;
  acceptance: string;
  onBlocked?: 'stop' | 'continue';
}

const emptyStep = (botId: string): DraftStep => ({ botId, title: '', outcome: '', acceptance: '' });

function scheduleOf(choice: ScheduleChoice): RoutineSchedule | { kind: 'manual' } {
  if (choice === 'weekdays') return { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] };
  if (choice === 'daily') return { kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] };
  if (choice === 'hourly') return { kind: 'interval', everyMinutes: 60 };
  return { kind: 'manual' };
}

function describeSchedule(workflow: Workflow): string {
  const schedule = workflow.schedule;
  if (!schedule) return 'Manual';
  if (schedule.kind === 'interval') return `Every ${schedule.everyMinutes} min`;
  if (schedule.kind === 'daily') {
    const days = schedule.weekdays.length === 5 && schedule.weekdays.every((day) => day >= 1 && day <= 5) ? 'weekdays' : 'daily';
    return `${days} ${schedule.time}`;
  }
  if (schedule.kind === 'once') return 'Once';
  return `Monthly day ${schedule.day}`;
}

function botName(bots: { id: string; name: string }[], botId: string): string {
  return bots.find((bot) => bot.id === botId)?.name ?? 'bot';
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function WorkflowsPage() {
  const { state, dispatch } = useStore();
  const bots = state.bots.filter((bot) => !bot.hidden);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState<ScheduleChoice>('manual');
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep(bots[0]?.id ?? '')]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    void Promise.all([api.get<Workflow[]>('/api/workflows'), api.get<WorkflowRun[]>('/api/workflows/runs')])
      .then(([workflows, runs]) => {
        if (gone) return;
        dispatch({ type: 'workflows', workflows });
        dispatch({ type: 'workflowRuns', runs });
        setLoaded(true);
        setError('');
      })
      .catch((err: unknown) => {
        if (gone) return;
        const message = messageOf(err, 'Could not load workflows');
        setError(message === 'not found' ? 'old-harness' : message);
      });
    return () => {
      gone = true;
    };
  }, [dispatch]);

  const firstBotId = bots[0]?.id ?? '';
  useEffect(() => {
    if (!firstBotId) return;
    setSteps((current) => (current.every((step) => step.botId) ? current : current.map((step) => (step.botId ? step : { ...step, botId: firstBotId }))));
  }, [firstBotId]);

  const reset = (): void => {
    setEditing(null);
    setName('');
    setSchedule('manual');
    setSteps([emptyStep(bots[0]?.id ?? '')]);
  };

  const edit = (workflow: Workflow): void => {
    setEditing(workflow.id);
    setName(workflow.name);
    const choice: ScheduleChoice = !workflow.schedule
      ? 'manual'
      : workflow.schedule.kind === 'interval'
        ? 'hourly'
        : workflow.schedule.kind === 'daily' && workflow.schedule.weekdays.length === 7
          ? 'daily'
          : 'weekdays';
    setSchedule(choice);
    setSteps(workflow.steps.map((step) => ({
      id: step.id,
      botId: step.botId,
      title: step.title,
      outcome: step.outcome,
      acceptance: step.acceptance,
      onBlocked: step.onBlocked === 'continue' ? 'continue' : 'stop',
    })));
    setError('');
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const body = editing
        ? { name, schedule: scheduleOf(schedule), steps }
        : { name, schedule: scheduleOf(schedule), steps, enabled: true };
      const workflow = editing
        ? await api.patch<Workflow>(`/api/workflows/${editing}`, body)
        : await api.post<Workflow>('/api/workflows', body);
      dispatch({ type: 'workflow', workflow });
      if (editing) await moveQueuedStep(workflow);
      reset();
    } catch (err) {
      setError(messageOf(err, 'Could not save the workflow'));
    } finally {
      setBusy(false);
    }
  };

  /** When an edit gives the current step to a different bot, move the queued job too. */
  const moveQueuedStep = async (workflow: Workflow): Promise<void> => {
    const run = state.workflowRuns.find((item) => item.workflowId === workflow.id && item.status === 'running');
    if (!run?.jobId) return;
    const job = state.jobs.find((item) => item.id === run.jobId);
    const step = workflow.steps[run.stepIndex];
    if (!job || !step || job.botId === step.botId || job.status !== 'queued') return;
    const next = await api.post<WorkflowRun>(`/api/workflows/runs/${run.id}/handoff`, { botId: step.botId });
    dispatch({ type: 'workflow.run', run: next });
    dispatch({ type: 'workflow', workflow: { ...workflow, steps: workflow.steps.map((item, index) => (index === run.stepIndex ? { ...item, botId: step.botId } : item)) } });
  };

  const patchStep = (index: number, patch: Partial<DraftStep>): void => {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };

  const moveStep = (index: number, direction: -1 | 1): void => {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = current.slice();
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row!);
      return next;
    });
  };

  const act = async (work: () => Promise<void>, fallback: string): Promise<void> => {
    try {
      setError('');
      await work();
    } catch (err) {
      setError(messageOf(err, fallback));
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <PageHeader
        title="Workflows"
        description="Each step is a job for one bot. When it finishes, the next bot receives that progress and any file it named. If a step blocks, the run stops unless that step is set to continue. A starting note is the first step's input."
      />
      <div className="scroll-thin flex-1 overflow-y-auto px-4 py-3">
        {error === 'old-harness' && !loaded ? (
          <div className="max-w-lg rounded-lg p-3 text-[13px]" style={{ background: 'var(--color-inset)' }}>
            Workflows are in this build. The harness that is running does not have them yet, so this page stays quiet until that process is restarted.
          </div>
        ) : error && !loaded ? (
          <div className="max-w-lg rounded-lg p-3 text-[13px]" style={{ background: 'var(--color-inset)', color: 'var(--color-danger)' }}>
            {error}
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]">
            <div>
              {error && loaded ? (
                <div className="mb-3 rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-danger)' }}>
                  {error}
                </div>
              ) : null}
              {!loaded ? (
                <div className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  Loading workflows…
                </div>
              ) : state.workflows.length === 0 ? (
                <div className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  No workflows yet. Add one on the right. Each step names the bot who does it.
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {state.workflows.map((workflow) => (
                    <WorkflowCard
                      key={workflow.id}
                      workflow={workflow}
                      bots={bots}
                      runs={state.workflowRuns.filter((run) => run.workflowId === workflow.id).slice(0, 6)}
                      jobs={state.jobs}
                      onEdit={() => edit(workflow)}
                      onAct={act}
                    />
                  ))}
                </ul>
              )}
            </div>

            <form
              className="rounded-lg p-3"
              style={{ background: 'var(--color-panel)' }}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <div className="text-[13px] font-medium">{editing ? 'Edit workflow' : 'New workflow'}</div>
              <label className="mt-2 block text-[12px]">
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
              </label>
              <label className="mt-2 block text-[12px]">
                When it runs
                <select value={schedule} onChange={(e) => setSchedule(e.target.value as ScheduleChoice)} className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
                  <option value="manual">Only when I press Run</option>
                  <option value="weekdays">Weekdays at 09:00</option>
                  <option value="daily">Every day at 09:00</option>
                  <option value="hourly">Every hour</option>
                </select>
              </label>
              <div className="mt-3 text-[12px] font-medium">Steps</div>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Choose the bot for each step. A change of bot is a handoff.
              </p>
              {steps.map((step, index) => {
                const previous = index > 0 ? steps[index - 1] : undefined;
                const handsOff = Boolean(previous && previous.botId && step.botId && previous.botId !== step.botId);
                return (
                  <div key={step.id ?? index} className="mt-2 rounded-lg p-2" style={{ background: 'var(--color-inset)' }}>
                    <div className="mb-1 flex items-center gap-2 text-[12px]">
                      <span>Step {index + 1}</span>
                      {handsOff ? (
                        <span style={{ color: 'var(--color-accent)' }}>Hands off from {botName(bots, previous!.botId)} to {botName(bots, step.botId)}</span>
                      ) : null}
                      <span className="flex-1" />
                      <button type="button" className="text-[11px]" disabled={index === 0} onClick={() => moveStep(index, -1)}>
                        Up
                      </button>
                      <button type="button" className="text-[11px]" disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}>
                        Down
                      </button>
                      {steps.length > 1 ? (
                        <button type="button" className="text-[11px]" style={{ color: 'var(--color-danger)' }} onClick={() => setSteps(steps.filter((_, i) => i !== index))}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <label className="mb-1 block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      Bot
                      <select value={step.botId} onChange={(e) => patchStep(index, { botId: e.target.value })} className="mt-0.5 w-full rounded-lg px-2 py-1 text-[13px]" style={inputStyle} aria-label={`Bot for step ${index + 1}`}>
                        {bots.map((bot) => (
                          <option key={bot.id} value={bot.id}>
                            {bot.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <input value={step.title} onChange={(e) => patchStep(index, { title: e.target.value })} placeholder="Title" required className="mb-1 w-full rounded-lg px-2 py-1 text-[13px]" style={inputStyle} />
                    <textarea value={step.outcome} onChange={(e) => patchStep(index, { outcome: e.target.value })} placeholder="Outcome" required rows={2} className="mb-1 w-full rounded-lg px-2 py-1 text-[13px]" style={inputStyle} />
                    <textarea value={step.acceptance} onChange={(e) => patchStep(index, { acceptance: e.target.value })} placeholder="Done when" required rows={2} className="mb-1 w-full rounded-lg px-2 py-1 text-[13px]" style={inputStyle} />
                    <select
                      value={step.onBlocked === 'continue' ? 'continue' : 'stop'}
                      onChange={(e) => patchStep(index, { onBlocked: e.target.value === 'continue' ? 'continue' : 'stop' })}
                      className="w-full rounded-lg px-2 py-1 text-[12px]"
                      style={inputStyle}
                      aria-label={`If step ${index + 1} blocks`}
                    >
                      <option value="stop">If blocked, stop the run</option>
                      <option value="continue">If blocked, continue</option>
                    </select>
                  </div>
                );
              })}
              {steps.length < 8 ? (
                <button type="button" className="mt-2 text-[12px]" onClick={() => setSteps([...steps, emptyStep(bots[0]?.id ?? '')])}>
                  Add step
                </button>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button type="submit" disabled={busy || bots.length === 0} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}>
                  {editing ? 'Save' : 'Create'}
                </button>
                {editing ? (
                  <button type="button" className="text-[12px]" onClick={reset}>
                    Cancel
                  </button>
                ) : null}
              </div>
              {bots.length === 0 ? (
                <p className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  Add a bot before a workflow can name who does the work.
                </p>
              ) : null}
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

function WorkflowCard({
  workflow,
  bots,
  runs,
  jobs,
  onEdit,
  onAct,
}: {
  workflow: Workflow;
  bots: { id: string; name: string }[];
  runs: WorkflowRun[];
  jobs: { id: string; botId: string; status: string; handedFrom?: string }[];
  onEdit: () => void;
  onAct: (work: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const { dispatch } = useStore();
  const [startNote, setStartNote] = useState('');

  const duplicate = (): Promise<void> =>
    onAct(async () => {
      const copy = await api.post<Workflow>('/api/workflows', {
        name: `${workflow.name} copy`,
        enabled: false,
        schedule: workflow.schedule ?? { kind: 'manual' },
        steps: workflow.steps.map((step) => ({
          botId: step.botId,
          title: step.title,
          outcome: step.outcome,
          acceptance: step.acceptance,
          ...(step.onBlocked === 'continue' ? { onBlocked: 'continue' as const } : {}),
        })),
      });
      dispatch({ type: 'workflow', workflow: copy });
    }, 'Could not duplicate the workflow');

  return (
    <li className="rounded-lg p-3" style={{ background: 'var(--color-panel)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium">{workflow.name}</span>
        <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {describeSchedule(workflow)} · {workflow.enabled ? 'on' : 'off'}
        </span>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-[12px]">
          <input
            type="checkbox"
            checked={workflow.enabled}
            onChange={(e) => {
              const enabled = e.target.checked;
              void onAct(async () => {
                const next = await api.patch<Workflow>(`/api/workflows/${workflow.id}`, { enabled });
                dispatch({ type: 'workflow', workflow: next });
              }, 'Could not update the workflow');
            }}
          />
          Enabled
        </label>
        <input
          value={startNote}
          onChange={(e) => setStartNote(e.target.value)}
          placeholder="Starting note"
          aria-label={`Starting note for ${workflow.name}`}
          className="w-36 rounded-lg px-2 py-1 text-[12px]"
          style={inputStyle}
        />
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-[12px]"
          style={{ background: 'var(--color-raised)' }}
          onClick={() => {
            const note = startNote.trim();
            void onAct(async () => {
              const run = await api.post<WorkflowRun>(`/api/workflows/${workflow.id}/run`, note ? { input: note } : {});
              dispatch({ type: 'workflow.run', run });
              setStartNote('');
            }, 'Could not run the workflow');
          }}
        >
          Run
        </button>
        <button type="button" className="text-[12px]" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="text-[12px]" onClick={() => void duplicate()}>
          Duplicate
        </button>
        <button
          type="button"
          className="text-[12px]"
          style={{ color: 'var(--color-danger)' }}
          onClick={() => {
            if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;
            void onAct(async () => {
              await api.del(`/api/workflows/${workflow.id}`);
              dispatch({ type: 'workflow.deleted', id: workflow.id });
            }, 'Could not delete the workflow');
          }}
        >
          Delete
        </button>
      </div>
      <ol className="mt-2 flex flex-col gap-0.5 text-[12px]">
        {workflow.steps.map((step, index) => {
          const previous = index > 0 ? workflow.steps[index - 1] : undefined;
          const handsOff = Boolean(previous && previous.botId !== step.botId);
          return (
            <li key={step.id}>
              <span style={{ color: 'var(--color-ink)' }}>
                {index + 1}. {botName(bots, step.botId)} — {step.title}
              </span>
              {handsOff ? (
                <span style={{ color: 'var(--color-accent)' }}> · handoff from {botName(bots, previous!.botId)}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {runs.length ? (
        <ul className="mt-2 flex flex-col gap-2 text-[12px]">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} steps={workflow.steps} bots={bots} jobs={jobs} onAct={onAct} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RunRow({
  run,
  steps,
  bots,
  jobs,
  onAct,
}: {
  run: WorkflowRun;
  steps: WorkflowStep[];
  bots: { id: string; name: string }[];
  jobs: { id: string; botId: string; status: string; handedFrom?: string }[];
  onAct: (work: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const { dispatch } = useStore();
  const [handoffBot, setHandoffBot] = useState('');
  const step = steps[run.stepIndex];
  const job = jobs.find((item) => item.id === run.jobId);
  const ownerId = job?.botId ?? step?.botId ?? '';
  const others = bots.filter((bot) => bot.id !== ownerId);
  const target = handoffBot && others.some((bot) => bot.id === handoffBot) ? handoffBot : (others[0]?.id ?? '');

  return (
    <li className="rounded-lg px-2 py-1.5" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
      <div>
        {run.status}
        {step ? ` · step ${run.stepIndex + 1} · ${botName(bots, ownerId)}` : ''}
        {job ? ` · ${job.status}` : ''}
        {job?.handedFrom ? ` · from ${botName(bots, job.handedFrom)}` : ''}
        {run.note ? ` — ${run.note}` : ''} · {new Date(run.startedAt).toLocaleString()}
      </div>
      {run.results?.length ? (
        <ol className="mt-1 flex flex-col gap-0.5">
          {run.results.map((result) => (
            <li key={`${result.index}-${result.at}`} className="truncate" title={result.progress}>
              {result.index + 1}. {botName(bots, result.botId)} · {result.status}
              {result.artifact ? ` · ${result.artifact.label}` : ''}
              {result.progress ? ` — ${result.progress}` : ''}
            </li>
          ))}
        </ol>
      ) : null}
      {run.status === 'failed' || run.status === 'waiting' ? (
        <div className="mt-1">
          <button
            type="button"
            className="rounded-lg px-2 py-0.5 text-[12px]"
            style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
            onClick={() => {
              void onAct(async () => {
                const next = await api.post<WorkflowRun>(`/api/workflows/runs/${run.id}/retry`);
                dispatch({ type: 'workflow.run', run: next });
              }, 'Could not try the step again');
            }}
          >
            {run.status === 'waiting' ? 'Run now' : 'Retry step'}
          </button>
        </div>
      ) : null}
      {run.status === 'running' || run.status === 'waiting' ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {run.status === 'running' && others.length > 0 ? (
            <>
              <label className="flex items-center gap-1">
                Hand off to
                <select value={target} onChange={(e) => setHandoffBot(e.target.value)} className="rounded-lg px-1 py-0.5 text-[12px]" style={inputStyle} aria-label={`Hand off run ${run.id}`}>
                  {others.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="rounded-lg px-2 py-0.5 text-[12px]"
                style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
                onClick={() => {
                  if (!target) return;
                  const name = botName(bots, target);
                  if (job?.status === 'active' && !window.confirm(`Hand this step to ${name}? The current turn stops.`)) return;
                  void onAct(async () => {
                    const next = await api.post<WorkflowRun>(`/api/workflows/runs/${run.id}/handoff`, { botId: target });
                    dispatch({ type: 'workflow.run', run: next });
                  }, 'Could not hand off the step');
                }}
              >
                Hand off
              </button>
            </>
          ) : null}
          {ownerId ? (
            <button
              type="button"
              className="text-[12px]"
              style={{ color: 'var(--color-ink)' }}
              onClick={() => dispatch({ type: 'select', selected: { kind: 'bot', id: ownerId } })}
            >
              Open {botName(bots, ownerId)}
            </button>
          ) : null}
          <button
            type="button"
            className="text-[12px]"
            style={{ color: 'var(--color-danger)' }}
            onClick={() => {
              void onAct(async () => {
                const next = await api.post<WorkflowRun>(`/api/workflows/runs/${run.id}/cancel`);
                dispatch({ type: 'workflow.run', run: next });
              }, 'Could not cancel the run');
            }}
          >
            Cancel run
          </button>
        </div>
      ) : null}
    </li>
  );
}
