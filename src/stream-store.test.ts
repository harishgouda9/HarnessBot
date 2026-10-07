import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStream,
  flushStreamStore,
  getStreaming,
  getTrace,
  pushDelta,
  pushTrace,
  resetStreamStore,
  subscribeThread,
} from './stream-store.ts';

afterEach(() => {
  resetStreamStore();
});

describe('stream store', () => {
  it('coalesces a burst of deltas into one notification', () => {
    let paints = 0;
    const stop = subscribeThread('a', () => {
      paints += 1;
    });

    pushDelta('a', 'hel');
    pushDelta('a', 'lo');
    expect(paints).toBe(0);
    expect(getStreaming('a')).toBe('');

    flushStreamStore();
    expect(paints).toBe(1);
    expect(getStreaming('a')).toBe('hello');
    stop();
  });

  it('does not notify a thread whose text did not change', () => {
    let paints = 0;
    const stop = subscribeThread('b', () => {
      paints += 1;
    });

    pushDelta('a', 'only a');
    flushStreamStore();
    expect(paints).toBe(0);
    expect(getStreaming('a')).toBe('only a');
    expect(getStreaming('b')).toBe('');
    stop();
  });

  it('clears one thread and leaves the other in place', () => {
    pushDelta('a', 'draft');
    pushDelta('b', 'keep');
    flushStreamStore();

    clearStream('a');
    flushStreamStore();
    expect(getStreaming('a')).toBe('');
    expect(getStreaming('b')).toBe('keep');
  });

  it('drops a delta that is cleared before the frame paints', () => {
    let paints = 0;
    const stop = subscribeThread('a', () => {
      paints += 1;
    });
    pushDelta('a', 'secret');
    clearStream('a');
    flushStreamStore();
    expect(getStreaming('a')).toBe('');
    expect(paints).toBe(0);
    stop();
  });

  it('keeps the newest 300 trace lines and only notifies the thread that changed', () => {
    let other = 0;
    const stop = subscribeThread('other', () => {
      other += 1;
    });
    pushTrace({ at: 1, threadId: 'other', type: 'turn.started', detail: 'stay' });
    flushStreamStore();
    expect(other).toBe(1);

    for (let i = 0; i <= 300; i += 1) {
      pushTrace({ at: i, threadId: 'a', type: 'tool', detail: String(i) });
    }
    flushStreamStore();

    const rows = getTrace('a');
    expect(rows).toHaveLength(300);
    expect(rows[0]?.detail).toBe('300');
    expect(rows[299]?.detail).toBe('1');
    expect(getTrace('other')).toEqual([]);
    expect(other).toBe(2);
    stop();
  });
});
