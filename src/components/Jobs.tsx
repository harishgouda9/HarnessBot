import { useEffect, useState } from 'react';
import { JOB_APPROVAL_LINE, type BotRecord, type JobRecord, type JobStatus, type WorkLogEntry } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';

/**
 * Jobs live on the bot profile. Drawing a line on the team map does not move one,
 * and this panel never grants send, pay, or delete.
 */

const field = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;
const quiet = { background: 'var(--color-raised)', color: 'var(--color-ink)' } as const;

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  active: 'In progress',
  blocked: 'Blocked',
  'handed-off': 'Handed off',
  done: 'Done',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<JobStatus, string> = {
  queued: 'var(--color-ink-secondary)',
  active: 'var(--color-success)',
  blocked: 'var(--color-warning)',
  'handed-off': 'var(--color-ink-secondary)',
  done: 'var(--color-success)',
  cancelled: 'var(--color-ink-secondary)',
};

export function BotJobs({ bot }: { bot: BotRecord }) {
  const { state, refreshJobs } = useStore();
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [log, setLog] = useState<WorkLogEntry[]>([]);
  const [handoffTo, setHandoffTo] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const mine = state.jobs.filter((job) => job.botId === bot.id).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const others = state.bots.filter((item) => item.id !== bot.id && !item.hidden);
  const open = mine.find((job) => job.id === openId) ?? null;

  useEffect(() => {
    setTitle('');
    setOutcome('');
    setAcceptance('');
    setOpenId(null);
    setHandoffTo('');
    setError('');
  }, [bot.id]);

  useEffect(() => {
    if (!openId) {
      setLog([]);
      return;
    }
    let cancel = false;
    void api
      .get<WorkLogEntry[]>(`/api/jobs/${openId}/log`)
      .then((rows) => {
        if (!cancel) setLog(rows);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not load the work log');
      });
    return () => {
      cancel = true;
    };
  }, [openId, state.jobs]);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setError('');
    setSaving(true);
    try {
      await work();
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the job');
    } finally {
      setSaving(false);
    }
  };

  const create = (): Promise<void> =>
    run(async () => {
      await api.post(`/api/bots/${bot.id}/jobs`, { title, outcome, acceptance });
      setTitle('');
      setOutcome('');
      setAcceptance('');
    });

  const nameOf = (id: string | undefined): string => state.bots.find((item) => item.id === id)?.name ?? 'another bot';

  return (
    <section className="mt-2 border-t pt-2 hairline">
      <div className="px-3 pt-1 text-[12px] font-medium">Work</div>
      <p className="px-3 pt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        A job is one outcome. A queued job runs once when this bot is idle, then it stops. A schedule runs
        that same job, including a catch-up only after you confirm it. {JOB_APPROVAL_LINE} A line on the team
        map does not move a job.
      </p>

      <label className="block px-3 py-2">
        <span className="block text-[12px] font-medium">Job folder</span>
        <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          One absolute folder a job may use as its working directory. It does not replace the working folder
          above, and it is not permission to send, pay, or delete.
        </span>
        <input
          key={`${bot.id}:${bot.workFolder ?? ''}`}
          defaultValue={bot.workFolder ?? ''}
          placeholder="C:\work\this-job"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next === (bot.workFolder ?? '')) return;
            void run(() => api.patch(`/api/bots/${bot.id}`, { workFolder: next || null }));
          }}
          className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
          style={field}
        />
      </label>

      <form
        className="px-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || !outcome.trim() || !acceptance.trim() || saving) return;
          void create();
        }}
      >
        <span className="block text-[12px] font-medium">New job</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="Title"
          aria-label="Job title"
          className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
          style={field}
        />
        <textarea
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Outcome"
          aria-label="Job outcome"
          className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
          style={field}
        />
        <textarea
          value={acceptance}
          onChange={(e) => setAcceptance(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Done when"
          aria-label="Definition of done"
          className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
          style={field}
        />
        <button
          type="submit"
          disabled={saving || !title.trim() || !outcome.trim() || !acceptance.trim()}
          className="mt-1.5 rounded-lg px-2 py-1 text-[12px] disabled:opacity-50"
          style={quiet}
        >
          Queue job
        </button>
      </form>

      {error ? (
        <div className="px-3 pb-2 text-[11px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      {mine.length === 0 ? (
        <div className="px-3 pb-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          No jobs yet.
        </div>
      ) : (
        <ul className="px-3 pb-2">
          {mine.map((job) => (
            <li key={job.id} className="mt-1.5 rounded-lg" style={{ background: 'var(--color-inset)' }}>
              <button
                type="button"
                onClick={() => setOpenId(openId === job.id ? null : job.id)}
                className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
                aria-expanded={openId === job.id}
              >
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[job.status] }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{job.title}</span>
                  <span className="block text-[11px]" style={{ color: STATUS_COLOR[job.status] }}>
                    {STATUS_LABEL[job.status]}
                    {job.handedTo ? ` · to ${nameOf(job.handedTo)}` : ''}
                    {job.handedFrom ? ` · from ${nameOf(job.handedFrom)}` : ''}
                  </span>
                </span>
              </button>
              {open?.id === job.id ? <JobDetail job={job} bot={bot} others={others} log={log} handoffTo={handoffTo} onHandoffTo={setHandoffTo} saving={saving} run={run} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JobDetail({
  job,
  bot,
  others,
  log,
  handoffTo,
  onHandoffTo,
  saving,
  run,
}: {
  job: JobRecord;
  bot: BotRecord;
  others: BotRecord[];
  log: WorkLogEntry[];
  handoffTo: string;
  onHandoffTo: (id: string) => void;
  saving: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const routine = job.routineId;
  const closed = job.status === 'handed-off' || job.status === 'cancelled';
  const canResume = job.status === 'active' || job.status === 'blocked' || job.status === 'done' || job.status === 'cancelled';

  return (
    <div className="border-t px-2 py-2 hairline">
      <p className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {job.outcome}
      </p>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Done when: {job.acceptance}
      </p>
      {job.progress ? <p className="mt-1 text-[11px]">Progress: {job.progress}</p> : null}
      {job.remaining ? <p className="mt-1 text-[11px]">Still left: {job.remaining}</p> : null}
      {job.artifact ? (
        <p className="mt-1 break-all text-[11px]">
          {job.artifact.kind}: {job.artifact.label}
          {job.artifact.href ? ` — ${job.artifact.href}` : ''}
        </p>
      ) : null}
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {routine
          ? 'This job has a schedule. Resume queues it for the next time that schedule fires.'
          : 'Resume queues it for the next time this bot is idle. Picking it up opens a task so approval cards stay visible.'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {canResume ? (
          <button type="button" disabled={saving} onClick={() => void run(() => api.post(`/api/jobs/${job.id}/resume`))} className="rounded-lg px-2 py-1 text-[12px] disabled:opacity-50" style={quiet}>
            Resume
          </button>
        ) : null}
        {!closed && !routine ? (
          <button
            type="button"
            disabled={saving}
            title="Weekdays at 09:00. A finished job waits until you resume it."
            onClick={() => void run(() => api.post(`/api/jobs/${job.id}/schedule`, {}))}
            className="rounded-lg px-2 py-1 text-[12px] disabled:opacity-50"
            style={quiet}
          >
            Weekdays at 09:00
          </button>
        ) : null}
        {job.status !== 'handed-off' && job.status !== 'cancelled' ? (
          <button type="button" disabled={saving} onClick={() => void run(() => api.post(`/api/jobs/${job.id}/cancel`))} className="rounded-lg px-2 py-1 text-[12px] disabled:opacity-50" style={{ color: 'var(--color-danger)' }}>
            Cancel
          </button>
        ) : null}
      </div>
      {job.status !== 'handed-off' && job.status !== 'cancelled' && others.length > 0 ? (
        <div className="mt-2 flex items-center gap-1.5">
          <select value={handoffTo} onChange={(e) => onHandoffTo(e.target.value)} aria-label={`Hand ${job.title} to`} className="min-w-0 flex-1 rounded-lg px-2 py-1 text-[12px]" style={field}>
            <option value="">Hand off to…</option>
            {others.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={saving || !handoffTo}
            onClick={() => {
              const target = others.find((item) => item.id === handoffTo);
              if (!target) return;
              if (!window.confirm(`Hand "${job.title}" to ${target.name}? ${bot.name} will stop owning it.`)) return;
              void run(() => api.post(`/api/jobs/${job.id}/handoff`, { toBotId: target.id }));
            }}
            className="rounded-lg px-2 py-1 text-[12px] disabled:opacity-50"
            style={quiet}
          >
            Hand off
          </button>
        </div>
      ) : null}
      {log.length > 0 ? (
        <ol className="scroll-thin mt-2 max-h-36 overflow-y-auto">
          {log.map((entry) => (
            <li key={entry.id} className="py-0.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              <span className="font-medium">{entry.kind}</span> · {entry.text}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
