import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { botDuplicateFields } from './bot-copy.ts';
import { forgetBot } from './forget-bot.ts';
import { mintInternalToken, verifyInternalToken } from './internal-tokens.ts';
import { dataPath } from './paths.ts';
import { createRoutine, listRoutines, listRuns } from './routines.ts';
import { store } from './store.ts';
import { listWebhooks, createWebhook } from './webhooks.ts';

describe('forgetting a bot', () => {
  it('removes logs, attachments, routines, webhooks, and the internal token', async () => {
    const bot = store.createBot({ name: 'Ada', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    const token = mintInternalToken(bot.id);
    const routine = createRoutine({
      name: 'Morning',
      prompt: 'hello',
      botId: bot.id,
      runOn: 'harnessbot',
      enabled: false,
      schedule: { kind: 'once', at: Date.now() + 86_400_000 },
      durationMinutes: 5,
    });
    const hook = createWebhook('inbound', routine.id);
    const events = dataPath('events', `${bot.threadId}.ndjson`);
    const native = dataPath('native', `${bot.threadId}.ndjson`);
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(events, '{"type":"turn.completed"}\n');
    fs.writeFileSync(native, '{"msg":"raw model text"}\n');
    const attachments = dataPath('attachments');
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(path.join(attachments, 'gone.txt'), 'bot file');
    fs.writeFileSync(path.join(attachments, 'keep.txt'), 'other bot');
    store.appendMessage(bot.threadId, {
      role: 'user',
      kind: 'text',
      text: 'see attached',
      attachments: [{ id: 'gone', name: 'gone.txt', mime: 'text/plain', url: '/api/attachments/gone.txt' }],
    });

    expect(verifyInternalToken(bot.id, token)).toBe(true);
    expect(await forgetBot(bot.id)).toBe(true);

    expect(store.getBot(bot.id)).toBeUndefined();
    expect(listRoutines().some((item) => item.id === routine.id)).toBe(false);
    expect(listRuns({ botId: bot.id })).toEqual([]);
    expect(listWebhooks().some((item) => item.id === hook.record.id)).toBe(false);
    expect(verifyInternalToken(bot.id, token)).toBe(false);
    expect(fs.existsSync(events)).toBe(false);
    expect(fs.existsSync(native)).toBe(false);
    expect(fs.existsSync(path.join(attachments, 'gone.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(attachments, 'keep.txt'), 'utf8')).toBe('other bot');
  });

  it('copies the spend cap and voice settings without copying grants or a spend confirmation', () => {
    const bot = store.createBot({
      name: 'Ada',
      modelSelection: { instanceId: 'fake', model: 'fake-1', effort: 'high', auto: true },
      spendCapUsd: 4,
    });
    store.updateBot(bot.id, {
      alwaysAllow: ['Bash:git'],
      alwaysAllowLocalComputer: ['computer_click'],
      spendConfirmedUsd: 4,
      speakReplies: true,
    });
    const copy = store.createBot(botDuplicateFields(store.getBot(bot.id)!));
    expect(copy.id).not.toBe(bot.id);
    expect(copy.threadId).not.toBe(bot.threadId);
    expect(copy.name).toBe('Ada copy');
    expect(copy.spendCapUsd).toBe(4);
    expect(copy.speakReplies).toBe(true);
    expect(copy.modelSelection).toEqual({ instanceId: 'fake', model: 'fake-1', effort: 'high', auto: true });
    expect(copy.alwaysAllow).toBeUndefined();
    expect(copy.alwaysAllowLocalComputer).toBeUndefined();
    expect(copy.spendConfirmedUsd).toBeUndefined();
  });
});
