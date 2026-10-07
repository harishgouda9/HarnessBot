import { describe, expect, it } from 'vitest';
import { listHistory } from './history.ts';
import { store } from './store.ts';

describe('chat history', () => {
  it('lists a bot task from the transcript it already has', () => {
    const bot = store.createBot({ name: 'Ada', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'where is the build' });
    const rows = listHistory();
    const row = rows.find((item) => item.threadId === bot.threadId);
    expect(row).toMatchObject({ botId: bot.id, botName: 'Ada', preview: 'where is the build' });
  });

  it('searches across threads and keeps one row per conversation', () => {
    const bot = store.createBot({ name: 'Bea', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'alpha lighthouse' });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'alpha lighthouse again' });
    const rows = listHistory('lighthouse');
    expect(rows.filter((item) => item.threadId === bot.threadId)).toHaveLength(1);
    expect(rows[0]?.preview).toContain('lighthouse');
  });
});
