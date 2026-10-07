import type {
  DriverContext,
  InstanceSnapshot,
  ProviderAdapter,
  ProviderDriver,
  RuntimeEvent,
} from '../contracts.ts';
import { NO_CAPABILITIES } from '../contracts.ts';
import { getConfig, getSecret, onConfigChange, type InstanceConfig } from '../config.ts';
import { DATA_DIR } from '../paths.ts';
import { bus } from './bus.ts';
import type { SecretKey } from '../config.ts';

/**
 * Configs in, live instances out — or an unavailable shadow with a reason.
 *
 * A driver that is missing, broken, or unknown must never take the fleet down with
 * it (HB-TRD-001 NFR-REL-1). Every failure path ends at a snapshot the roster can
 * render and the user can act on, not at a thrown exception.
 */

interface Entry {
  instanceId: string;
  config: InstanceConfig;
  adapter?: ProviderAdapter;
  shadow?: InstanceSnapshot;
}

/** Per-provider env isolation: an engine only ever sees its own credential. */
const DRIVER_SECRET: Record<string, SecretKey> = {
  grok: 'xai.key',
  claude: 'anthropic.key',
  opencodeGo: 'opencodeGo.apiKey',
  openaiCompat: 'openaiCompat.key',
};

export class Registry {
  private drivers = new Map<string, ProviderDriver<unknown>>();
  private entries = new Map<string, Entry>();
  private reloading: Promise<void> | null = null;

  register(driver: ProviderDriver<never>): void {
    this.drivers.set(driver.kind, driver as ProviderDriver<unknown>);
  }

  registeredKinds(): string[] {
    return [...this.drivers.keys()];
  }

  watchConfig(): () => void {
    return onConfigChange(() => {
      void this.reload().catch(() => {});
    });
  }

  async reload(): Promise<void> {
    // Serialise reloads: two config saves in a row must not race two adapter sets.
    // A rejection is returned to this caller, and then dropped from the chain so the
    // next reload still runs. Leaving the rejected promise in place poisons every later one.
    const previous = (this.reloading ?? Promise.resolve()).catch(() => {});
    const run = previous.then(() => this.doReload());
    this.reloading = run.catch(() => {});
    return run;
  }

  private async doReload(): Promise<void> {
    const configured = getConfig().instances;
    for (const [id, entry] of this.entries) {
      if (!configured[id]) {
        await entry.adapter?.dispose().catch(() => {});
        this.entries.delete(id);
      }
    }
    await Promise.all(Object.entries(configured).map(([id, config]) => this.ensure(id, config)));
  }

  private async ensure(instanceId: string, config: InstanceConfig): Promise<void> {
    const existing = this.entries.get(instanceId);
    if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) return;
    await existing?.adapter?.dispose().catch(() => {});

    const entry: Entry = { instanceId, config };
    this.entries.set(instanceId, entry);

    if (config.enabled === false) {
      entry.shadow = shadow(instanceId, config, 'Disabled in Settings -> Engines');
      return;
    }

    const driver = this.drivers.get(config.driver);
    if (!driver) {
      // Unknown driver: keep the config, show the reason, never drop it on save.
      entry.shadow = shadow(instanceId, config, `Unknown engine "${config.driver}"`);
      return;
    }

    let decoded: unknown;
    try {
      decoded = driver.decodeConfig(config.config ?? {});
    } catch (err) {
      entry.shadow = shadow(instanceId, config, `Invalid configuration: ${message(err)}`);
      return;
    }

    const ctx: DriverContext = {
      instanceId,
      displayName: config.displayName ?? driver.displayName,
      accentColor: config.accentColor,
      emit: (event: RuntimeEvent) => bus.publish(driver.kind, event),
      secret: (name) => {
        const key = DRIVER_SECRET[config.driver];
        if (name === 'primary' && key) return getSecret(key);
        return config.environment?.[name] ?? process.env[name];
      },
      dataDir: DATA_DIR,
    };

    try {
      entry.adapter = await driver.create(decoded as never, ctx);
    } catch (err) {
      entry.shadow = shadow(instanceId, config, message(err));
    }
  }

  get(instanceId: string): ProviderAdapter | undefined {
    return this.entries.get(instanceId)?.adapter;
  }

  async snapshots(): Promise<InstanceSnapshot[]> {
    const out: InstanceSnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (entry.adapter) {
        try {
          out.push(withExtraModels(await entry.adapter.snapshot(), entry.config));
          continue;
        } catch (err) {
          out.push(withExtraModels(shadow(entry.instanceId, entry.config, message(err)), entry.config));
          continue;
        }
      }
      out.push(withExtraModels(entry.shadow ?? shadow(entry.instanceId, entry.config, 'Not started'), entry.config));
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async snapshot(instanceId: string): Promise<InstanceSnapshot | undefined> {
    return (await this.snapshots()).find((s) => s.instanceId === instanceId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.adapter?.dispose().catch(() => {})));
    this.entries.clear();
  }
}

function withExtraModels(snap: InstanceSnapshot, config: InstanceConfig): InstanceSnapshot {
  const extra = config.extraModels ?? [];
  if (!extra.length) return snap;
  const seen = new Set(snap.models.map((m) => m.id));
  const added = extra
    .filter((m) => m.id && !seen.has(m.id))
    .map((m) => ({ id: m.id, label: m.label?.trim() || m.id, extra: true as const }));
  if (!added.length) return snap;
  return { ...snap, models: [...snap.models, ...added] };
}

function shadow(instanceId: string, config: InstanceConfig, reason: string): InstanceSnapshot {
  return {
    instanceId,
    driver: config.driver,
    displayName: config.displayName ?? instanceId,
    accentColor: config.accentColor,
    state: 'unavailable',
    reason,
    models: [],
    capabilities: NO_CAPABILITIES,
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const registry = new Registry();
