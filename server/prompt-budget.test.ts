import { describe, expect, it } from 'vitest';
import { clip, clipList, estimateTokens, isQuickTurn, pickRelevant, pickSmallerModel, PROMPT_LIMITS, LEAN_LIMITS, limitsFor } from './prompt-budget.ts';

/**
 * The system prompt is rebuilt every turn, so a section with no ceiling is a bill
 * that repeats. These are the ceilings; the point of the tests is that they hold
 * on the shapes that actually grow — a pasted essay, and a host library with more
 * skills than anyone reads.
 */

describe('clip', () => {
  it('leaves anything already short alone', () => {
    expect(clip('short', 100)).toBe('short');
    expect(clip('exactly-ten', 11)).toBe('exactly-ten');
  });

  it('truncates and says so', () => {
    const clipped = clip('x'.repeat(500), 100);
    expect(clipped).toContain('(truncated)');
    expect(clipped.length).toBeLessThan(130);
  });

  it('prefers a word boundary when one is close to the cut', () => {
    const words = `${'word '.repeat(40)}tail`;
    expect(clip(words, 100)).not.toMatch(/wor… /);
    expect(clip(words, 100).endsWith('… (truncated)')).toBe(true);
  });

  it('survives empty and nullish input', () => {
    expect(clip('', 10)).toBe('');
    expect(clip(undefined as unknown as string, 10)).toBe('');
    expect(clip(null as unknown as string, 10)).toBe('');
  });
});

describe('clipList', () => {
  it('keeps everything when it fits', () => {
    expect(clipList([1, 2, 3], 5)).toEqual({ kept: [1, 2, 3], hidden: 0 });
  });

  it('reports what it hid', () => {
    expect(clipList([1, 2, 3, 4, 5], 2)).toEqual({ kept: [1, 2], hidden: 3 });
  });

  it('copies rather than aliasing the caller\'s array', () => {
    const source = [1, 2];
    const { kept } = clipList(source, 5);
    kept.push(3);
    expect(source).toEqual([1, 2]);
  });
});

describe('the ceilings hold on the shapes that grow', () => {
  it('bounds a pasted essay in a bot description', () => {
    const essay = 'lorem ipsum '.repeat(5000);
    expect(clip(essay, PROMPT_LIMITS.description).length).toBeLessThan(PROMPT_LIMITS.description + 40);
  });

  it('bounds a whole host skill library', () => {
    // The Hermes bridge makes 62 installable in one click; this is that case.
    const library = Array.from({ length: 62 }, (_, i) => ({
      name: `skill-${i}`,
      summary: 'a summary that runs on and on '.repeat(20),
    }));
    const { kept, hidden } = clipList(library, PROMPT_LIMITS.skillCount);
    const rendered = kept
      .map((s) => `- ${s.name}: ${clip(s.summary, PROMPT_LIMITS.skillSummary)}`)
      .join('\n');

    expect(hidden).toBe(22);
    // 40 lines of at most ~200 characters, rather than 62 of ~600.
    expect(rendered.length).toBeLessThan(PROMPT_LIMITS.skillCount * (PROMPT_LIMITS.skillSummary + 60));
    const uncapped = library.map((s) => `- ${s.name}: ${s.summary}`).join('\n').length;
    expect(rendered.length).toBeLessThan(uncapped / 4);
  });
});

describe('lean', () => {
  it('is a strict subset of the full ceilings', () => {
    const full = limitsFor(false);
    const lean = limitsFor(true);
    expect(lean.description).toBeLessThan(full.description);
    expect(lean.skillCount).toBeLessThan(full.skillCount);
    expect(lean.transcriptKeep).toBeLessThan(full.transcriptKeep);
    expect(lean).toEqual(LEAN_LIMITS);
    expect(full.transcriptKeep).toBe(PROMPT_LIMITS.transcriptKeep);
  });

  it('estimates tokens from character length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('keeps items that overlap the query and reports what it hid', () => {
    const items = [
      { name: 'calendar', summary: 'schedule meetings' },
      { name: 'web-research', summary: 'search the web' },
      { name: 'phone-harness', summary: 'android usb' },
    ];
    const { kept, hidden } = pickRelevant(items, 'search the public web', (s) => `${s.name} ${s.summary}`, 1);
    expect(kept.map((s) => s.name)).toEqual(['web-research']);
    expect(hidden).toBe(2);
  });

  it('falls back to original order when nothing matches', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(pickRelevant(items, 'zzzz', (s) => s, 2)).toEqual({ kept: ['a', 'b'], hidden: 2 });
  });

  it('treats a short ask as a quick turn and a toolkit ask as not', () => {
    expect(isQuickTurn('hi, what is 2+2?')).toBe(true);
    expect(isQuickTurn('please click the desktop and open chrome')).toBe(false);
    expect(isQuickTurn('open chrome')).toBe(false);
    expect(isQuickTurn('hello', { attachments: [{ id: 'a' }] })).toBe(false);
    expect(isQuickTurn('x'.repeat(300))).toBe(false);
  });

  it('picks a cheaper sibling on the same provider', () => {
    const models = [
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
    ];
    expect(pickSmallerModel(models, 'grok-4')).toBe('grok-4-fast');
    expect(pickSmallerModel(models, 'grok-4-fast')).toBeNull();
    expect(pickSmallerModel([{ id: 'grok-4', label: 'Grok 4' }], 'grok-4')).toBeNull();
  });
});
