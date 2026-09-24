import { useEffect, useState } from 'react';
import type { DecisionLogEntry } from '../../shared/types.ts';
import { api } from '../api.ts';
import { LOCALES } from '../i18n.ts';
import { useStore, type InstanceSnapshot, type PublicConfig } from '../store.tsx';
import { Icon, type IconName } from './Icons.tsx';
import { AddProviderDialog } from './Overlays.tsx';
import { PLACEMENTS } from './Panels.tsx';
import { McpServersPanel } from './McpServers.tsx';

/**
 * App settings. Keys are write-only: the renderer shows a "configured" badge and a
 * blank field, never the value, because a value it can render is a value it can leak.
 */

const SKINS = [
  { id: 'white', name: 'White', note: 'The first-run default.' },
  { id: 'midnight', name: 'Midnight', note: 'Dark, single blue accent.' },
  { id: 'atelier', name: 'Atelier', note: 'Warm paper. An AA reference skin.' },
  { id: 'foundry', name: 'Foundry', note: 'Dark metal and brass. An AA reference skin.' },
  { id: 'lagoon', name: 'Lagoon', note: 'Cool ceramic.' },
];

const SECRET_FIELDS = [
  { key: 'anthropic.key', label: 'Anthropic API key', note: 'Only needed if the Claude CLI is not already logged in.' },
  { key: 'xai.key', label: 'xAI / Grok API key' },
  { key: 'composio.apiKey', label: 'Composio project key', note: 'Enables the connected-apps marketplace.' },
  { key: 'box.token', label: 'Box API token', note: 'Cloud desktops.' },
  { key: 'elevenlabs.key', label: 'ElevenLabs key', note: 'Speech. Speaking replies stays off by default because it costs credit.' },
  { key: 'openai.imageKey', label: 'OpenAI image key' },
  { key: 'opencodeGo.apiKey', label: 'OpenCode Go key' },
];

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

/**
 * `keys` and `engines` were two entries for one question — where do models come from.
 * They are now panes inside Providers, which is the only place that question is asked.
 */
type Tab = 'providers' | 'mcp' | 'computers' | 'webhooks' | 'voice' | 'appearance' | 'advanced';

const TAB_LABELS: Record<Tab, string> = {
  providers: 'Providers',
  mcp: 'MCP servers',
  computers: 'Computers',
  webhooks: 'Webhooks',
  voice: 'Voice',
  appearance: 'Appearance',
  advanced: 'Advanced',
};

const TAB_ICONS: Record<Tab, IconName> = {
  providers: 'plug',
  mcp: 'server',
  computers: 'monitor',
  webhooks: 'webhook',
  voice: 'microphone',
  appearance: 'palette',
  advanced: 'sliders',
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { state, refreshConfig, refreshInstances } = useStore();
  const [tab, setTab] = useState<Tab>('providers');
  const config = state.config;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    await api.patch('/api/config', patch);
    await refreshConfig();
  };

  if (!config) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4" style={{ background: '#0009' }} onClick={onClose}>
      <div
        className="card anim-pop relative flex h-[min(680px,92vh)] w-[min(900px,96vw)] overflow-hidden"
        style={{ background: 'var(--color-panel)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <nav className="w-44 shrink-0 border-r p-2 hairline" aria-label="Settings sections">
          {(Object.keys(TAB_LABELS) as Tab[]).map((name) => {
            const active = tab === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => setTab(name)}
                aria-current={active ? 'page' : undefined}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]"
                style={{
                  background: active ? 'var(--color-raised)' : 'transparent',
                  color: active ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
                }}
              >
                <Icon name={TAB_ICONS[name]} size={15} />
                {TAB_LABELS[name]}
              </button>
            );
          })}
        </nav>

        <div className="scroll-thin flex-1 overflow-y-auto p-4 pt-10">
          {tab === 'providers' ? (
            <ProvidersTab
              instances={state.instances}
              configured={config.configured}
              onSave={save}
              onChanged={async () => {
                await refreshInstances();
                await refreshConfig();
              }}
            />
          ) : null}
          {tab === 'mcp' ? <McpTab config={config} onChanged={refreshConfig} /> : null}
          {tab === 'computers' ? <ComputersTab config={config} onSave={save} /> : null}
          {tab === 'webhooks' ? <WebhooksTab /> : null}
          {tab === 'voice' ? <VoiceTab voice={config.voice} configured={config.configured['elevenlabs.key'] === true} onSave={save} /> : null}
          {tab === 'appearance' ? <AppearanceTab config={config} onSave={save} /> : null}
          {tab === 'advanced' ? <AdvancedTab config={config} onSave={save} /> : null}
        </div>

        <button type="button" onClick={onClose} className="absolute top-3 right-4 text-[13px]">
          Close
        </button>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {hint ? (
        <p className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {hint}
        </p>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Providers.
 *
 * Four ways to give the app a model, and they are genuinely different questions rather
 * than one list with a filter: sign in to something you already pay for, paste a key,
 * point at an endpoint, or run it on this machine. They used to be spread across two
 * unrelated tabs — "Keys" and "Engines" — so "how do I get a model working" had no
 * single place to start.
 */

type ProviderTab = 'accounts' | 'keys' | 'endpoints' | 'local';

const PROVIDER_TABS: { id: ProviderTab; label: string; icon: IconName }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'user' },
  { id: 'keys', label: 'API keys', icon: 'key' },
  { id: 'endpoints', label: 'Custom endpoints', icon: 'server' },
  { id: 'local', label: 'Local models', icon: 'monitor' },
];

function ProvidersTab({
  instances,
  configured,
  onSave,
  onChanged,
}: {
  instances: InstanceSnapshot[];
  configured: Record<string, boolean>;
  onSave: (p: Record<string, unknown>) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<ProviderTab>('accounts');
  const connected = instances.filter((i) => i.state === 'available').length;

  return (
    <section className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">Providers</h2>
        <span
          className="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
          style={{
            background: connected ? 'color-mix(in srgb, var(--color-success) 16%, transparent)' : 'var(--color-inset)',
            color: connected ? 'var(--color-success)' : 'var(--color-warning)',
          }}
        >
          {connected} connected
        </span>
      </div>
      <p className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Where models come from. Any bot can be pointed at any provider here, or set to follow
        whichever one is connected.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--color-inset)', width: 'fit-content' }} role="tablist">
        {PROVIDER_TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]"
              style={{
                background: active ? 'var(--color-raised)' : 'transparent',
                color: active ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
              }}
            >
              <Icon name={item.icon} size={12} />
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {tab === 'accounts' ? <AccountsPane instances={instances} onChanged={onChanged} /> : null}
        {tab === 'keys' ? <ApiKeysPane configured={configured} onSave={onSave} /> : null}
        {tab === 'endpoints' ? <EndpointsPane instances={instances} onChanged={onChanged} /> : null}
        {tab === 'local' ? <LocalModelsPane instances={instances} onChanged={onChanged} /> : null}
      </div>
    </section>
  );
}

/** A provider row: same shape whichever pane it is in, so the four read as one system. */
function ProviderRow({
  title,
  subtitle,
  connected,
  badge,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  connected?: boolean;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="card mb-2 p-3"
      style={connected ? { borderColor: 'var(--color-accent-border)', boxShadow: 'inset 3px 0 0 var(--color-accent)' } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        {connected ? (
          <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: 'color-mix(in srgb, var(--color-success) 16%, transparent)', color: 'var(--color-success)' }}>
            <Icon name="check" size={10} />
            Connected
          </span>
        ) : badge ? (
          <span className="rounded-md px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            {badge}
          </span>
        ) : null}
        <span className="flex-1" />
        {children}
      </div>
      {subtitle ? (
        <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Accounts: engines that authenticate as themselves.
 *
 * HarnessBot never sees the password. Each of these CLIs owns its own sign-in — you
 * run it once in a terminal, it stores its own session, and this screen only reports
 * whether that worked.
 */
function AccountsPane({ instances, onChanged }: { instances: InstanceSnapshot[]; onChanged: () => Promise<void> }) {
  const { state } = useStore();
  const [tested, setTested] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const instanceConfig = state.config?.instances ?? {};

  // Custom endpoints and local models have their own panes; this one is CLI accounts.
  const accounts = instances.filter((i) => i.driver !== 'openaiCompat');
  const ordered = [...accounts.filter((i) => i.state === 'available'), ...accounts.filter((i) => i.state !== 'available')];

  return (
    <>
      <p className="mb-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Sign in with a subscription you already have — no API key to copy. Each engine handles its
        own login in your terminal; HarnessBot never sees the password, only whether it worked.
      </p>

      {ordered.map((instance) => {
        const ready = instance.state === 'available';
        const meta = instanceConfig[instance.instanceId];
        const disabled = meta?.enabled === false;
        // The command to run is the binary, never the driver kind — telling someone to
        // run `opencodeGo` sends them after an executable that does not exist, and
        // testing that name fails for an engine that is installed and working.
        const cli = instance.bin ?? instance.driver;
        return (
          <ProviderRow
            key={instance.instanceId}
            title={instance.displayName}
            connected={ready}
            badge={disabled ? 'switched off' : 'not connected'}
            subtitle={
              ready ? (
                <>Signed in. {instance.models.length} model{instance.models.length === 1 ? '' : 's'} available.</>
              ) : (
                <>
                  {instance.reason ?? 'Not available.'}
                  <span className="mt-1 block">
                    Sign in once in your terminal:{' '}
                    <code className="rounded px-1 font-mono" style={{ background: 'var(--color-inset)' }}>
                      {cli}
                    </code>{' '}
                    — then come back here and press Test.
                  </span>
                </>
              )
            }
          >
            <button
              type="button"
              disabled={busy === instance.instanceId}
              onClick={async () => {
                setBusy(instance.instanceId);
                const result = await api.post<{ ok: boolean; version?: string; error?: string }>('/api/cli-test', { command: cli });
                setTested({ ...tested, [instance.instanceId]: result.ok ? (result.version ?? 'ok') : (result.error ?? 'failed') });
                await onChanged();
                setBusy('');
              }}
              className="rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
              style={{ background: 'var(--color-raised)' }}
            >
              {busy === instance.instanceId ? '…' : 'Test'}
            </button>
            {/* Disconnect is not delete: the configuration stays, so re-enabling is one click. */}
            <button
              type="button"
              onClick={async () => {
                await api.patch(`/api/instances/${instance.instanceId}`, { enabled: disabled });
                await onChanged();
              }}
              className="rounded-lg px-2.5 py-1 text-[12px]"
              style={{ background: 'var(--color-raised)' }}
            >
              {disabled ? 'Enable' : 'Disconnect'}
            </button>
          </ProviderRow>
        );
      })}

      {Object.entries(tested).map(([id, result]) => (
        <div key={id} className="mb-2 font-mono text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {id}: {result}
        </div>
      ))}

      <div className="card mt-3 p-3">
        <div className="text-[12px] font-medium">Not on PATH?</div>
        <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          If a CLI is installed but not found, give it an absolute path.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {ordered
            .filter((i) => i.state !== 'available')
            .map((instance) => (
              <input
                key={instance.instanceId}
                placeholder={`Path to ${instance.bin ?? instance.driver}`}
                defaultValue={(instanceConfig[instance.instanceId]?.config as { command?: string } | undefined)?.command ?? ''}
                onBlur={async (e) => {
                  if (!e.target.value) return;
                  await api.patch(`/api/instances/${instance.instanceId}`, { config: { command: e.target.value } });
                  await onChanged();
                }}
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 font-mono text-[11px]"
                style={inputStyle}
              />
            ))}
        </div>
      </div>
    </>
  );
}

function ApiKeysPane({ configured, onSave }: { configured: Record<string, boolean>; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <>
      <p className="mb-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Stored on this machine and sent only to the provider that needs them. A saved key is never
        shown again — not here, not over the API, not in a log. To change one, type a new one.
      </p>
      {SECRET_FIELDS.map((field) => (
        <div key={field.key} className="card mb-2 p-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">{field.label}</span>
            {configured[field.key] ? (
              <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ background: 'color-mix(in srgb, var(--color-success) 16%, transparent)', color: 'var(--color-success)' }}>
                <Icon name="check" size={10} />
                Saved
              </span>
            ) : null}
          </div>
          {field.note ? (
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {field.note}
            </div>
          ) : null}
          <div className="mt-1.5 flex gap-2">
            <input
              type="password"
              autoComplete="off"
              placeholder={configured[field.key] ? 'Replace the stored key' : 'Paste key'}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              className="min-w-0 flex-1 rounded-lg px-2 py-1.5 font-mono text-[13px]"
              style={inputStyle}
            />
            <button
              type="button"
              disabled={!values[field.key]}
              onClick={async () => {
                await onSave({ secrets: { [field.key]: values[field.key] } });
                setValues({ ...values, [field.key]: '' });
              }}
              className="rounded-lg px-3 text-[13px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              Save
            </button>
            {configured[field.key] ? (
              <button type="button" onClick={() => void onSave({ secrets: { [field.key]: null } })} className="rounded-lg px-3 text-[13px]" style={{ background: 'var(--color-raised)' }}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

/** Every user-added OpenAI-compatible endpoint, and the way to add another. */
function EndpointsPane({ instances, onChanged }: { instances: InstanceSnapshot[]; onChanged: () => Promise<void> }) {
  const { state } = useStore();
  const [adding, setAdding] = useState(false);
  const instanceConfig = state.config?.instances ?? {};
  const endpoints = instances.filter((i) => i.driver === 'openaiCompat' && i.instanceId !== 'openaiCompat');

  return (
    <>
      <p className="mb-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Any OpenAI-compatible base URL — OpenRouter, Together, Groq, your own gateway. Text and
        reasoning only: these are never offered a computer or connected apps, because they have no
        way to use them.
      </p>

      {endpoints.map((instance) => {
        const meta = instanceConfig[instance.instanceId];
        const cfg = meta?.config as { baseUrl?: string } | undefined;
        const hasKey = (meta?.environmentKeys?.length ?? 0) > 0;
        return (
          <ProviderRow
            key={instance.instanceId}
            title={instance.displayName}
            connected={instance.state === 'available'}
            badge={instance.reason ?? 'not connected'}
            subtitle={
              <>
                <span className="font-mono">{cfg?.baseUrl ?? 'no base URL'}</span>
                <span className="mt-0.5 block">
                  {hasKey ? 'Key saved on this machine.' : 'No key set — add one if the endpoint needs it.'}{' '}
                  {instance.models.length} model{instance.models.length === 1 ? '' : 's'}.
                </span>
              </>
            }
          >
            <button
              type="button"
              onClick={async () => {
                if (!window.confirm(`Remove ${instance.displayName}? Bots following the workspace move to whatever else is connected.`)) return;
                await api.del(`/api/instances/${instance.instanceId}`);
                await onChanged();
              }}
              className="rounded-lg px-2.5 py-1 text-[12px]"
              style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
            >
              Remove
            </button>
          </ProviderRow>
        );
      })}

      {endpoints.length === 0 ? (
        <div className="mb-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          None yet.
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px]"
        style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
      >
        <Icon name="plus" size={13} />
        Add an endpoint
      </button>

      {adding ? <AddProviderDialog onClose={() => void (setAdding(false), onChanged())} /> : null}
    </>
  );
}

interface LocalRuntime {
  id: string;
  name: string;
  baseUrl: string;
  hint: string;
  running: boolean;
  models: string[];
  reason?: string;
}

/**
 * Local models.
 *
 * This pane probes loopback rather than asking for a port, because a person running
 * Ollama should not have to know it listens on 11434. A runtime that is up gets a
 * one-click connect that fills in its URL and the models it is actually holding.
 */
function LocalModelsPane({ instances, onChanged }: { instances: InstanceSnapshot[]; onChanged: () => Promise<void> }) {
  const [runtimes, setRuntimes] = useState<LocalRuntime[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const scan = async (): Promise<void> => {
    setBusy('scan');
    setError('');
    try {
      setRuntimes(await api.get<LocalRuntime[]>('/api/local-models'));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (runtime: LocalRuntime): Promise<void> => {
    setBusy(runtime.id);
    setError('');
    try {
      await api.post('/api/instances', {
        instanceId: `local-${runtime.id}`,
        driver: 'openaiCompat',
        config: {
          displayName: `${runtime.name} (local)`,
          // No key: a loopback runtime has nothing to authenticate against.
          config: { baseUrl: runtime.baseUrl, models: runtime.models.map((id) => ({ id })) },
        },
      });
      await onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          No account needed — a model running on this machine. HarnessBot looks for the usual
          runtimes on loopback; start one and press Scan again.
        </p>
        <button
          type="button"
          disabled={busy === 'scan'}
          onClick={() => void scan()}
          className="rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
          style={{ background: 'var(--color-raised)' }}
        >
          {busy === 'scan' ? 'Scanning…' : 'Scan again'}
        </button>
      </div>

      {error ? (
        <div className="mb-2 text-[12px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      {runtimes === null ? (
        <div className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Looking for local runtimes…
        </div>
      ) : (
        runtimes.map((runtime) => {
          const already = instances.some((i) => i.instanceId === `local-${runtime.id}`);
          return (
            <ProviderRow
              key={runtime.id}
              title={runtime.name}
              connected={already && runtime.running}
              badge={runtime.running ? 'running' : 'not running'}
              subtitle={
                <>
                  <span className="font-mono">{runtime.baseUrl}</span>
                  <span className="mt-0.5 block">
                    {runtime.running
                      ? runtime.models.length
                        ? `Holding ${runtime.models.slice(0, 4).join(', ')}${runtime.models.length > 4 ? ` and ${runtime.models.length - 4} more` : ''}.`
                        : (runtime.reason ?? 'Running.')
                      : runtime.hint}
                  </span>
                </>
              }
            >
              {runtime.running && runtime.models.length && !already ? (
                <button
                  type="button"
                  disabled={busy === runtime.id}
                  onClick={() => void connect(runtime)}
                  className="rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
                >
                  {busy === runtime.id ? '…' : 'Use this'}
                </button>
              ) : already ? (
                <button
                  type="button"
                  onClick={async () => {
                    await api.del(`/api/instances/local-${runtime.id}`);
                    await onChanged();
                  }}
                  className="rounded-lg px-2.5 py-1 text-[12px]"
                  style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
                >
                  Remove
                </button>
              ) : null}
            </ProviderRow>
          );
        })
      )}
    </>
  );
}

function McpTab({ config, onChanged }: { config: PublicConfig; onChanged: () => Promise<void> }) {
  return (
    <Section title="MCP servers">
      <McpServersPanel servers={config.mcpServers} onChanged={onChanged} />
    </Section>
  );
}

function ComputersTab({ config, onSave }: { config: PublicConfig; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [vm, setVm] = useState<{ runtime: string | null; available: boolean; reason?: string; image: string } | null>(null);
  const [host, setHost] = useState<{ platform: string; session: string; hostControl: { supported: boolean; reason?: string }; dockerAvailable: boolean } | null>(null);
  const [profile, setProfile] = useState('');
  const [pulling, setPulling] = useState(false);
  const [log, setLog] = useState('');

  useEffect(() => {
    void api.get<typeof vm>('/api/local-vm').then(setVm);
    void api.get<typeof host>('/api/local-computer').then(setHost);
  }, []);

  const defaultPlacement = config.defaultComputer ?? '';

  return (
    <>
      <Section
        title="Where its hands are"
        hint="Each bot picks one of these. This page sets up the backends and the default new bots inherit."
      >
        <div className="flex flex-col gap-1">
          {PLACEMENTS.map((option) => {
            const active = defaultPlacement === option.value;
            return (
              <button
                key={option.value || 'auto'}
                type="button"
                onClick={() => void onSave({ defaultComputer: option.value || null })}
                className="rounded-lg p-2 text-left"
                style={{
                  background: active ? 'var(--color-raised)' : 'var(--color-inset)',
                  border: `1px solid ${active ? 'var(--color-accent-border)' : 'transparent'}`,
                }}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{
                      border: `2px solid ${active ? 'var(--color-accent)' : 'var(--color-ink-secondary)'}`,
                      background: active ? 'var(--color-accent)' : 'transparent',
                    }}
                  />
                  <span className="text-[13px] font-medium">{option.title}</span>
                </span>
                <span className="mt-0.5 block pl-5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {option.body}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Cloud desktop" hint="An isolated Linux desktop at Box, or your own VPS. Nothing touches this machine.">
        <div className="card p-3">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: config.configured['box.token'] ? 'var(--color-success)' : 'var(--color-warning)' }} />
            <span className="text-[13px]">{config.configured['box.token'] ? 'Box token configured' : 'No Box token'}</span>
          </div>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Add a Box token under Providers → API keys. Per-bot, pick Cloud desktop and the Box backend.
          </p>
        </div>
      </Section>

      <Section title="This computer" hint="Your real screen, keyboard and mouse. Requires an explicit opt-in per bot — never from this page.">
        <div className="card p-3 text-[13px]">
          {host ? (
            <>
              <div>
                {host.platform} · {host.session} session
              </div>
              <div className="mt-1" style={{ color: host.hostControl.supported ? 'var(--color-ink-secondary)' : 'var(--color-warning)' }}>
                {host.hostControl.supported ? 'Host control is available on this session.' : host.hostControl.reason}
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--color-ink-secondary)' }}>Checking this machine…</div>
          )}
          <p className="mt-2 text-[12px]" style={{ color: 'var(--color-warning)' }}>
            Opt-in lives on the bot, not here. Open a bot → Computer → This computer.
          </p>
        </div>
      </Section>

      <Section title="Local VM" hint="Containerised desktops over Docker or Podman. Workspaces mount durably; the containers themselves are disposable.">
        <div className="card p-3">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: vm?.available ? 'var(--color-success)' : 'var(--color-warning)' }} />
            <span className="text-[13px]">{vm?.runtime ? `${vm.runtime} detected` : 'No container runtime'}</span>
          </div>
          {vm?.reason ? (
            <div className="mt-1 text-[12px]" style={{ color: 'var(--color-warning)' }}>
              {vm.reason}
            </div>
          ) : null}
          {vm?.image ? (
            <div className="mt-2 font-mono text-[11px] break-all" style={{ color: 'var(--color-ink-secondary)' }}>
              {vm.image}
            </div>
          ) : null}
          <button
            type="button"
            disabled={!vm?.available || pulling}
            onClick={async () => {
              setPulling(true);
              const result = await api.post<{ output: string }>('/api/local-vm/pull');
              setLog(result.output.slice(-1200));
              setPulling(false);
            }}
            className="mt-2 rounded-lg px-3 py-1.5 text-[12px] disabled:opacity-40"
            style={{ background: 'var(--color-raised)' }}
          >
            {pulling ? 'Pulling…' : 'Pull desktop image'}
          </button>
          {log ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-lg p-2 font-mono text-[10px] whitespace-pre-wrap" style={{ background: 'var(--color-inset)' }}>
              {log}
            </pre>
          ) : null}
        </div>

        <div className="mt-3 flex gap-2">
          <label className="flex-1">
            <span className="block text-[12px] font-medium">Mode</span>
            <select
              value={config.localVm.mode}
              onChange={(e) => void onSave({ localVm: { ...config.localVm, mode: e.target.value } })}
              className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
              style={inputStyle}
            >
              <option value="shared">Shared — one desktop for everyone</option>
              <option value="per-bot">One per bot</option>
            </select>
          </label>
          <label>
            <span className="block text-[12px] font-medium">Max at once</span>
            <input
              type="number"
              min={1}
              max={4}
              defaultValue={config.localVm.maxInstances}
              onBlur={(e) => void onSave({ localVm: { ...config.localVm, maxInstances: Number(e.target.value) } })}
              className="mt-1 w-24 rounded-lg px-2 py-1.5 text-[13px]"
              style={inputStyle}
            />
          </label>
        </div>
      </Section>

      <Section title="Self-hosted VPS" hint="Only an SSH alias is stored — not a host, not a key, not a full SSH config.">
        <input
          defaultValue={config.vps.sshAlias ?? ''}
          onBlur={(e) => void onSave({ vps: { sshAlias: e.target.value } })}
          placeholder="my-vps"
          className="w-full rounded-lg px-2 py-1.5 font-mono text-[13px]"
          style={inputStyle}
        />
        <p className="mt-1 text-[11px]" style={{ color: 'var(--color-warning)' }}>
          The VPS container filesystem is disposable. Move anything you want to keep out before you
          destroy or upgrade it.
        </p>
      </Section>

      <Section title="Browser profiles" hint="Bots sharing a profile share its cookies and logins. `guest` is reserved as a throwaway.">
        <div className="flex flex-wrap gap-1">
          {config.browserProfiles.map((p) => (
            <span key={p.id} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--color-inset)' }}>
              {p.name}
              {p.id !== 'default' ? (
                <button
                  type="button"
                  onClick={() => void onSave({ browserProfiles: config.browserProfiles.filter((x) => x.id !== p.id) })}
                  style={{ color: 'var(--color-danger)' }}
                  aria-label={`Remove ${p.name}`}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="Work" className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
          <button
            type="button"
            disabled={!profile.trim()}
            onClick={async () => {
              const id = profile.toLowerCase().replace(/[^a-z0-9_-]/g, '');
              if (!id || id === 'guest') return;
              await onSave({ browserProfiles: [...config.browserProfiles, { id, name: profile.trim() }] });
              setProfile('');
            }}
            className="rounded-lg px-3 text-[13px] disabled:opacity-40"
            style={{ background: 'var(--color-raised)' }}
          >
            Add
          </button>
        </div>
      </Section>

      <Section title="Rooms" hint="One stuck participant should not be able to block a room forever.">
        <label className="block text-[12px] font-medium">Turn timeout (minutes)</label>
        <input
          type="number"
          min={1}
          max={1440}
          defaultValue={config.room.turnTimeoutMinutes}
          onBlur={(e) => void onSave({ room: { turnTimeoutMinutes: Number(e.target.value) } })}
          className="mt-1 w-32 rounded-lg px-2 py-1.5 text-[13px]"
          style={inputStyle}
        />
      </Section>
    </>
  );
}

interface WebhookRecord {
  id: string;
  name: string;
  routineId: string;
  createdAt: number;
  lastDeliveryAt?: number;
}

/**
 * Webhooks run a routine from outside. The receiver is on its own port with only
 * /health and /hooks/:secret on it, because it is the only port anyone is told they
 * may expose — the harness API itself has no authentication at all.
 */
function WebhooksTab() {
  const { state, refreshRoutines } = useStore();
  const [hooks, setHooks] = useState<WebhookRecord[]>([]);
  const [name, setName] = useState('');
  const [routineId, setRoutineId] = useState('');
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState('');

  const load = async (): Promise<void> => setHooks(await api.get<WebhookRecord[]>('/api/webhooks'));

  useEffect(() => {
    void load();
    void refreshRoutines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <Section
      title="Webhooks"
      hint="Each one fires a routine you already have. Tunnel only this port if you need delivery from the internet — never the harness API."
    >
      {state.routines.length === 0 ? (
        <div className="card p-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Schedule a routine first — a webhook is a way to trigger one, not a second kind of job.
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
            <select value={routineId} onChange={(e) => setRoutineId(e.target.value)} className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
              <option value="">Pick a routine</option>
              {state.routines.map((routine) => (
                <option key={routine.id} value={routine.id}>
                  {routine.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!routineId}
              onClick={() =>
                void run(async () => {
                  const created = await api.post<{ id: string; url: string }>('/api/webhooks', { name: name || 'Webhook', routineId });
                  setRevealed({ id: created.id, url: created.url });
                  setName('');
                })
              }
              className="rounded-lg px-3 text-[13px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              Create
            </button>
          </div>

          {error ? (
            <div className="mt-2 text-[12px]" style={{ color: 'var(--color-danger)' }}>
              {error}
            </div>
          ) : null}

          {revealed ? (
            <div className="card mt-3 p-3" style={{ border: '1px solid var(--color-accent-border)' }}>
              <div className="text-[13px] font-medium">Copy this now</div>
              <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                The secret is stored hashed. There is no endpoint that can show it again — losing it
                means rotating, not recovering.
              </div>
              <code className="mt-2 block break-all rounded-lg p-2 font-mono text-[11px]" style={{ background: 'var(--color-inset)' }}>
                {revealed.url}
              </code>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(revealed.url)}
                  className="rounded-lg px-3 py-1.5 text-[12px]"
                  style={{ background: 'var(--color-raised)' }}
                >
                  Copy URL
                </button>
                <button type="button" onClick={() => setRevealed(null)} className="rounded-lg px-3 py-1.5 text-[12px]" style={{ background: 'var(--color-raised)' }}>
                  Done
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-4">
            {hooks.length === 0 ? (
              <div className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                No webhooks yet.
              </div>
            ) : (
              hooks.map((hook) => (
                <div key={hook.id} className="card mb-2 flex items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{hook.name}</div>
                    <div className="truncate text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      {state.routines.find((r) => r.id === hook.routineId)?.name ?? 'routine is gone'} ·{' '}
                      {hook.lastDeliveryAt ? `last delivery ${new Date(hook.lastDeliveryAt).toLocaleString()}` : 'never fired'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        const rotated = await api.post<{ url: string }>(`/api/webhooks/${hook.id}/rotate`);
                        setRevealed({ id: hook.id, url: rotated.url });
                      })
                    }
                    className="rounded-lg px-2 py-1 text-[12px]"
                    style={{ background: 'var(--color-raised)' }}
                  >
                    Rotate
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        if (!window.confirm(`Delete "${hook.name}"? Anything still posting to it starts failing.`)) return;
                        await api.del(`/api/webhooks/${hook.id}`);
                      })
                    }
                    className="text-[12px]"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function VoiceTab({ voice, configured, onSave }: { voice: string; configured: boolean; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const isMac = navigator.platform.toLowerCase().includes('mac');

  useEffect(() => {
    void api.get<{ voices: typeof voices }>('/api/tts/voices').then((r) => setVoices(r.voices));
  }, []);

  return (
    <Section title="Voice" hint="Speech runs on the harness, so the key never reaches the page that renders model output.">
      {!configured ? (
        <div className="card mb-3 p-3 text-[12px]" style={{ color: 'var(--color-warning)' }}>
          Add an ElevenLabs key under Keys to enable speech.
        </div>
      ) : null}

      <label className="block text-[12px] font-medium">Default voice</label>
      <select value={voice} onChange={(e) => void onSave({ voice: e.target.value })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
        <option value="">No default voice</option>
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Bots can each override this, so a room does not sound like one person.
      </p>

      <div className="card mt-4 p-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        <div className="font-medium" style={{ color: 'var(--color-ink)' }}>
          Dictation and calls
        </div>
        {isMac ? (
          <p className="mt-1">
            Dictation uses on-device Apple speech. Calls are half-duplex on purpose — the mic mutes
            while the bot speaks, so it never transcribes itself.
          </p>
        ) : (
          <p className="mt-1">
            Not shipped on this platform yet. Text to speech works if you add a key; dictation and
            calls are macOS-only in this version, and the UI will not pretend otherwise.
          </p>
        )}
      </div>
    </Section>
  );
}

function AppearanceTab({ config, onSave }: { config: PublicConfig; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  return (
    <Section title="Appearance" hint="Every shipping skin clears WCAG AA, and CI fails the build if a change breaks that.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SKINS.map((skin) => (
          <button
            key={skin.id}
            type="button"
            onClick={() => void onSave({ skin: skin.id })}
            data-skin={skin.id}
            className="rounded-xl p-3 text-left"
            style={{
              background: 'var(--color-app)',
              color: 'var(--color-ink)',
              border: `2px solid ${config.skin === skin.id ? 'var(--color-accent)' : 'var(--color-hairline)'}`,
            }}
          >
            {/* The swatch renders with the skin's real tokens, not a painted mockup. */}
            <div className="text-[13px] font-medium">{skin.name}</div>
            <div className="mt-1 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {skin.note}
            </div>
            <div className="mt-2 flex gap-1">
              <span className="h-4 w-4 rounded" style={{ background: 'var(--color-panel)' }} />
              <span className="h-4 w-4 rounded" style={{ background: 'var(--color-card)' }} />
              <span className="h-4 w-4 rounded" style={{ background: 'var(--color-accent)' }} />
              <span className="h-4 w-4 rounded" style={{ background: 'var(--color-success)' }} />
            </div>
          </button>
        ))}
      </div>

      <label className="mt-5 block text-[13px] font-medium">Theme</label>
      <select value={config.theme} onChange={(e) => void onSave({ theme: e.target.value })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
        <option value="system">Follow the system</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Picking a skin above overrides this.
      </p>
    </Section>
  );
}

const OUTCOME_TONE: Record<string, string> = {
  'allowed-once': 'var(--color-success)',
  rejected: 'var(--color-danger)',
  answered: 'var(--color-ink-secondary)',
  unavailable: 'var(--color-warning)',
};

/**
 * Every permission answer, including the ones nobody gave. "Always allow" grants are
 * only auditable if you can see what they went on to authorise.
 */
function DecisionLog() {
  const [entries, setEntries] = useState<DecisionLogEntry[] | null>(null);
  const [filter, setFilter] = useState('');

  const shown = (entries ?? []).filter(
    (entry) => !filter || entry.outcome === filter || (filter === 'local' && entry.approvalScope === 'local-computer'),
  );

  return (
    <Section title="Permission decisions" hint="Written to a rotating log on disk. Nothing here is sent anywhere.">
      {entries === null ? (
        <button
          type="button"
          onClick={() => void api.get<DecisionLogEntry[]>('/api/decisions').then(setEntries)}
          className="rounded-lg px-3 py-1.5 text-[13px]"
          style={{ background: 'var(--color-raised)' }}
        >
          Show the log
        </button>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1">
            {['', 'allowed-once', 'rejected', 'unavailable', 'local'].map((value) => (
              <button
                key={value || 'all'}
                type="button"
                onClick={() => setFilter(value)}
                className="rounded-lg px-2 py-1 text-[12px]"
                style={{ background: filter === value ? 'var(--color-raised)' : 'var(--color-inset)' }}
              >
                {value === '' ? 'All' : value === 'local' ? 'This computer' : value}
              </button>
            ))}
          </div>
          <div className="scroll-thin max-h-72 overflow-y-auto">
            {shown.length === 0 ? (
              <div className="py-4 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {entries.length ? 'Nothing under this filter.' : 'No decisions recorded yet.'}
              </div>
            ) : (
              shown
                .slice()
                .reverse()
                .map((entry) => (
                  <div key={`${entry.requestId}:${entry.at}`} className="border-b py-1.5 text-[12px] hairline">
                    <div className="flex items-center gap-2">
                      <span style={{ color: OUTCOME_TONE[entry.outcome] ?? 'var(--color-ink-secondary)' }}>{entry.outcome}</span>
                      <span className="font-mono">{entry.tool ?? '—'}</span>
                      {entry.approvalScope === 'local-computer' ? (
                        <span style={{ color: 'var(--color-danger)' }}>this computer</span>
                      ) : null}
                      <span className="flex-1" />
                      <span style={{ color: 'var(--color-ink-secondary)' }}>
                        {entry.source} · {new Date(entry.at).toLocaleString()}
                      </span>
                    </div>
                    <div className="truncate" style={{ color: 'var(--color-ink-secondary)' }}>
                      {entry.summary}
                      {entry.allowKey ? ` · remembered ${entry.allowKey}` : ''}
                    </div>
                  </div>
                ))
            )}
          </div>
        </>
      )}
    </Section>
  );
}

/** The other half of team import. Packages carry structure, never credentials. */
function TeamExport() {
  const { state } = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState('');

  return (
    <Section title="Export a team" hint="Roles, rooms, routines and playbooks — never keys, transcripts, grants, memory, or computer access.">
      <div className="scroll-thin max-h-40 overflow-y-auto">
        {state.bots
          .filter((b) => !b.hidden)
          .map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 py-0.5 text-[13px]">
              <input
                type="checkbox"
                checked={selected.includes(bot.id)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, bot.id] : selected.filter((id) => id !== bot.id))}
              />
              {bot.name}
            </label>
          ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={async () => {
            const query = selected.length ? `?ids=${selected.join(',')}` : '';
            setMarkdown((await api.get<{ markdown: string }>(`/api/teams/export${query}`)).markdown);
          }}
          className="rounded-lg px-3 py-1.5 text-[13px]"
          style={{ background: 'var(--color-raised)' }}
        >
          {selected.length ? `Export ${selected.length} bot(s)` : 'Export everyone'}
        </button>
        {markdown ? (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(markdown)}
            className="rounded-lg px-3 py-1.5 text-[13px]"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            Copy Markdown
          </button>
        ) : null}
      </div>
      {markdown ? (
        <pre className="scroll-thin mt-2 max-h-48 overflow-auto rounded-lg p-2 font-mono text-[11px] whitespace-pre-wrap" style={{ background: 'var(--color-inset)' }}>
          {markdown}
        </pre>
      ) : null}
    </Section>
  );
}

function AdvancedTab({ config, onSave }: { config: PublicConfig; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  return (
    <>
      <Section
        title="Lean"
        hint="Cuts what each turn sends: a shorter transcript, only the skills that look relevant, tighter playbooks. Same bot, smaller bill."
      >
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={config.lean?.enabled !== false}
            onChange={(e) => void onSave({ lean: { enabled: e.target.checked, preferSmallModel: config.lean?.preferSmallModel === true } })}
          />
          Lean on for new turns
        </label>
        <label className="mt-2 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={config.lean?.preferSmallModel === true}
            onChange={(e) => void onSave({ lean: { enabled: config.lean?.enabled !== false, preferSmallModel: e.target.checked } })}
          />
          Prefer a smaller model for short messages
        </label>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Smaller-model routing stays on the same provider (Haiku, Fast, Mini). It never jumps you to a
          different vendor. A bot can pin Lean on or off in its profile.
        </p>
      </Section>

      <Section title="Language">
        <select value={config.language} onChange={(e) => void onSave({ language: e.target.value })} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
          <option value="">Follow the operating system</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Most of the interface is still English. Translated strings are an overlay, and anything
          missing falls back rather than showing a key name.
        </p>
      </Section>

      <Section title="Transcript">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={config.showToolCalls} onChange={(e) => void onSave({ showToolCalls: e.target.checked })} />
          Show every tool call as a chip
        </label>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Off by default. Finished tools always show; this adds the start of each one too.
        </p>
      </Section>

      <Section title="Updates">
        <select value={config.updates} onChange={(e) => void onSave({ updates: e.target.value })} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
          <option value="Automatic">Automatic</option>
          <option value="Manual">Manual</option>
        </select>
      </Section>

      <Section title="Experimental" hint="Off by default.">
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={config.experimental.embeddedBrowser}
            onChange={(e) => void onSave({ experimental: { ...config.experimental, embeddedBrowser: e.target.checked } })}
          />
          Built-in browser
        </label>
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Analytics, where enabled, are anonymous product events only — never conversations, prompts,
          or files.
        </p>
      </Section>

      <DecisionLog />

      <TeamExport />

      <Section title="Where your data lives">
        <p className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Transcripts, keys, memory, and events are in <code className="font-mono">~/.harnessbot</code> on
          this machine. Close the app before backing it up. A copied config.json is not a portable key
          export — packaged builds wrap credentials in OS secure storage.
        </p>
      </Section>
    </>
  );
}
