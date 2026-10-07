import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataPath } from '../paths.ts';
import { EventBus } from './bus.ts';

describe('event bus persistence', () => {
  it('keeps completed turns and skips per-token deltas', () => {
    const bus = new EventBus();
    const threadId = 't_bus_delta';
    const base = { eventId: 'e1', provider: 'fake', threadId, createdAt: 1 };
    bus.publish('fake', { ...base, type: 'content.delta', itemKind: 'assistant_text', delta: 'hi' });
    const file = dataPath('events', `${threadId}.ndjson`);
    expect(fs.existsSync(file)).toBe(false);

    bus.publish('fake', { ...base, eventId: 'e2', type: 'turn.completed', stopReason: 'completed' });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('turn.completed');
    expect(text).not.toContain('content.delta');
  });

  it('refuses a thread id that is not a file name', () => {
    const bus = new EventBus();
    bus.publish('fake', {
      eventId: 'e',
      provider: 'fake',
      threadId: '../outside',
      createdAt: 1,
      type: 'turn.completed',
    });
    expect(fs.existsSync(dataPath('outside.ndjson'))).toBe(false);
  });
});
