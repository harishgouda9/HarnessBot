import { pickBusyBot } from '../busy-strip.ts';
import { t } from '../i18n.ts';
import { useStore } from '../store.tsx';
import { useTrace } from '../stream-store.ts';
import { workLine } from '../work-line.ts';

/**
 * One thin sign under the top bar, on every page. It stays while a bot's turn
 * is open, including when the chat for that bot is not on screen.
 */
export function BusyStrip() {
  const { state, dispatch } = useStore();
  const pick = pickBusyBot(state.bots);
  const bot = pick ? state.bots.find((item) => item.id === pick.id) : undefined;
  const trace = useTrace(bot?.threadId ?? '');
  if (!pick || !bot) return null;

  const thread = state.threads[bot.threadId];
  const live = trace.find(
    (entry) =>
      entry.detail &&
      (entry.type === 'item.started' || entry.type === 'item.completed' || entry.type === 'request.opened' || entry.type === 'runtime.error'),
  );
  const line = workLine({
    activity: bot.activity,
    userTexts: (thread?.messages ?? [])
      .filter((message) => message.role === 'user' && message.kind === 'text' && message.text)
      .map((message) => message.text ?? ''),
    liveDetail: live?.detail,
  });
  const detail = line && line.text !== 'Working' && line.text !== 'Waiting on you' ? line.text : '';
  const waiting = pick.activity === 'waiting-on-you';
  const label = `${pick.name} · ${waiting ? t('app.needsYou') : t('app.working')}${pick.extra ? ` · +${pick.extra}` : ''}`;
  const color = waiting ? 'var(--color-warning)' : 'var(--color-success)';

  return (
    <button
      type="button"
      data-busy-strip=""
      role="status"
      aria-live="polite"
      title={detail ? `${label} — ${detail}` : label}
      onClick={() => dispatch({ type: 'select', selected: { kind: 'bot', id: pick.id } })}
      className="flex h-[22px] w-full items-center gap-2 border-b px-3 text-left hairline"
      style={{
        background: `color-mix(in srgb, ${color} 12%, var(--color-panel))`,
      }}
    >
      <span
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${waiting ? '' : 'status-pulse'}`}
        style={{ background: color }}
      />
      <span className="shrink-0 text-[11px] leading-none font-semibold" style={{ color }}>
        {label}
      </span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-[11px] leading-none" style={{ color: 'var(--color-ink-secondary)' }}>
          {detail}
        </span>
      ) : null}
    </button>
  );
}
