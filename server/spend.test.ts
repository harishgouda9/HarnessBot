import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath } from './paths.ts';
import { createRoutine, runRoutine } from './routines.ts';
import { evaluateSpend } from './spend.ts';
import { store } from './store.ts';
import { editUserMessage, releaseSpendHold, sendToBot } from './turns.ts';

describe('evaluateSpend', () => {
  it('allows a turn under the cap, warns as it approaches, and blocks at the cap until confirmed', () => {
    expect(evaluateSpend({ spentUsd: 1, capUsd: 5 })).toBe('allow');
    expect(evaluateSpend({ spentUsd: 4, capUsd: 5 })).toBe('warn');
    expect(evaluateSpend({ spentUsd: 5, capUsd: 5 })).toBe('block');
    expect(evaluateSpend({ spentUsd: 5.5, capUsd: 5 })).toBe('block');
    expect(evaluateSpend({ spentUsd: 5, capUsd: 5, confirmedUsd: 5 })).toBe('warn');
    expect(evaluateSpend({ spentUsd: 6, capUsd: 5, confirmedUsd: 5 })).toBe('block');
    expect(evaluateSpend({ spentUsd: 9, capUsd: undefined })).toBe('allow');
  });
});

describe('spend gates', () => {
  it('lets the next bot turn start while usage is under the cap, including the warning band', async () => {
    const under = store.createBot({ name: 'Under', modelSelection: { instanceId: 'fake', model: 'fake-1' }, spendCapUsd: 5 });
    store.addUsage(under.id, under.threadId, { input: 10, output: 10, costUsd: 1, turns: 1 });
    const allowed = await sendToBot({ botId: under.id, text: 'still under the cap' });
    expect(allowed.error).toBeUndefined();
    expect(allowed.messageId).toBeTruthy();

    const approaching = store.createBot({ name: 'Approaching', modelSelection: { instanceId: 'fake', model: 'fake-1' }, spendCapUsd: 5 });
    store.addUsage(approaching.id, approaching.threadId, { input: 10, output: 10, costUsd: 4, turns: 1 });
    expect(evaluateSpend({ spentUsd: 4, capUsd: store.getBot(approaching.id)!.spendCapUsd })).toBe('warn');
    const warned = await sendToBot({ botId: approaching.id, text: 'approaching the cap' });
    expect(warned.error).toBeUndefined();
    expect(warned.messageId).toBeTruthy();
  });

  it('blocks the next bot turn once usage is at the cap', async () => {
    const bot = store.createBot({ name: 'Capped', modelSelection: { instanceId: 'fake', model: 'fake-1' }, spendCapUsd: 2 });
    store.addUsage(bot.id, bot.threadId, { input: 10, output: 10, costUsd: 2, turns: 1 });
    const blocked = await sendToBot({ botId: bot.id, text: 'keep going' });
    expect(blocked.error).toBe('spend-cap');

    store.updateBot(bot.id, { spendConfirmedUsd: 2 });
    const verdict = evaluateSpend({
      spentUsd: 2,
      capUsd: store.getBot(bot.id)!.spendCapUsd,
      confirmedUsd: store.getBot(bot.id)!.spendConfirmedUsd,
    });
    expect(verdict).not.toBe('block');
    expect(store.getBot(bot.id)!.activity).toBe('waiting-on-you');
    releaseSpendHold(bot.id);
    expect(store.getBot(bot.id)!.activity).toBe('idle');
  });

  it('still sends a line that was already recorded, and refuses an edit before forking', async () => {
    const bot = store.createBot({ name: 'Queued cap', modelSelection: { instanceId: 'fake', model: 'fake-1' }, spendCapUsd: 2 });
    const recorded = store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'already asked' });
    store.addUsage(bot.id, bot.threadId, { input: 10, output: 10, costUsd: 2, turns: 1 });
    const drained = await sendToBot({ botId: bot.id, text: 'already asked', recordedMessageId: recorded.id });
    expect(drained.error).toBeUndefined();

    const edited = await editUserMessage(bot.id, bot.threadId, recorded.id, 'change the ask');
    expect(edited.error).toBe('spend-cap');
    const userLines = store.visiblePath(bot.threadId).filter((message) => message.role === 'user' && message.kind === 'text');
    expect(userLines.map((message) => message.text)).toEqual(['already asked']);
  });

  it('blocks the next routine run at its cap and does not start a task', async () => {
    const bot = store.createBot({ name: 'Routine cap', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    store.addUsage(bot.id, bot.threadId, { input: 10, output: 10, costUsd: 3, turns: 1 });
    const tasksBefore = store.getBot(bot.id)!.tasks!.length;
    const routine = createRoutine({
      name: 'Capped digest',
      prompt: 'Do not run.',
      botId: bot.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'once', at: Date.now() + 86_400_000 },
      durationMinutes: 5,
      spendCapUsd: 1,
    });
    const filePath = dataPath('routines.json');
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { runs: unknown[] };
    file.runs.push({
      id: 'run_prev',
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: 5,
      botId: bot.id,
      runOn: 'harnessbot',
      scheduledFor: Date.now() - 60_000,
      status: 'completed',
      manual: true,
      threadId: bot.threadId,
      finishedAt: Date.now() - 30_000,
    });
    fs.writeFileSync(filePath, JSON.stringify(file));

    const run = await runRoutine(routine, { manual: true });
    expect(run.status).toBe('waiting');
    expect(run.threadId).toBeUndefined();
    expect(run.output).toMatch(/Spend cap/);
    expect(store.getBot(bot.id)!.tasks!.length).toBe(tasksBefore);
  });
});
