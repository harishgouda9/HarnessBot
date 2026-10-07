import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvals, readDecisions } from './approvals.ts';
import { saveConfig } from './config.ts';
import type { RuntimeEvent } from './contracts.ts';
import { registry } from './harness/registry.ts';
import { routineHoldsApprovals } from './routine-hold.ts';
import { CATCH_UP_GRACE_MS, computeNextRun, confirmCatchUp, createRoutine, dueDecision, listRuns, offerCatchUps, runRoutine } from './routines.ts';
import { store } from './store.ts';
import { fakeDriver } from './testing/fake-driver.ts';
import { interrupt, isTurnActive, startEventRouting } from './turns.ts';

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

  it('schedules an interval strictly in the future', () => {
    const from = at('2026-09-09T10:00:00');
    const next = computeNextRun({ kind: 'interval', everyMinutes: 15 }, from)!;
    expect(next - from).toBe(15 * 60_000);
    expect(next).toBeGreaterThan(from);
    expect(computeNextRun({ kind: 'interval', everyMinutes: 0 }, from)).toBeNull();
  });

  it('schedules the next monthly day, skipping months that lack it', () => {
    const from = at('2026-01-31T10:00:00');
    const next = computeNextRun({ kind: 'monthly', day: 31, time: '09:00' }, from)!;
    const date = new Date(next);
    expect(date.getDate()).toBe(31);
    expect(date.getMonth()).toBe(2);
    expect(date.getHours()).toBe(9);
    expect(next).toBeGreaterThan(from);
    expect(computeNextRun({ kind: 'monthly', day: 0, time: '09:00' }, from)).toBeNull();
  });
});

describe('catch-up', () => {
  it('offers a run that came due while stopped and does not execute it until confirmed', async () => {
    const routine = createRoutine({
      name: 'Morning digest',
      prompt: 'Summarise overnight.',
      botId: 'bot_missing',
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'interval', everyMinutes: 15 },
      durationMinutes: 5,
    });
    const due = routine.nextRunAt!;
    expect(dueDecision(due, due + CATCH_UP_GRACE_MS + 1_000)).toBe('catch-up');

    const offered = offerCatchUps(due + CATCH_UP_GRACE_MS + 1_000);
    const run = offered.find((item) => item.routineId === routine.id)!;
    expect(run.status).toBe('catch-up');
    expect(run.threadId).toBeUndefined();
    expect(run.startedAt).toBeUndefined();
    expect(listRuns().find((item) => item.id === run.id)?.status).toBe('catch-up');
    expect(store.getBot('bot_missing')).toBeUndefined();

    const confirmed = await confirmCatchUp(run.id);
    expect(confirmed?.status).toBe('failed');
    expect(confirmed?.output).toMatch(/no longer exists/);
    expect(confirmed?.threadId).toBeUndefined();
    expect(listRuns().find((item) => item.id === run.id)?.status).toBe('failed');
  });
});

describe('routine computer hold', () => {
  let stopRouting: (() => void) | undefined;

  beforeAll(async () => {
    saveConfig({ instances: { fake: { driver: 'fake', displayName: 'Fake' } } });
    registry.register(fakeDriver as never);
    await registry.reload();
    stopRouting = startEventRouting();
  });

  afterAll(async () => {
    stopRouting?.();
    await registry.disposeAll();
  });

  function computerRequest(threadId: string): Extract<RuntimeEvent, { type: 'request.opened' }> {
    return {
      eventId: 'e',
      provider: 'fake',
      threadId,
      createdAt: Date.now(),
      type: 'request.opened',
      requestKind: 'permission',
      toolName: 'computer_click',
      summary: 'click the send button',
      requestId: `req_${Math.random().toString(36).slice(2)}`,
    };
  }

  it('keeps the hold after the wait times out while the turn is still active', async () => {
    const bot = store.createBot({
      name: 'HeldRoutine',
      modelSelection: { instanceId: 'fake', model: 'fake-1' },
      autoApprove: false,
    });
    const routine = createRoutine({
      name: 'Stuck hands',
      prompt: 'please /permission before you click',
      botId: bot.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'once', at: Date.now() + 86_400_000 },
      // One second. The permission turn does not complete, so the wait times out first.
      durationMinutes: 1 / 60,
    });

    const run = await runRoutine(routine, { manual: true });
    expect(run.threadId).toBeTruthy();
    expect(run.status).toBe('failed');
    expect(run.output).toMatch(/time limit/);
    expect(isTurnActive(run.threadId!)).toBe(true);
    expect(routineHoldsApprovals(run.threadId!)).toBe(true);

    const routineThread = run.threadId!;
    const showing = `t_switched_${bot.id}`;
    store.updateBot(bot.id, { threadId: showing, autoApprove: true });
    const before = readDecisions().length;
    const auto = approvals.open(store.getBot(bot.id)!, computerRequest(routineThread), 'fake');
    expect(auto).toBe(false);
    expect(readDecisions().slice(before).some((entry) => entry.source === 'auto')).toBe(false);
    expect(routineHoldsApprovals(routineThread)).toBe(true);
    expect(store.listMessages(showing).some((message) => message.kind === 'options')).toBe(true);

    await interrupt(bot.id, routineThread);
    expect(isTurnActive(routineThread)).toBe(false);
    expect(routineHoldsApprovals(routineThread)).toBe(false);
  });

  it('releases the hold when the routine turn completes', async () => {
    const bot = store.createBot({
      name: 'FinishedRoutine',
      modelSelection: { instanceId: 'fake', model: 'fake-1' },
      autoApprove: false,
    });
    const routine = createRoutine({
      name: 'Quick hello',
      prompt: 'hello',
      botId: bot.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'once', at: Date.now() + 86_400_000 },
      durationMinutes: 5,
    });

    const run = await runRoutine(routine, { manual: true });
    expect(run.status).toBe('completed');
    expect(run.threadId).toBeTruthy();
    expect(isTurnActive(run.threadId!)).toBe(false);
    expect(routineHoldsApprovals(run.threadId!)).toBe(false);
  });
});
