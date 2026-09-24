import { describe, expect, it } from 'vitest';
import type { BotRecord } from '../shared/types.ts';
import { formatCost, formatTokens, isLean, totalsFor, usageBreakdown } from './usage.ts';

const bot = (name: string, tasks: { input?: number; output?: number; cachedInput?: number; costUsd?: number; turns?: number; leanSaved?: number }[]): BotRecord =>
  ({
    id: name,
    name,
    tasks: tasks.map((usage, i) => ({
      threadId: `${name}-${i}`,
      title: 'task',
      createdAt: 0,
      resumeCursors: {},
      usage: { input: 0, output: 0, turns: 0, ...usage },
    })),
  }) as unknown as BotRecord;

describe('totalsFor', () => {
  it('sums every task on a bot', () => {
    const totals = totalsFor(bot('a', [{ input: 10, output: 5, turns: 1 }, { input: 3, output: 2, turns: 1 }]));
    expect(totals).toMatchObject({ input: 13, output: 7, turns: 2, tokens: 20 });
  });

  it('counts cached input, because the model still read it', () => {
    expect(totalsFor(bot('a', [{ input: 10, output: 5, cachedInput: 100, turns: 1 }])).tokens).toBe(115);
  });

  it('is zero for a bot that has never run', () => {
    expect(totalsFor({ id: 'x', name: 'x' } as unknown as BotRecord).tokens).toBe(0);
  });

  it('survives a task with no usage banked yet', () => {
    const fresh = { id: 'x', name: 'x', tasks: [{ threadId: 't', title: 'task', createdAt: 0, resumeCursors: {} }] };
    expect(totalsFor(fresh as unknown as BotRecord)).toMatchObject({ tokens: 0, turns: 0 });
  });
});

describe('usageBreakdown', () => {
  const bots = [
    bot('quiet', [{ input: 1, output: 1, turns: 1 }]),
    bot('busy', [{ input: 500, output: 500, costUsd: 0.25, turns: 4 }]),
    bot('idle', []),
  ];

  it('totals the whole app', () => {
    expect(usageBreakdown(bots).total).toMatchObject({ input: 501, output: 501, turns: 5, tokens: 1002 });
    expect(usageBreakdown(bots).total.costUsd).toBeCloseTo(0.25);
  });

  it('lists the heaviest bot first and omits ones that never ran', () => {
    expect(usageBreakdown(bots).perBot.map((row) => row.bot.name)).toEqual(['busy', 'quiet']);
  });

  it('is empty, not broken, with no bots at all', () => {
    expect(usageBreakdown([])).toEqual({
      total: { input: 0, output: 0, cachedInput: 0, costUsd: 0, turns: 0, tokens: 0, leanSaved: 0 },
      perBot: [],
    });
  });
});

describe('leanSaved', () => {
  it('sums estimated tokens Lean kept out of the prompt', () => {
    expect(totalsFor(bot('a', [{ input: 10, output: 2, turns: 1, leanSaved: 40 }, { leanSaved: 10, turns: 1 }])).leanSaved).toBe(50);
  });
});

describe('isLean', () => {
  it('follows the workspace unless the bot pinned a value', () => {
    expect(isLean({}, true)).toBe(true);
    expect(isLean({}, false)).toBe(false);
    expect(isLean({ lean: false }, true)).toBe(false);
    expect(isLean({ lean: true }, false)).toBe(true);
  });
});

describe('formatting', () => {
  it('stays exact below a thousand', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(999)).toBe('999');
  });

  it('switches unit at each thousand', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(34_500)).toBe('35k');
    expect(formatTokens(999_999)).toBe('1000k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(15_000_000)).toBe('15M');
  });

  it('hides a cost of nothing and floors a tiny one', () => {
    expect(formatCost(0)).toBeNull();
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.239)).toBe('$1.24');
  });
});
