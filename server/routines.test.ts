import { describe, expect, it } from 'vitest';
import { computeNextRun } from './routines.ts';

/**
 * Scheduling is where "it worked on my machine at 3pm" hides. These pin the two
 * behaviours that matter: the next slot is a real local calendar time, and a schedule
 * with no future slot returns null instead of a stale timestamp.
 */

const at = (iso: string) => new Date(iso).getTime();

describe('computeNextRun', () => {
  it('returns a one-off time only while it is still in the future', () => {
    const future = at('2030-01-01T09:00:00');
    expect(computeNextRun({ kind: 'once', at: future }, at('2029-12-31T09:00:00'))).toBe(future);
    expect(computeNextRun({ kind: 'once', at: future }, at('2030-01-02T09:00:00'))).toBeNull();
  });

  it('finds the next matching weekday at the right local time', () => {
    // 2026-09-09 is a Wednesday. Ask for Friday.
    const from = at('2026-09-09T10:00:00');
    const next = computeNextRun({ kind: 'daily', time: '08:30', weekdays: [5] }, from)!;
    const date = new Date(next);
    expect(date.getDay()).toBe(5);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(30);
    expect(next).toBeGreaterThan(from);
  });

  it('rolls to tomorrow when today’s slot has already passed', () => {
    const from = at('2026-09-09T10:00:00'); // Wednesday morning
    const next = computeNextRun({ kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }, from)!;
    expect(new Date(next).getDate()).toBe(10);
    expect(new Date(next).getHours()).toBe(9);
  });

  it('takes today when the slot is still ahead', () => {
    const from = at('2026-09-09T07:00:00');
    const next = computeNextRun({ kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }, from)!;
    expect(new Date(next).getDate()).toBe(9);
  });

  it('defaults an empty weekday list to Monday through Friday', () => {
    const next = computeNextRun({ kind: 'daily', time: '09:00', weekdays: [] }, at('2026-09-12T10:00:00'))!;
    // Saturday the 12th, so the next run is Monday the 14th.
    expect(new Date(next).getDay()).toBe(1);
  });

  it('rejects an unparseable time instead of scheduling at midnight', () => {
    expect(computeNextRun({ kind: 'daily', time: 'not-a-time', weekdays: [1] })).toBeNull();
  });
});
