import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repairOrg, store, stripLegacyHelpers } from './store.ts';
import { redactSecretsInText } from './redact.ts';
import { dataPath } from './paths.ts';
import { AVATAR_SHAPES, type BotRecord } from '../shared/types.ts';

const makeBot = (name: string, extra: Partial<BotRecord> = {}) =>
  store.createBot({ name, modelSelection: { instanceId: 'fake', model: 'fake-1' }, ...extra });

describe('bot silhouette', () => {
  it('keeps every known shape and drops an unknown one', () => {
    for (const shape of AVATAR_SHAPES) {
      const bot = makeBot(shape, { avatarShape: shape });
      expect(store.getBot(bot.id)!.avatarShape).toBe(shape);
    }
    const dropped = makeBot('NotAShape', { avatarShape: 'star' as never });
    expect(store.getBot(dropped.id)!.avatarShape).toBeUndefined();
  });
});

describe('store persistence', () => {
  it('redacts bot-authored text but leaves user text exactly as typed', () => {
    const bot = makeBot('Redact');
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz012345';

    const fromBot = store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: `here it is: ${secret}` });
    const fromUser = store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: `mine is ${secret}` });

    expect(fromBot.text).not.toContain(secret);
    expect(fromBot.text).toContain('[redacted]');
    // Rewriting what the user typed would be worse than storing it.
    expect(fromUser.text).toContain(secret);
  });

  it('redacts nested card fields, not just the message body', () => {
    const bot = makeBot('Cards');
    const message = store.appendMessage(bot.threadId, {
      role: 'bot',
      kind: 'options',
      card: { title: 'Run this', subtitle: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01', options: [] },
    });
    expect(message.card!.subtitle).toContain('[redacted]');
  });

  it('survives a reload: messages come back from SQLite', () => {
    const bot = makeBot('Persist');
    store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'ping' });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'pong' });
    expect(store.listMessages(bot.threadId).map((m) => m.text)).toEqual(['ping', 'pong']);
  });

  it('keeps arrival order when two messages share a millisecond', () => {
    // A send and its first tool chip routinely land in the same tick. Ordering fell
    // back to the random message id, which sorted the transcript at random.
    const bot = makeBot('SameTick');
    const at = 1_700_000_000_000;
    store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'first', at });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'second', at });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'third', at });

    expect(store.listMessages(bot.threadId).map((m) => m.text)).toEqual(['first', 'second', 'third']);
    // The windowed read takes the tail and must not reverse it either.
    expect(store.listMessages(bot.threadId, 2).map((m) => m.text)).toEqual(['second', 'third']);
  });

  it('emits exactly one StoreChange per write', () => {
    const bot = makeBot('Emit');
    const changes: string[] = [];
    const listener = (c: { type: string }) => changes.push(c.type);
    store.on('change', listener);
    store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'hi' });
    store.off('change', listener);
    // message + thread (the active leaf moved). No write is silent.
    expect(changes).toEqual(['message', 'thread']);
  });
});

describe('search', () => {
  it('finds a legacy transcript that has not been opened', () => {
    const bot = makeBot('LegacySearch');
    const phrase = 'uniquelegacyphrase';
    fs.writeFileSync(
      dataPath(`messages-${bot.threadId}.json`),
      JSON.stringify([{ id: 'm_legacy', at: 1, role: 'user', kind: 'text', text: phrase }]),
    );
    expect(store.search(phrase).some((hit) => hit.message.text === phrase)).toBe(true);
    expect(fs.existsSync(dataPath(`messages-${bot.threadId}.json`))).toBe(false);
    expect(fs.existsSync(dataPath(`messages-${bot.threadId}.json.imported`))).toBe(true);
  });

  it('does not let a legacy backup overwrite a message already in sqlite', () => {
    const bot = makeBot('LegacyKeep');
    store.appendMessage(bot.threadId, { id: 'm_keep', role: 'user', kind: 'text', text: 'current text' });
    fs.writeFileSync(
      dataPath(`messages-${bot.threadId}.json`),
      JSON.stringify([{ id: 'm_keep', at: 1, role: 'user', kind: 'text', text: 'stale backup' }]),
    );
    expect(store.search('current text').some((hit) => hit.message.id === 'm_keep')).toBe(true);
    expect(store.getMessage(bot.threadId, 'm_keep')?.text).toBe('current text');
  });
});

describe('branching', () => {
  it('an edit forks the path and hides the abandoned branch', () => {
    const bot = makeBot('Branch');
    const first = store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'original' });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'reply to original' });

    // An edit shares the original's parent, so both versions exist on disk.
    const edited = store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'edited', parentId: first.parentId ?? null });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'reply to edit' });

    const visible = store.visiblePath(bot.threadId).map((m) => m.text);
    expect(visible).toEqual(['edited', 'reply to edit']);
    expect(store.listMessages(bot.threadId)).toHaveLength(4);

    // Switching the leaf back reveals the other branch again; nothing was destroyed.
    // Find it by content: messages written in the same millisecond have no stable order.
    const abandonedLeaf = store.listMessages(bot.threadId).find((m) => m.text === 'reply to original')!;
    store.setActiveLeaf(bot.threadId, abandonedLeaf.id);
    expect(store.visiblePath(bot.threadId).map((m) => m.text)).toEqual(['original', 'reply to original']);
    expect(edited.parentId).toBe(first.parentId ?? null);
  });
});

describe('task isolation', () => {
  it('a second task does not inherit the first task resume cursor', () => {
    const bot = makeBot('Tasks');
    // Capture first: creating a task also makes it the bot's active thread.
    const firstThread = bot.threadId;
    store.setResumeCursor(bot.id, firstThread, 'fake', 'session-one');
    const second = store.createTask(bot.id, 'second')!;

    expect(store.getResumeCursor(bot.id, firstThread, 'fake')).toBe('session-one');
    // Sharing this would undo task isolation entirely.
    expect(store.getResumeCursor(bot.id, second.threadId, 'fake')).toBeUndefined();
  });

  it('a rewind drops cursors so the next turn replays the visible branch', () => {
    const bot = makeBot('Rewind');
    store.setResumeCursor(bot.id, bot.threadId, 'fake', 'session-two');
    store.dropCursors(bot.id, bot.threadId);
    expect(store.getResumeCursor(bot.id, bot.threadId, 'fake')).toBeUndefined();
  });

  it('banks usage additively from completed turns', () => {
    const bot = makeBot('Usage');
    store.addUsage(bot.id, bot.threadId, { input: 10, output: 4, costUsd: 0.01 });
    store.addUsage(bot.id, bot.threadId, { input: 5, output: 2, costUsd: 0.02 });
    const usage = store.getTask(store.getBot(bot.id)!, bot.threadId)!.usage!;
    expect(usage).toMatchObject({ input: 15, output: 6, turns: 2 });
    expect(usage.costUsd).toBeCloseTo(0.03);
  });
});

describe('roster rules', () => {
  it('allows at most one Chief of Staff per section', () => {
    const a = makeBot('ChiefA', { section: 'Work' });
    const b = makeBot('ChiefB', { section: 'Work' });
    const other = makeBot('ChiefC', { section: 'Personal' });

    store.setChiefOfStaff(a.id, true);
    store.setChiefOfStaff(b.id, true);
    store.setChiefOfStaff(other.id, true);

    expect(store.getBot(a.id)!.chiefOfStaff).toBe(false);
    expect(store.getBot(b.id)!.chiefOfStaff).toBe(true);
    // A different section keeps its own chief.
    expect(store.getBot(other.id)!.chiefOfStaff).toBe(true);
  });

  it('repairs self-links, dangling managers, and cycles on load', () => {
    const bots = [
      { id: 'a', reportsTo: 'b' },
      { id: 'b', reportsTo: 'a' },
      { id: 'c', reportsTo: 'c' },
      { id: 'd', reportsTo: 'ghost' },
    ] as BotRecord[];

    repairOrg(bots);

    expect(bots[2]!.reportsTo).toBeUndefined(); // self-link
    expect(bots[3]!.reportsTo).toBeUndefined(); // dangling manager
    // The ring is broken, but not both ends: the chart still has a hierarchy.
    const stillLinked = bots.filter((b) => b.reportsTo).length;
    expect(stillLinked).toBeLessThan(2);
  });

  it('drops leftover helper-lease records that the spawn path never created', () => {
    const bots = [
      { id: 'keep' },
      { id: 'ghost', helper: { parentBotId: 'keep', depth: 1, expiresAt: Date.now() - 1 } },
    ] as BotRecord[];
    expect(stripLegacyHelpers(bots)).toBe(true);
    expect(bots.map((b) => b.id)).toEqual(['keep']);
    expect(stripLegacyHelpers(bots)).toBe(false);
  });

  it('a bot-to-bot DM is mentions-only so nobody answers by accident', () => {
    const a = makeBot('Peer A');
    const b = makeBot('Peer B');
    const dm = store.dmChannel(store.getBot(a.id)!, store.getBot(b.id)!);
    expect(dm.defaultResponder).toBe('mentions');
    // The same pair reuses the same channel rather than piling up duplicates.
    expect(store.dmChannel(store.getBot(a.id)!, store.getBot(b.id)!).id).toBe(dm.id);
  });
});

describe('redaction patterns', () => {
  it.each([
    ['sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa'],
    ['xai-aaaaaaaaaaaaaaaaaaaa'],
    ['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['ak_aaaaaaaaaaaaaaaaaaaa'],
    ['AKIAIOSFODNN7EXAMPLE'],
  ])('redacts %s', (secret) => {
    expect(redactSecretsInText(`value: ${secret}`)).not.toContain(secret);
  });

  it('leaves ordinary prose alone', () => {
    const text = 'The token bucket algorithm smooths bursty traffic.';
    expect(redactSecretsInText(text)).toBe(text);
  });
});
