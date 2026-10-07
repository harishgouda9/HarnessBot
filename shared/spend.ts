import type { BotRecord } from './types.ts';

/** Warn once spend reaches this fraction of the cap. The turn still runs. */
export const SPEND_WARN_RATIO = 0.8;

export type SpendVerdict = 'allow' | 'warn' | 'block';

/**
 * Whether the next turn may start.
 *
 * Under the cap is allowed. At the cap it blocks until the user has confirmed
 * spend at least this high. A confirmation does not raise the cap; the next
 * dollar past it asks again.
 */
export function evaluateSpend(input: { spentUsd: number; capUsd?: number; confirmedUsd?: number }): SpendVerdict {
  const cap = input.capUsd;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return 'allow';
  const spent = Number.isFinite(input.spentUsd) ? input.spentUsd : 0;
  if (spent >= cap) {
    if (input.confirmedUsd != null && Number.isFinite(input.confirmedUsd) && input.confirmedUsd >= spent) return 'warn';
    return 'block';
  }
  if (spent >= cap * SPEND_WARN_RATIO) return 'warn';
  return 'allow';
}

export function botSpentUsd(bot: Pick<BotRecord, 'tasks'>): number {
  return (bot.tasks ?? []).reduce((sum, task) => sum + (task.usage?.costUsd ?? 0), 0);
}
