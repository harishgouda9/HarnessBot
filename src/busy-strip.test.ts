import { describe, expect, it } from 'vitest';
import { pickBusyBot } from './busy-strip.ts';

describe('pickBusyBot', () => {
  const bots = [
    { id: 'a', name: 'Gk', activity: 'idle' },
    { id: 'b', name: 'navi', activity: 'working' },
    { id: 'c', name: 'Rane', activity: 'waiting-on-you' },
    { id: 'd', name: 'hidden', activity: 'working', hidden: true },
  ];

  it('names a bot that needs you ahead of one that is only working', () => {
    expect(pickBusyBot(bots)).toEqual({ id: 'c', name: 'Rane', activity: 'waiting-on-you', extra: 1 });
  });

  it('names the working bot when nobody is waiting', () => {
    expect(pickBusyBot(bots.filter((bot) => bot.id !== 'c'))).toEqual({
      id: 'b',
      name: 'navi',
      activity: 'working',
      extra: 0,
    });
  });

  it('stays quiet when every visible bot is idle', () => {
    expect(pickBusyBot([{ id: 'a', name: 'Gk', activity: 'idle' }, { id: 'd', name: 'hidden', activity: 'working', hidden: true }])).toBeNull();
  });
});
