import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message } from '../shared/types.ts';
import { approvals } from './approvals.ts';
import { saveConfig } from './config.ts';
import { bus } from './harness/bus.ts';
import { registry } from './harness/registry.ts';
import type { StoreChange } from './store.ts';
import { store } from './store.ts';
import { FakeAdapter, fakeDriver } from './testing/fake-driver.ts';
import { cancelQueued, contactPeer, editUserMessage, interrupt, respondToApproval, sendToBot, startEventRouting } from './turns.ts';

/**
 * These are the turn bugs that the HTTP smoke test cannot see: the fake CLI exits
 * before a second send can queue, and it never records the prompt it was given.
 */

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

function adapter(): FakeAdapter {
  const live = registry.get('fake');
  if (!(live instanceof FakeAdapter)) throw new Error('fake adapter was not registered');
  return live;
}

function nextMessage(threadId: string, pred: (message: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      store.off('change', onChange);
      reject(new Error(`timed out waiting for a message on ${threadId}`));
    }, 4000);
    const onChange = (change: StoreChange) => {
      if (change.type !== 'message' || change.threadId !== threadId || !pred(change.message)) return;
      clearTimeout(timer);
      store.off('change', onChange);
      resolve(change.message);
    };
    store.on('change', onChange);
  });
}

function makeBot(name: string) {
  return store.createBot({ name, modelSelection: { instanceId: 'fake', model: 'fake-1' } });
}

describe('sending', () => {
  it('does not replay the message it is about to send', async () => {
    const bot = makeBot('Prompt');
    const before = adapter().lastInputs.length;
    const reply = nextMessage(bot.threadId, (m) => m.role === 'bot' && m.kind === 'text');
    await sendToBot({ botId: bot.id, text: 'original line' });
    await reply;

    const input = adapter().lastInputs[before];
    expect(input?.text).toBe('original line');
    expect(input?.transcript.some((line) => line.text === 'original line')).toBe(false);
  });

  it('an edit forks once and sends that line once', async () => {
    const bot = makeBot('Edit');
    const reply = nextMessage(bot.threadId, (m) => m.role === 'bot' && m.kind === 'text');
    await sendToBot({ botId: bot.id, text: 'original line' });
    await reply;

    const original = store.visiblePath(bot.threadId).find((m) => m.role === 'user')!;
    const before = adapter().lastInputs.length;
    const edited = nextMessage(bot.threadId, (m) => m.role === 'bot' && m.kind === 'text' && (m.text ?? '').includes('edited line'));
    const result = await editUserMessage(bot.id, bot.threadId, original.id, 'edited line');
    await edited;

    expect(result.error).toBeUndefined();
    const users = store.visiblePath(bot.threadId).filter((m) => m.role === 'user' && m.kind === 'text');
    expect(users.map((m) => m.text)).toEqual(['edited line']);
    const input = adapter().lastInputs[before];
    expect(input?.text).toBe('edited line');
    expect(input?.transcript.some((line) => line.text === 'edited line' || line.text === 'original line')).toBe(false);
  });
});

describe('bots talking to each other', () => {
  it('an ask waits and returns the other bot’s reply', async () => {
    const ada = makeBot('Ada');
    const bea = makeBot('Bea');
    const result = await contactPeer({ callerId: ada.id, name: 'Bea', text: 'what is 2+2', kind: 'ask' });
    expect(result.ok).toBe(true);
    expect(result.reply).toContain('pong:');
    expect(result.reply).toContain('Ada asks');
    expect(result.dmGroupId).toBeTruthy();
    // The ask is visible on Ada's own chat, not only inside the DM.
    expect(store.visiblePath(ada.threadId).some((m) => m.kind === 'comm' && m.comm?.kind === 'ask' && m.comm.peerName === 'Bea')).toBe(true);
    void bea;
  });

  it('a delegate runs on the other bot’s own chat and does not pretend to be the answer', async () => {
    const ada = makeBot('Cara');
    const bea = makeBot('Dan');
    const result = await contactPeer({ callerId: ada.id, targetId: bea.id, text: 'draft the notes', kind: 'delegate' });
    expect(result.ok).toBe(true);
    expect(result.reply).toBeUndefined();
    expect(result.threadId).toBe(bea.threadId);
    const reply = store.visiblePath(bea.threadId).find((m) => m.role === 'bot' && m.kind === 'text');
    expect(reply?.text).toContain('pong:');
    expect(reply?.text).toContain('delegated');
  });

  it('refuses a bot messaging itself or a peer who has talk turned off', async () => {
    const ada = makeBot('Eve');
    const quiet = makeBot('Finn');
    store.updateBot(quiet.id, { peerTools: false });
    expect(await contactPeer({ callerId: ada.id, targetId: ada.id, text: 'hi', kind: 'ask' })).toMatchObject({
      ok: false,
      error: 'a bot cannot message itself',
    });
    expect(await contactPeer({ callerId: ada.id, name: 'Finn', text: 'hi', kind: 'ask' })).toMatchObject({
      ok: false,
    });
  });
});

describe('queue', () => {
  it('runs a queued message once, from the message already in the transcript', async () => {
    const bot = makeBot('Queue');
    const card = nextMessage(bot.threadId, (m) => m.kind === 'options');
    await sendToBot({ botId: bot.id, text: '/permission hold' });
    await card;

    const queued = await sendToBot({ botId: bot.id, text: 'after this' });
    expect(queued.queued).toBe(true);
    expect(store.visiblePath(bot.threadId).filter((m) => m.text === 'after this')).toHaveLength(1);

    const follow = nextMessage(bot.threadId, (m) => m.role === 'bot' && m.kind === 'text' && (m.text ?? '').includes('after this'));
    const pending = approvals.listForBot(bot.id);
    expect(pending).toHaveLength(1);
    await respondToApproval(bot.id, pending[0]!.requestId, 'allow');
    await follow;

    const sent = store.visiblePath(bot.threadId).filter((m) => m.role === 'user' && m.text === 'after this');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queued).toBe(false);
    const drained = adapter().lastInputs.at(-1);
    expect(drained?.text).toBe('after this');
    expect(drained?.transcript.some((line) => line.text === 'after this')).toBe(false);
  });

  it('cancel removes the queued send, and a stale completion does not settle the live turn', async () => {
    const bot = makeBot('Cancel');
    const card = nextMessage(bot.threadId, (m) => m.kind === 'options');
    await sendToBot({ botId: bot.id, text: '/permission stay' });
    await card;

    const queued = await sendToBot({ botId: bot.id, text: 'do not send this' });
    const message = store.getMessage(bot.threadId, queued.messageId!)!;
    expect(cancelQueued(bot.threadId, message.queueId!)).toBe(true);
    expect(cancelQueued(bot.threadId, message.queueId!)).toBe(false);
    expect(store.visiblePath(bot.threadId).some((m) => m.kind === 'text' && m.text === 'do not send this')).toBe(false);

    bus.publish('fake', {
      eventId: 'stale',
      provider: 'fake',
      threadId: bot.threadId,
      createdAt: Date.now(),
      turnId: 'not-the-live-turn',
      type: 'turn.completed',
      stopReason: 'completed',
    });
    expect(approvals.listForBot(bot.id)).toHaveLength(1);
    expect(store.getBot(bot.id)!.activity).toBe('waiting-on-you');

    const before = adapter().lastInputs.length;
    await respondToApproval(bot.id, approvals.listForBot(bot.id)[0]!.requestId, 'deny');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter().lastInputs).toHaveLength(before);
    expect(store.visiblePath(bot.threadId).some((m) => (m.text ?? '').includes('do not send this') && m.kind === 'text')).toBe(false);
    await interrupt(bot.id, bot.threadId);
  });
});
