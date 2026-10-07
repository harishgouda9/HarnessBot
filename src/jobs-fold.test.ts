import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../shared/types.ts';
import { initialState, reducer } from './store.tsx';

function job(id: string, botId: string, status: JobRecord['status'] = 'queued'): JobRecord {
  return {
    id,
    botId,
    title: id,
    outcome: 'Done',
    acceptance: 'It is done',
    status,
    progress: '',
    remaining: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('job fold', () => {
  it('keeps jobs in the store and drops them with the job or the bot', () => {
    let state = reducer(initialState, { type: 'jobs', jobs: [job('j1', 'b1')] });
    state = reducer(state, { type: 'job', job: job('j1', 'b1', 'active') });
    expect(state.jobs.find((item) => item.id === 'j1')?.status).toBe('active');
    state = reducer(state, { type: 'job', job: job('j2', 'b2') });
    state = reducer(state, { type: 'job.deleted', id: 'j1' });
    expect(state.jobs.map((item) => item.id)).toEqual(['j2']);
    state = reducer(state, { type: 'bot.deleted', id: 'b2' });
    expect(state.jobs).toEqual([]);
  });
});
