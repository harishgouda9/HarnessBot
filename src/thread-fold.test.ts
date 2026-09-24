import { describe, expect, it } from 'vitest';
import type { Message } from '../shared/types.ts';
import { initialState, reducer, type State } from './store.tsx';

/**
 * The snapshot and the live stream overlap. A message that arrives after the GET
 * has read, but before the snapshot is applied, has to survive that apply — and a
 * message that was already on screen must not be resurrected onto a branch it left.
 */

const msg = (id: string, text: string): Message => ({ id, at: 1, role: 'bot', kind: 'text', text });

describe('thread snapshot fold', () => {
  it('keeps a message that arrived while the snapshot was in flight', () => {
    let state: State = reducer(initialState, { type: 'thread.fetch', threadId: 't1', gen: 1 });
    const late = msg('late', 'arrived during fetch');
    state = reducer(state, { type: 'message', threadId: 't1', message: late });
    expect(state.threads.t1).toBeUndefined();

    state = reducer(state, {
      type: 'thread',
      threadId: 't1',
      gen: 1,
      messages: [msg('m1', 'already stored')],
      activeLeafId: 'm1',
    });
    expect(state.threads.t1?.messages.map((m) => m.id)).toEqual(['m1', 'late']);
    expect(state.threads.t1?.activeLeafId).toBe('late');
    expect(state.inflight.t1).toBeUndefined();
  });

  it('ignores a snapshot from a fetch that a newer one replaced', () => {
    let state: State = reducer(initialState, { type: 'thread.fetch', threadId: 't1', gen: 1 });
    state = reducer(state, { type: 'thread.fetch', threadId: 't1', gen: 2 });
    state = reducer(state, {
      type: 'thread',
      threadId: 't1',
      gen: 1,
      messages: [msg('stale', 'old fetch')],
      activeLeafId: 'stale',
    });
    expect(state.threads.t1).toBeUndefined();

    state = reducer(state, {
      type: 'thread',
      threadId: 't1',
      gen: 2,
      messages: [msg('fresh', 'new fetch')],
      activeLeafId: 'fresh',
    });
    expect(state.threads.t1?.messages.map((m) => m.id)).toEqual(['fresh']);
  });

  it('does not put an abandoned branch back when a reload arrives', () => {
    const oldBranch = msg('old', 'abandoned');
    const current = msg('cur', 'visible');
    let state: State = reducer(initialState, {
      type: 'thread',
      threadId: 't1',
      messages: [oldBranch, current],
      activeLeafId: 'cur',
    });
    state = reducer(state, { type: 'thread.fetch', threadId: 't1', gen: 1 });
    const late = msg('late', 'during reload');
    state = reducer(state, { type: 'message', threadId: 't1', message: late });
    state = reducer(state, {
      type: 'thread',
      threadId: 't1',
      gen: 1,
      messages: [oldBranch],
      activeLeafId: 'old',
    });
    expect(state.threads.t1?.messages.map((m) => m.id)).toEqual(['old', 'late']);
  });
});
