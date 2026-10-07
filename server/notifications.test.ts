import { describe, expect, it } from 'vitest';
import { notificationTarget, notifications, notify } from './notifications.ts';
import { nativeNotice } from './desktop.ts';
import { store } from './store.ts';

describe('notificationTarget', () => {
  it('names the bot and the task a notification opens', () => {
    const bot = store.createBot({ name: 'Ada', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    store.updateTask(bot.id, bot.threadId, { title: 'Overnight watch' });
    const saved = store.getBot(bot.id)!;
    const target = notificationTarget(saved, {
      kind: 'needs-approval',
      threadId: saved.threadId,
      preview: 'click Send on the phone',
    });
    expect(target.botId).toBe(saved.id);
    expect(target.botName).toBe('Ada');
    expect(target.threadId).toBe(saved.threadId);
    expect(target.taskTitle).toBe('Overnight watch');

    notify(saved, { kind: 'needs-approval', threadId: saved.threadId, preview: 'click Send on the phone' });
    const listed = notifications.list()[0]!;
    expect(listed.botName).toBe('Ada');
    expect(listed.taskTitle).toBe('Overnight watch');
    expect(listed.threadId).toBe(saved.threadId);

    const notice = nativeNotice(listed);
    expect(notice.title).toBe('Ada · Overnight watch');
    expect(notice.botId).toBe(saved.id);
    expect(notice.threadId).toBe(saved.threadId);
  });
});
