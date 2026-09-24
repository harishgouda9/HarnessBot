import type { BotRecord } from '../shared/types.ts';

/**
 * Token totals, folded from what the harness already banks.
 *
 * Usage is banked per task on `turn.completed` and rides to the renderer on the
 * same SSE `bot` event as everything else, so the roster in hand is already the
 * whole truth — there is no separate endpoint to poll and nothing here can drift
 * from what the transcript says.
 */

export interface UsageTotals {
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number;
  turns: number;
  /** What the chip shows: everything the model actually read or wrote. */
  tokens: number;
  leanSaved: number;
}

export const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cachedInput: 0, costUsd: 0, turns: 0, tokens: 0, leanSaved: 0 };

export function isLean(bot: { lean?: boolean }, workspaceEnabled: boolean): boolean {
  if (bot.lean === true) return true;
  if (bot.lean === false) return false;
  return workspaceEnabled;
}

export function totalsFor(bot: BotRecord): UsageTotals {
  const totals = { ...EMPTY_USAGE };
  for (const task of bot.tasks ?? []) {
    const usage = task.usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cachedInput += usage.cachedInput ?? 0;
    totals.costUsd += usage.costUsd ?? 0;
    totals.turns += usage.turns ?? 0;
    totals.leanSaved += usage.leanSaved ?? 0;
  }
  // Cached input was still read by the model, and a bill that counts it is the
  // one the user gets — leaving it out would understate every long conversation.
  totals.tokens = totals.input + totals.output + totals.cachedInput;
  return totals;
}

export interface UsageBreakdown {
  total: UsageTotals;
  perBot: { bot: BotRecord; totals: UsageTotals }[];
}

/** Everything the whole app has spent, and who spent it. Heaviest bot first. */
export function usageBreakdown(bots: BotRecord[]): UsageBreakdown {
  const total = { ...EMPTY_USAGE };
  const perBot: { bot: BotRecord; totals: UsageTotals }[] = [];

  for (const bot of bots) {
    const totals = totalsFor(bot);
    if (totals.turns || totals.tokens) perBot.push({ bot, totals });
    total.input += totals.input;
    total.output += totals.output;
    total.cachedInput += totals.cachedInput;
    total.costUsd += totals.costUsd;
    total.turns += totals.turns;
    total.tokens += totals.tokens;
    total.leanSaved += totals.leanSaved;
  }

  perBot.sort((a, b) => b.totals.tokens - a.totals.tokens);
  return { total, perBot };
}

/** Compact enough for a status bar: 812, 34.5k, 1.2M. */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Cost is only worth showing once it is not zero to two decimal places. */
export function formatCost(costUsd: number): string | null {
  if (!costUsd) return null;
  return costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
}
