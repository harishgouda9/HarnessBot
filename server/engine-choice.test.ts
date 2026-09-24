import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceSnapshot } from './contracts.ts';
import { NO_CAPABILITIES } from './contracts.ts';
import { registry } from './harness/registry.ts';
import { store } from './store.ts';
import { resolveEngine } from './turns.ts';

/**
 * Which engine a bot runs on. The rule that matters: a bot on `auto` follows whatever
 * is connected, and a pinned bot fails loudly rather than being quietly rerouted to a
 * provider the user did not choose.
 */

const snapshot = (instanceId: string, state: 'available' | 'unavailable', models: string[] = ['m1', 'm2']): InstanceSnapshot => ({
  instanceId,
  driver: instanceId as never,
  displayName: instanceId,
  state,
  reason: state === 'unavailable' ? 'not signed in' : undefined,
  models: models.map((id, i) => ({ id, label: id, default: i === 0 })),
  capabilities: NO_CAPABILITIES,
});

function withEngines(list: InstanceSnapshot[]): void {
  vi.spyOn(registry, 'snapshots').mockResolvedValue(list);
  vi.spyOn(registry, 'snapshot').mockImplementation(async (id: string) => list.find((s) => s.instanceId === id));
}

const makeBot = (name: string, modelSelection: { instanceId: string; model: string; auto?: boolean }) =>
  store.createBot({ name, modelSelection });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('resolveEngine', () => {
  it('keeps a working engine even on auto', async () => {
    withEngines([snapshot('claude', 'available'), snapshot('grok', 'available')]);
    const bot = makeBot('Stay', { instanceId: 'grok', model: 'm2', auto: true });

    expect((await resolveEngine(bot))!.instanceId).toBe('grok');
    // Rotating providers under a live conversation would drop its session for nothing.
    expect(store.getBot(bot.id)!.modelSelection.model).toBe('m2');
  });

  it('moves an auto bot to whatever is connected when its engine dies', async () => {
    withEngines([snapshot('claude', 'unavailable'), snapshot('grok', 'available')]);
    const bot = makeBot('Follow', { instanceId: 'claude', model: 'm1', auto: true });

    expect((await resolveEngine(bot))!.instanceId).toBe('grok');
    const saved = store.getBot(bot.id)!.modelSelection;
    expect(saved).toMatchObject({ instanceId: 'grok', model: 'm1', auto: true });
    // Effort is per-driver; carrying it across a provider switch would be nonsense.
    expect(saved.effort).toBeUndefined();
  });

  it('refuses to reroute a pinned bot, so the reason reaches the user', async () => {
    withEngines([snapshot('claude', 'unavailable'), snapshot('grok', 'available')]);
    const bot = makeBot('Pinned', { instanceId: 'claude', model: 'm1' });

    expect(await resolveEngine(bot)).toBeNull();
    expect(store.getBot(bot.id)!.modelSelection.instanceId).toBe('claude');
  });

  it('falls back to the default model when a provider retires the pinned one', async () => {
    withEngines([snapshot('claude', 'available', ['m9'])]);
    const bot = makeBot('Retired', { instanceId: 'claude', model: 'gone' });

    expect((await resolveEngine(bot))!.instanceId).toBe('claude');
    expect(store.getBot(bot.id)!.modelSelection.model).toBe('m9');
  });

  it('gives up rather than inventing an engine when nothing is connected', async () => {
    withEngines([snapshot('claude', 'unavailable')]);
    const bot = makeBot('Alone', { instanceId: 'claude', model: 'm1', auto: true });

    expect(await resolveEngine(bot)).toBeNull();
  });
});
