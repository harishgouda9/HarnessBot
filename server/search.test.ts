import { describe, expect, it } from 'vitest';
import { filterMessages } from './search.ts';
import { store } from './store.ts';

describe('filterMessages', () => {
  it('keeps the message that matches a bot, room, date, or card filter and drops the other', () => {
    const ada = store.createBot({ name: 'Ada', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    const bea = store.createBot({ name: 'Bea', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    const room = store.createGroup({ name: 'Bridge', memberIds: [ada.id, bea.id] });
    const query = 'lighthouse';

    store.appendMessage(ada.threadId, { role: 'user', kind: 'text', text: `${query} on ada`, at: 1_700_000_000_000 });
    store.appendMessage(bea.threadId, { role: 'user', kind: 'text', text: `${query} on bea`, at: 1_800_000_000_000 });
    store.appendMessage(room.threadId, { role: 'user', kind: 'text', text: `${query} in the room`, at: 1_700_000_100_000 });
    store.appendMessage(ada.threadId, {
      role: 'bot',
      kind: 'goal.run',
      text: `${query} goal card`,
      at: 1_700_000_200_000,
      goalRun: { goalId: 'g1', goal: 'reach the light', coordinatorId: ada.id, status: 'working', turns: 1, maxTurns: 4 },
    });
    store.appendMessage(ada.threadId, {
      role: 'bot',
      kind: 'activity',
      text: `${query} tool card`,
      at: 1_700_000_300_000,
      tool: { name: 'shell', ok: true },
    });
    store.appendMessage(ada.threadId, {
      role: 'bot',
      kind: 'options',
      text: `${query} approval card`,
      at: 1_700_000_400_000,
      card: { title: 'Allow?', options: [{ id: 'allow', label: 'Allow' }], requestId: 'req_1' },
    });

    const byBot = filterMessages({ query, botId: ada.id });
    expect(byBot.every((hit) => hit.threadId === ada.threadId)).toBe(true);
    expect(byBot.some((hit) => hit.message.text?.includes('on bea'))).toBe(false);
    expect(byBot.some((hit) => hit.message.text?.includes('on ada'))).toBe(true);

    const byRoom = filterMessages({ query, roomId: room.id });
    expect(byRoom.map((hit) => hit.threadId)).toEqual([room.threadId]);

    const byDate = filterMessages({ query, from: 1_750_000_000_000 });
    expect(byDate.map((hit) => hit.message.text)).toEqual([`${query} on bea`]);

    const goals = filterMessages({ query, card: 'goal' });
    expect(goals.map((hit) => hit.message.kind)).toEqual(['goal.run']);
    const tools = filterMessages({ query, card: 'tool' });
    expect(tools.every((hit) => hit.message.tool?.name === 'shell')).toBe(true);
    expect(tools.some((hit) => hit.message.kind === 'options')).toBe(false);
    const approvals = filterMessages({ query, card: 'approval' });
    expect(approvals.map((hit) => hit.message.kind)).toEqual(['options']);
  });
});
