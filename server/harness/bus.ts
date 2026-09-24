import { EventEmitter } from 'node:events';
import type { RuntimeEvent } from '../contracts.ts';
import { appendNdjson, dataPath, ensureDir } from '../paths.ts';

/**
 * Fan-in for every driver. One bus, one subscription point.
 *
 * The bus drops events whose `provider` does not match the driver that published
 * them: a buggy driver must not be able to forge events attributed to another
 * engine, and a stale adapter must not keep writing into a thread it no longer owns.
 */
export class EventBus extends EventEmitter {
  private dropped = 0;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  publish(expectedProvider: string, event: RuntimeEvent): void {
    if (event.provider !== expectedProvider) {
      this.dropped++;
      return;
    }
    ensureDir(dataPath('events'));
    appendNdjson(dataPath('events', `${event.threadId}.ndjson`), event);
    this.emit('event', event);
  }

  subscribe(fn: (event: RuntimeEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }

  /** Await one matching event. Used by tests and by the room turn timeout. */
  until(match: (event: RuntimeEvent) => boolean, timeoutMs = 30_000): Promise<RuntimeEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timed out waiting for event'));
      }, timeoutMs);
      const off = this.subscribe((event) => {
        if (!match(event)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  get droppedCount(): number {
    return this.dropped;
  }
}

export const bus = new EventBus();

/** Test helper: collect events and wait on a predicate instead of sleeping. */
export function recordEvents(target: EventBus = bus) {
  const events: RuntimeEvent[] = [];
  const off = target.subscribe((e) => events.push(e));
  return {
    events,
    stop: off,
    until(match: (e: RuntimeEvent) => boolean, timeoutMs = 10_000): Promise<RuntimeEvent> {
      const already = events.find(match);
      if (already) return Promise.resolve(already);
      return target.until(match, timeoutMs);
    },
  };
}
