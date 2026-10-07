import { describe, expect, it } from 'vitest';
import { Registry } from './registry.ts';
import { EventBus, recordEvents } from './bus.ts';
import { fakeDriver } from '../testing/fake-driver.ts';
import { saveConfig } from '../config.ts';
import type { RuntimeEvent } from '../contracts.ts';

/**
 * The registry's whole job is that a broken engine stays a row in a list instead of
 * becoming an exception. Every test here is a way that used to take the fleet down.
 */

async function registryWith(
  instances: Record<string, { driver: string; config?: Record<string, unknown>; enabled?: boolean; extraModels?: { id: string; label?: string }[] }>,
) {
  saveConfig({ instances });
  const registry = new Registry();
  registry.register(fakeDriver as never);
  await registry.reload();
  return registry;
}

describe('registry', () => {
  it('brings up a valid instance', async () => {
    const registry = await registryWith({ one: { driver: 'fake' } });
    const snapshots = await registry.snapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.state).toBe('available');
    expect(registry.get('one')).toBeDefined();
  });

  it('shadows an unknown driver with a reason instead of dropping it', async () => {
    const registry = await registryWith({ mystery: { driver: 'not-a-real-engine' } });
    const [snapshot] = await registry.snapshots();
    expect(snapshot!.state).toBe('unavailable');
    expect(snapshot!.reason).toContain('not-a-real-engine');
    // The config must still round-trip: a downgrade cannot silently delete it.
    expect(snapshot!.driver).toBe('not-a-real-engine');
  });

  it('shadows a driver whose config does not decode', async () => {
    const registry = await registryWith({ bad: { driver: 'fake', config: { invalid: true } } });
    const [snapshot] = await registry.snapshots();
    expect(snapshot!.state).toBe('unavailable');
    expect(snapshot!.reason).toContain('Invalid configuration');
  });

  it('shadows a driver whose create() rejects, and keeps the others alive', async () => {
    const registry = await registryWith({
      broken: { driver: 'fake', config: { failCreate: 'no CLI on this machine' } },
      working: { driver: 'fake' },
    });
    const snapshots = await registry.snapshots();
    const broken = snapshots.find((s) => s.instanceId === 'broken')!;
    const working = snapshots.find((s) => s.instanceId === 'working')!;
    expect(broken.state).toBe('unavailable');
    expect(broken.reason).toBe('no CLI on this machine');
    // The point of the test: one bad engine must not take the other one with it.
    expect(working.state).toBe('available');
  });

  it('reports a disabled instance without starting it', async () => {
    const registry = await registryWith({ off: { driver: 'fake', enabled: false } });
    const [snapshot] = await registry.snapshots();
    expect(snapshot!.state).toBe('unavailable');
    expect(registry.get('off')).toBeUndefined();
  });

  it('a shadow reports no capabilities, so the UI cannot offer its tools', async () => {
    const registry = await registryWith({ mystery: { driver: 'nope' } });
    const [snapshot] = await registry.snapshots();
    expect(snapshot!.capabilities.computerMcp).toBe(false);
    expect(snapshot!.models).toHaveLength(0);
  });

  it('a failed reload does not poison the next one', async () => {
    const registry = await registryWith({ one: { driver: 'fake' } });
    const adapter = registry.get('one')!;
    adapter.dispose = (() => {
      throw new Error('dispose exploded');
    }) as typeof adapter.dispose;
    saveConfig({ instances: { one: { driver: 'fake', displayName: 'Second' } } });
    await expect(registry.reload()).rejects.toThrow(/dispose exploded/);

    adapter.dispose = async () => {};
    saveConfig({ instances: { one: { driver: 'fake', displayName: 'Third' } } });
    await registry.reload();
    const snapshots = await registry.snapshots();
    expect(snapshots.find((snapshot) => snapshot.instanceId === 'one')?.displayName).toBe('Third');
  });

  it('merges user-added models onto a live catalogue without duplicating ids', async () => {
    const registry = await registryWith({
      one: {
        driver: 'fake',
        extraModels: [
          { id: 'fake-1', label: 'already there' },
          { id: 'my-custom', label: 'Custom' },
        ],
      },
    });
    const [snapshot] = await registry.snapshots();
    expect(snapshot!.models.map((m) => m.id)).toEqual(['fake-1', 'my-custom']);
    expect(snapshot!.models.find((m) => m.id === 'my-custom')).toMatchObject({ extra: true, label: 'Custom' });
    expect(snapshot!.models.find((m) => m.id === 'fake-1')!.extra).toBeUndefined();
  });
});

describe('event bus', () => {
  const event = (provider: string): RuntimeEvent => ({
    eventId: 'e1',
    provider,
    threadId: 't1',
    createdAt: Date.now(),
    type: 'turn.started',
  });

  it('publishes events that match the publishing driver', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    bus.publish('fake', event('fake'));
    await expect(recorder.until((e) => e.type === 'turn.started')).resolves.toBeDefined();
    recorder.stop();
  });

  it('drops events attributed to a different driver', () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    // A driver must not be able to forge events for another engine.
    bus.publish('fake', event('claude'));
    expect(recorder.events).toHaveLength(0);
    expect(bus.droppedCount).toBe(1);
    recorder.stop();
  });
});
