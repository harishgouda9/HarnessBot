import { useEffect, useMemo, useState } from 'react';
import type { RoutineRun } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';

/** The routines calendar. Skills, the org canvas, and connected apps have their own files. */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

const STATUS_TONE: Record<string, string> = {
  completed: 'var(--color-success)',
  running: 'var(--color-accent)',
  queued: 'var(--color-ink-secondary)',
  waiting: 'var(--color-warning)',
  failed: 'var(--color-danger)',
  cancelled: 'var(--color-ink-secondary)',
  missed: 'var(--color-danger)',
};

function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="flex items-center gap-2 border-b px-4 py-3 hairline" style={{ background: 'var(--color-panel)' }}>
      <h1 className="flex-1 text-[15px] font-semibold">{title}</h1>
      {children}
    </header>
  );
}

export function RoutineCalendarPage() {
  const { state, refreshRoutines, dispatch } = useStore();
  const [span, setSpan] = useState<1 | 3 | 7>(3);
  const [botFilter, setBotFilter] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void refreshRoutines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const days = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: span }, (_, i) => new Date(start.getTime() + i * 86400_000));
  }, [span]);

  const runs = state.runs.filter((r) => !botFilter || r.botId === botFilter);

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <PageHeader title="Routines">
        <select value={botFilter} onChange={(e) => setBotFilter(e.target.value)} className="rounded-lg px-2 py-1 text-[12px]" style={inputStyle}>
          <option value="">All bots</option>
          {state.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {([1, 3, 7] as const).map((n) => (
          <button key={n} type="button" onClick={() => setSpan(n)} className="rounded-lg px-2 py-1 text-[12px]" style={{ background: span === n ? 'var(--color-raised)' : 'transparent' }}>
            {n === 1 ? 'Day' : n === 3 ? '3 days' : 'Week'}
          </button>
        ))}
        <button type="button" onClick={() => setCreating(true)} className="rounded-lg px-3 py-1 text-[12px]" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}>
          New routine
        </button>
        <button type="button" onClick={() => dispatch({ type: 'view', view: 'chat' })} className="text-[12px]">
          Back
        </button>
      </PageHeader>

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {state.routines.length === 0 && runs.length === 0 ? (
          <div className="mx-auto mt-20 max-w-sm text-center">
            <div className="text-[15px] font-semibold">Nothing scheduled</div>
            <div className="mt-1 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
              A routine starts a fresh task on a bot, on a weekday schedule or once. HarnessBot has to be running when it is due.
            </div>
            <button type="button" onClick={() => setCreating(true)} className="mt-3 rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}>
              Schedule the first one
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
              {days.map((day) => {
                const dayRuns = runs.filter((r) => new Date(r.scheduledFor).toDateString() === day.toDateString());
                return (
                  <div key={day.toISOString()} className="card p-3">
                    <div className="text-[12px] font-semibold">{day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                    <div className="mt-2 flex flex-col gap-2">
                      {dayRuns.map((run) => (
                        <RunRow key={run.id} run={run} onOpen={() => dispatch({ type: 'select', selected: { kind: 'bot', id: run.botId } })} />
                      ))}
                      {dayRuns.length === 0 ? (
                        <div className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                          Nothing
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <h2 className="mt-6 text-[13px] font-semibold">Schedules</h2>
            {state.routines.map((routine) => (
              <div key={routine.id} className="card mt-2 flex items-center gap-3 p-3">
                <span className="flex-1">
                  <span className="block text-[13px] font-medium">{routine.name}</span>
                  <span className="block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                    {state.bots.find((b) => b.id === routine.botId)?.name ?? 'missing bot'} ·{' '}
                    {routine.schedule.kind === 'daily' ? `${routine.schedule.time} on ${routine.schedule.weekdays.length} day(s)` : new Date(routine.schedule.at).toLocaleString()}
                    {routine.nextRunAt ? ` · next ${new Date(routine.nextRunAt).toLocaleString()}` : ' · paused'}
                  </span>
                </span>
                <label className="flex items-center gap-1 text-[12px]">
                  <input type="checkbox" checked={routine.enabled} onChange={(e) => void api.patch(`/api/routines/${routine.id}`, { enabled: e.target.checked })} />
                  enabled
                </label>
                <button type="button" onClick={() => void api.post(`/api/routines/${routine.id}/run`).then(refreshRoutines)} className="rounded-lg px-2 py-1 text-[12px]" style={{ background: 'var(--color-raised)' }}>
                  Run now
                </button>
                <button type="button" onClick={() => void api.del(`/api/routines/${routine.id}`)} className="text-[12px]" style={{ color: 'var(--color-danger)' }}>
                  Delete
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {creating ? <NewRoutine onClose={() => setCreating(false)} onCreated={refreshRoutines} /> : null}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: RoutineRun; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="rounded-lg px-2 py-1.5 text-left" style={{ background: 'var(--color-inset)' }}>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_TONE[run.status] }} />
        <span className="flex-1 truncate text-[12px] font-medium">{run.routineName}</span>
      </span>
      <span className="block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {new Date(run.scheduledFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {run.status}
      </span>
    </button>
  );
}

function NewRoutine({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { state } = useStore();
  const [form, setForm] = useState({ name: '', prompt: '', botId: state.bots[0]?.id ?? '', kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], durationMinutes: 30 });

  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4" style={{ background: '#0009' }} onClick={onClose}>
      <div className="card anim-pop w-[min(520px,96vw)] p-4" style={{ background: 'var(--color-panel)' }} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-semibold">New routine</h2>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-3 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
        <select value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })} className="mt-2 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
          {state.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <textarea placeholder="What should it do?" rows={4} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} className="mt-2 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
        <div className="mt-2 flex gap-2">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
            <option value="daily">Weekdays</option>
            <option value="once">Once</option>
          </select>
          <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} className="rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
        </div>
        {form.kind === 'daily' ? (
          <div className="mt-2 flex gap-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setForm({ ...form, weekdays: form.weekdays.includes(index) ? form.weekdays.filter((d) => d !== index) : [...form.weekdays, index] })}
                className="h-7 w-7 rounded-lg text-[12px]"
                style={{ background: form.weekdays.includes(index) ? 'var(--color-accent)' : 'var(--color-inset)', color: form.weekdays.includes(index) ? 'var(--color-accent-ink)' : 'var(--color-ink)' }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!form.prompt || !form.botId}
            onClick={async () => {
              const [hh, mm] = form.time.split(':').map(Number);
              const at = new Date();
              at.setHours(hh ?? 9, mm ?? 0, 0, 0);
              if (at.getTime() < Date.now()) at.setDate(at.getDate() + 1);
              await api.post('/api/routines', {
                name: form.name || 'Routine',
                prompt: form.prompt,
                botId: form.botId,
                durationMinutes: form.durationMinutes,
                schedule: form.kind === 'daily' ? { kind: 'daily', time: form.time, weekdays: form.weekdays } : { kind: 'once', at: at.getTime() },
              });
              await onCreated();
              onClose();
            }}
            className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}
