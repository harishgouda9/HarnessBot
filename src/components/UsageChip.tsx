import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { formatCost, formatTokens, usageBreakdown } from '../usage.ts';
import { Icon } from './Icons.tsx';

/**
 * What the whole app has spent, in the status bar — and the switch that keeps it down.
 *
 * Folded from the roster the renderer already holds rather than fetched: usage is
 * banked per task and arrives on the same SSE event as everything else, so this
 * number cannot disagree with the per-task figure on a bot's panel.
 *
 * Cached input is counted. It is tokens the model read and the provider billed,
 * and hiding it would make every long conversation look cheaper than it was.
 */
export function UsageChip(): React.ReactElement {
  const { state, refreshConfig } = useStore();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const leanOn = state.config?.lean?.enabled !== false;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { total, perBot } = usageBreakdown(state.bots);
  const cost = formatCost(total.costUsd);

  const toggleLean = async (): Promise<void> => {
    await api.patch('/api/config', {
      lean: { enabled: !leanOn, preferSmallModel: state.config?.lean?.preferSmallModel === true },
    });
    await refreshConfig();
  };

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          total.tokens
            ? `${total.input.toLocaleString()} in · ${total.output.toLocaleString()} out${
                total.cachedInput ? ` · ${total.cachedInput.toLocaleString()} cached` : ''
              } · ${total.turns} turn${total.turns === 1 ? '' : 's'}`
            : 'Token usage and Lean'
        }
        aria-expanded={open}
        aria-label={
          total.tokens
            ? `Token usage: ${total.tokens.toLocaleString()} tokens across ${perBot.length} bot${perBot.length === 1 ? '' : 's'}`
            : 'Token usage and Lean'
        }
        className="flex items-center gap-1.5 rounded-lg px-2 py-1"
        style={{ background: open ? 'var(--color-raised)' : 'transparent' }}
      >
        <Icon name="wand" size={13} />
        <span className="tabular-nums">{total.tokens ? formatTokens(total.tokens) : 'Lean'}</span>
        {leanOn ? (
          <span className="rounded px-1 text-[10px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            on
          </span>
        ) : null}
        {cost ? <span style={{ color: 'var(--color-ink-secondary)' }}>{cost}</span> : null}
      </button>

      {open ? (
        <div
          className="absolute right-0 z-50 mt-1 w-80 rounded-lg border p-2 text-[11px] shadow-lg hairline"
          style={{ background: 'var(--color-panel)', color: 'var(--color-ink)' }}
          role="dialog"
          aria-label="Token usage"
        >
          <div className="mb-2 flex items-start gap-2 rounded-lg p-2" style={{ background: 'var(--color-inset)' }}>
            <span className="mt-0.5">
              <Icon name="wand" size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Lean</div>
              <p style={{ color: 'var(--color-ink-secondary)' }}>
                Tighter prompts: a short transcript, only the skills that look relevant, a digest of
                older turns. Same bot, smaller bill.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={leanOn}
              onClick={() => void toggleLean()}
              className="relative h-5 w-9 shrink-0 rounded-full"
              style={{ background: leanOn ? 'var(--color-accent)' : 'var(--color-raised)' }}
            >
              <span
                className="absolute top-0.5 h-4 w-4 rounded-full"
                style={{
                  background: leanOn ? 'var(--color-accent-ink)' : 'var(--color-ink-secondary)',
                  left: leanOn ? 16 : 2,
                }}
              />
            </button>
          </div>

          {total.leanSaved ? (
            <div className="mb-2 rounded-lg px-2 py-1.5" style={{ background: 'color-mix(in srgb, var(--color-success) 12%, transparent)' }}>
              Saved about {formatTokens(total.leanSaved)} tokens with Lean
            </div>
          ) : leanOn ? (
            <p className="mb-2" style={{ color: 'var(--color-ink-secondary)' }}>
              Savings show up after the next turn.
            </p>
          ) : (
            <p className="mb-2" style={{ color: 'var(--color-ink-secondary)' }}>
              Turn Lean on to cut what each bot sends.
            </p>
          )}

          {total.tokens ? (
            <>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="font-medium">Tokens used</span>
                <span className="tabular-nums" style={{ color: 'var(--color-ink-secondary)' }}>
                  {total.tokens.toLocaleString()}
                </span>
              </div>

              <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-0.5" style={{ color: 'var(--color-ink-secondary)' }}>
                <span>In</span>
                <span className="text-right tabular-nums">{total.input.toLocaleString()}</span>
                <span>Out</span>
                <span className="text-right tabular-nums">{total.output.toLocaleString()}</span>
                {total.cachedInput ? (
                  <>
                    <span>Cached in</span>
                    <span className="text-right tabular-nums">{total.cachedInput.toLocaleString()}</span>
                  </>
                ) : null}
                <span>Turns</span>
                <span className="text-right tabular-nums">{total.turns.toLocaleString()}</span>
                {cost ? (
                  <>
                    <span>Cost</span>
                    <span className="text-right tabular-nums">{cost}</span>
                  </>
                ) : null}
              </div>

              <div className="mb-1 font-medium">By bot</div>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                {perBot.map(({ bot, totals }) => (
                  <li key={bot.id} className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{bot.name}</span>
                    <span className="shrink-0 tabular-nums" style={{ color: 'var(--color-ink-secondary)' }}>
                      {formatTokens(totals.tokens)}
                      {totals.leanSaved ? ` · saved ${formatTokens(totals.leanSaved)}` : ''}
                      {formatCost(totals.costUsd) ? ` · ${formatCost(totals.costUsd)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="mt-2" style={{ color: 'var(--color-ink-secondary)' }}>
            Banked from completed turns. Providers that do not report usage count as zero.
          </p>
        </div>
      ) : null}
    </div>
  );
}
