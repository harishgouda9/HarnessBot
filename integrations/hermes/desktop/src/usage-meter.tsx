import { Popover, PopoverContent, PopoverTrigger, ScrollArea, Tip, cn, useQuery } from '@hermes/plugin-sdk';
import { useMemo } from 'react';
import { formatCost, formatTokens, usageBreakdown } from '../../../../src/usage.ts';
import { Harness, KEYS, type PluginCtx } from './harness.ts';

/**
 * Tokens spent, in Hermes' status bar.
 *
 * The aggregation is the same module the HarnessBot web UI uses, imported rather
 * than reimplemented — two counters that can disagree are worse than one, and the
 * arithmetic (cached input counts, because the model read it) is already tested
 * there.
 */
export function UsageMeter({ ctx }: { ctx: PluginCtx }) {
  const harness = useMemo(() => new Harness(ctx), [ctx]);
  const bots = useQuery({ queryKey: KEYS.bots, queryFn: () => harness.bots(), refetchInterval: 15_000 });

  const { total, perBot } = usageBreakdown(bots.data ?? []);
  // Nothing has run yet: an empty meter is noise, not information.
  if (!total.tokens) return null;

  const cost = formatCost(total.costUsd);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`HarnessBot token usage: ${total.tokens.toLocaleString()} tokens`}
          className={cn('inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem]', 'text-(--ui-text-tertiary)')}
        >
          <Tip label={`${total.input.toLocaleString()} in · ${total.output.toLocaleString()} out · ${total.turns} turns`}>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden>◷</span>
              <span className="tabular-nums">{formatTokens(total.tokens)}</span>
              {cost ? <span>{cost}</span> : null}
            </span>
          </Tip>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2 text-xs">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="font-medium">HarnessBot tokens</span>
          <span className="tabular-nums">{total.tokens.toLocaleString()}</span>
        </div>
        <ScrollArea className="max-h-56">
          <ul className="space-y-0.5">
            {perBot.map(({ bot, totals }) => (
              <li key={bot.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate">{bot.name}</span>
                <span className="shrink-0 tabular-nums text-(--ui-text-tertiary)">{formatTokens(totals.tokens)}</span>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
