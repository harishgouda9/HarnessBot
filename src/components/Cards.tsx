import { useState } from 'react';
import type { Message } from '../../shared/types.ts';
import { api } from '../api.ts';
import { t } from '../i18n.ts';

/**
 * Cards are how consent happens: in the thread, in context, with the actual tool and
 * summary visible. Not a modal farm, and never a toast that expires while the user is
 * looking away (HB-UIUX-001 s3).
 */

const Button = ({
  children,
  onClick,
  variant = 'secondary',
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="rounded-lg px-3 py-1.5 text-[13px] font-medium transition-opacity disabled:opacity-40 min-h-8"
    style={{
      background:
        variant === 'primary' ? 'var(--color-accent)' : variant === 'danger' ? 'var(--color-danger)' : 'var(--color-raised)',
      color: variant === 'secondary' ? 'var(--color-ink)' : variant === 'primary' ? 'var(--color-accent-ink)' : '#fff',
    }}
  >
    {children}
  </button>
);

export function ApprovalCard({ message, botId }: { message: Message; botId: string }) {
  const [busy, setBusy] = useState(false);
  const card = message.card;
  if (!card) return null;

  const answered = card.answered;

  const respond = async (choiceId: string, answer?: string): Promise<void> => {
    setBusy(true);
    try {
      if (card.skillRequest) {
        // A skill card installs bytes. The digest is what the user actually approved.
        if (choiceId === 'confirm') {
          await api.post('/api/skills/confirm', { botId, name: card.skillRequest.name, sha256: card.skillRequest.sha256 });
        } else {
          await api.post('/api/skills/reject', { botId, name: card.skillRequest.name });
        }
        return;
      }
      if (card.routineRequest) {
        // The scheduler must not apply a chat-proposed routine until this click.
        if (choiceId === 'confirm') {
          await api.post('/api/routines', {
            botId,
            name: card.routineRequest.name,
            prompt: card.routineRequest.prompt,
            schedule: card.routineRequest.schedule,
            durationMinutes: card.routineRequest.durationMinutes,
          });
        }
        return;
      }
      if (card.requestId) await api.post(`/api/bots/${botId}/respond`, { requestId: card.requestId, choiceId, answer });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card anim-pop max-w-[560px] p-3">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: answered ? 'var(--color-ink-secondary)' : 'var(--color-warning)' }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{card.title}</div>
          {card.subtitle ? (
            <div className="mt-1 font-mono text-[12px] break-words" style={{ color: 'var(--color-ink-secondary)' }}>
              {card.subtitle}
            </div>
          ) : null}

          {card.held ? (
            <div className="mt-2 rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-warning)' }}>
              Held for review: {card.held}
            </div>
          ) : null}

          {card.approvalScope === 'local-computer' ? (
            <div className="mt-2 rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-danger)' }}>
              This acts on your real keyboard and mouse. Allowing here does not allow anything in the cloud.
            </div>
          ) : null}

          {card.allowKey && !answered ? (
            <div className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {/* Always show the exact key. "Remember my choice" hides what was granted. */}
              Always allow would remember <code className="font-mono">{card.allowKey}</code> only.
            </div>
          ) : null}

          {answered ? (
            <div className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {answered === 'allow'
                ? 'Allowed once.'
                : answered === 'deny'
                  ? 'Denied. The action did not run.'
                  : answered === 'unavailable'
                    ? 'No answer in time. The action did not run.'
                    : answered}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {card.options.map((option) => (
                <Button
                  key={option.id}
                  disabled={busy}
                  onClick={() => void respond(option.id)}
                  variant={option.destructive ? 'danger' : option.id === 'allow' || option.id === 'confirm' ? 'primary' : 'secondary'}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ConnectorCard({ message }: { message: Message }) {
  const [busy, setBusy] = useState(false);
  const card = message.connector;
  if (!card) return null;

  const connect = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.post<{ redirectUrl?: string }>('/api/connectors/authorize', { slug: card.slug });
      if (result.redirectUrl) window.open(result.redirectUrl, '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  };

  const tone =
    card.status === 'connected' ? 'var(--color-success)' : card.status === 'failed' ? 'var(--color-danger)' : 'var(--color-warning)';

  return (
    <div className="card anim-pop max-w-[560px] p-3">
      <div className="text-[13px] font-semibold">{card.label} needs to be connected</div>
      {card.reason ? (
        <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {card.reason}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: tone }}>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: tone }} />
        {card.status}
      </div>
      {card.status !== 'connected' ? (
        <div className="mt-3">
          <Button variant="primary" disabled={busy} onClick={() => void connect()}>
            {t('app.connect')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function SecretCard({ message, botId }: { message: Message; botId: string }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const card = message.secret;
  if (!card) return null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/api/bots/${botId}/secret-cards/${message.id}`, { value });
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card anim-pop max-w-[560px] p-3">
      <div className="text-[13px] font-semibold">{card.label}</div>
      <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {card.reason}
      </div>
      {card.provided ? (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--color-success)' }}>
          Saved. It is stored write-only and never shown again.
        </div>
      ) : (
        <>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste here, never in chat"
            autoComplete="off"
            className="mt-2 w-full rounded-lg px-2 py-1.5 text-[13px] font-mono"
            style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
          />
          <div className="mt-2">
            <Button variant="primary" disabled={busy || !value} onClick={() => void submit()}>
              Save credential
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function RoutineRunCard({ message }: { message: Message }) {
  const run = message.routineRun;
  if (!run) return null;
  const tone =
    run.status === 'completed'
      ? 'var(--color-success)'
      : run.status === 'failed' || run.status === 'missed'
        ? 'var(--color-danger)'
        : 'var(--color-warning)';
  return (
    <div className="card anim-pop max-w-[560px] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">{run.routineName}</span>
        <span className="text-[12px]" style={{ color: tone }}>
          {run.status}
        </span>
      </div>
      {run.output ? (
        <div className="mt-2 line-clamp-4 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {run.output}
        </div>
      ) : null}
    </div>
  );
}

export function GoalRunCard({ message }: { message: Message }) {
  const goal = message.goalRun;
  if (!goal) return null;
  return (
    <div className="card anim-pop max-w-[560px] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">Goal</span>
        <span className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {goal.status} · {goal.turns}/{goal.maxTurns} turns
        </span>
      </div>
      <div className="mt-1 text-[13px]">{goal.goal}</div>
      {goal.summary ? (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {goal.summary}
        </div>
      ) : null}
    </div>
  );
}

/** Tool chip. Always has a text label — state is never conveyed by colour alone. */
export function ActivityChip({ message }: { message: Message }) {
  const tool = message.tool;
  const failed = tool?.ok === false;
  return (
    <div
      className="anim-msg inline-flex max-w-full items-center gap-2 rounded-full px-2.5 py-1 text-[12px]"
      style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: failed ? 'var(--color-danger)' : tool?.ok ? 'var(--color-success)' : 'var(--color-ink-secondary)' }}
      />
      <span className="font-medium">{tool?.name ?? 'activity'}</span>
      {message.text ? <span className="truncate">{message.text}</span> : null}
      {tool?.setup ? <span style={{ color: 'var(--color-warning)' }}>needs setup</span> : null}
    </div>
  );
}
