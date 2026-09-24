import { useEffect, useMemo, useState } from 'react';
import { BOT_COLORS, type BotRecord, type HarnessbotColor } from '../../shared/types.ts';
import { api } from '../api.ts';
import { t } from '../i18n.ts';
import { currentModelLabel, modelProvider } from '../model-catalog.ts';
import { jumpToMessage, jumpToThread, useStore, type InstanceSnapshot } from '../store.tsx';
import { Avatar, botColor } from './Avatar.tsx';
import { Icon } from './Icons.tsx';

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

function Modal({ children, onClose, label }: { children: React.ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4" style={{ background: '#0009' }} onClick={onClose}>
      <div className="card anim-pop w-[min(560px,96vw)] p-4" style={{ background: 'var(--color-panel)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/**
 * Model picker: a provider rail with defaults marked and unavailable engines dimmed
 * *with the reason*. Hiding a broken engine hides the fix (HB-UIUX-001 s12).
 */
function blocksOf<T extends { id: string }>(models: T[]): { provider?: string; models: T[] }[] {
  const blocks: { provider?: string; models: T[] }[] = [];
  for (const model of models) {
    const provider = modelProvider(model.id);
    const last = blocks[blocks.length - 1];
    if (last && last.provider === provider) last.models.push(model);
    else blocks.push({ provider, models: [model] });
  }
  return blocks;
}

export function ModelPicker({
  instances,
  value,
  onChange,
}: {
  instances: InstanceSnapshot[];
  value: { instanceId: string; model: string; effort?: string };
  onChange: (next: { instanceId: string; model: string; effort?: string }) => void;
}) {
  const { state, refreshInstances, refreshConfig } = useStore();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ instanceId: value.instanceId, id: '', label: '' });
  const [busy, setBusy] = useState(false);
  const active = instances.find((i) => i.instanceId === value.instanceId);
  const q = query.trim().toLowerCase();

  const catalog = instances.flatMap((instance) =>
    instance.models.map((model) => ({ instance, model })),
  );
  const hits = q
    ? catalog.filter(
        (row) =>
          row.model.id.toLowerCase().includes(q) ||
          row.model.label.toLowerCase().includes(q) ||
          row.instance.displayName.toLowerCase().includes(q),
      )
    : [];

  const addModel = async (): Promise<void> => {
    const id = draft.id.trim();
    if (!id || !draft.instanceId) return;
    setBusy(true);
    try {
      const existing = state.config?.instances[draft.instanceId]?.extraModels ?? [];
      if (existing.some((m) => m.id === id)) return;
      await api.patch(`/api/instances/${draft.instanceId}`, {
        extraModels: [...existing, { id, label: draft.label.trim() || undefined }],
      });
      await refreshInstances();
      await refreshConfig();
      onChange({ instanceId: draft.instanceId, model: id, effort: value.effort });
      setDraft({ ...draft, id: '', label: '' });
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (instanceId: string, modelId: string): Promise<void> => {
    const existing = state.config?.instances[instanceId]?.extraModels ?? [];
    await api.patch(`/api/instances/${instanceId}`, { extraModels: existing.filter((m) => m.id !== modelId) });
    await refreshInstances();
    await refreshConfig();
  };

  const row = (instance: InstanceSnapshot, model: InstanceSnapshot['models'][number]) => {
    const selected = value.instanceId === instance.instanceId && value.model === model.id;
    return (
      <div key={`${instance.instanceId}:${model.id}`} className="flex items-center gap-1">
        <button
          type="button"
          disabled={instance.state !== 'available'}
          onClick={() => onChange({ instanceId: instance.instanceId, model: model.id, effort: value.effort })}
          className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-[13px] disabled:opacity-45"
          style={{ background: selected ? 'var(--color-raised)' : 'transparent' }}
        >
          <span className="block truncate">{model.label}</span>
          {q ? (
            <span className="block truncate text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {instance.displayName}
            </span>
          ) : null}
          {model.default ? (
            <span className="ml-0 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
              default
            </span>
          ) : null}
          {model.extra ? (
            <span className="ml-2 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
              added
            </span>
          ) : null}
        </button>
        {model.extra ? (
          <button
            type="button"
            onClick={() => void removeModel(instance.instanceId, model.id)}
            aria-label={`Remove ${model.label}`}
            className="grid h-7 w-7 place-items-center rounded-md"
            style={{ color: 'var(--color-danger)' }}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search every connected model"
        aria-label="Search every connected model"
        className="mb-2 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={inputStyle}
      />

      {q ? (
        <div className="max-h-56 overflow-y-auto">
          {hits.length ? hits.map((h) => row(h.instance, h.model)) : (
            <div className="px-2 py-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              Nothing matched. Add the id below if the provider has it.
            </div>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="w-40 shrink-0">
            {instances.map((instance) => (
              <button
                key={instance.instanceId}
                type="button"
                disabled={instance.state !== 'available'}
                title={instance.reason}
                onClick={() =>
                  onChange({
                    instanceId: instance.instanceId,
                    model: instance.models.find((m) => m.default)?.id ?? instance.models[0]?.id ?? '',
                  })
                }
                className="block w-full rounded-lg px-2 py-1.5 text-left text-[13px] disabled:opacity-45"
                style={{ background: value.instanceId === instance.instanceId ? 'var(--color-raised)' : 'transparent' }}
              >
                <span className="block truncate">{instance.displayName}</span>
                <span className="block truncate text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {instance.state !== 'available' ? t('engines.unavailable') : `${instance.models.length} model${instance.models.length === 1 ? '' : 's'}`}
                </span>
              </button>
            ))}
          </div>

          <div className="min-w-0 flex-1">
            {active?.state !== 'available' ? (
              <div className="rounded-lg p-2 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-warning)' }}>
                {active?.reason ?? 'Pick an available engine.'}
              </div>
            ) : (
              <>
                {blocksOf(active.models).map((block) => (
                  <div key={block.provider ?? 'models'}>
                    {block.provider ? (
                      <div className="px-2 pt-1 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                        {block.provider}
                      </div>
                    ) : null}
                    {block.models.map((model) => row(active, model))}
                  </div>
                ))}
                {active.capabilities.effortLevels.length ? (
                  <select
                    value={value.effort ?? ''}
                    onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
                    className="mt-2 w-full rounded-lg px-2 py-1.5 text-[12px]"
                    style={inputStyle}
                  >
                    <option value="">Default effort</option>
                    {active.capabilities.effortLevels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {adding ? (
        <div className="mt-2 rounded-lg p-2" style={{ background: 'var(--color-inset)' }}>
          <div className="text-[12px] font-medium">Add a model from any provider</div>
          <select
            value={draft.instanceId}
            onChange={(e) => setDraft({ ...draft, instanceId: e.target.value })}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-[12px]"
            style={inputStyle}
          >
            {instances.map((instance) => (
              <option key={instance.instanceId} value={instance.instanceId}>
                {instance.displayName}
              </option>
            ))}
          </select>
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="Model id, e.g. grok-4-fast"
            className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
            style={inputStyle}
          />
          <input
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            placeholder="Label (optional)"
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-[12px]"
            style={inputStyle}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="rounded-lg px-2 py-1 text-[12px]">
              Cancel
            </button>
            <button
              type="button"
              disabled={!draft.id.trim() || busy}
              onClick={() => void addModel()}
              className="rounded-lg px-2 py-1 text-[12px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              {busy ? 'Adding…' : 'Add model'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft({ instanceId: value.instanceId || instances.find((i) => i.state === 'available')?.instanceId || '', id: '', label: '' });
            setAdding(true);
          }}
          className="mt-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[12px]"
          style={{ color: 'var(--color-ink-secondary)' }}
        >
          <Icon name="plus" size={12} />
          Add a model
        </button>
      )}
    </div>
  );
}

/**
 * The engine a bot is on, plus the way to change it.
 *
 * One component behind every entry point — the chat header, the profile sidebar, the
 * org chart — so "which model is this bot using, and how do I change it" has the same
 * answer and the same two clicks wherever it is asked.
 */
export function EngineRow({ bot, compact = false }: { bot: BotRecord; compact?: boolean }) {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const snapshot = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  const broken = snapshot?.state === 'unavailable';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
        style={{ background: 'var(--color-inset)', border: `1px solid ${broken ? 'var(--color-warning)' : 'transparent'}` }}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{snapshot?.displayName ?? bot.modelSelection.instanceId}</span>
            {bot.modelSelection.auto ? (
              <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--color-raised)', color: 'var(--color-ink-secondary)' }}>
                auto
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[11px]" style={{ color: broken ? 'var(--color-warning)' : 'var(--color-ink-secondary)' }}>
            {broken ? snapshot.reason : currentModelLabel(bot.modelSelection, state.instances).model || bot.modelSelection.model}
          </span>
        </span>
        <span className="shrink-0 rounded-md px-2 py-1 text-[11px]" style={{ background: 'var(--color-raised)' }}>
          {compact ? 'Change' : 'Change engine'}
        </span>
      </button>

      {open ? <EngineSwitcher bot={bot} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Bring your own endpoint.
 *
 * A provider is an *instance*, not a per-bot field: the key lives once in config and
 * any number of bots point at it. Putting a key on each bot record would mean the same
 * credential copied across a roster, with no single place to rotate it.
 *
 * The key is written into the instance's environment and never comes back — the API
 * returns the names of the variables that are set, not their values.
 */
export function AddProviderDialog({ onClose }: { onClose: () => void }) {
  const { refreshInstances, refreshConfig } = useStore();
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', models: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const id = slugId(form.name);
  const models = form.models
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
  const ready = Boolean(id) && /^https?:\/\//.test(form.baseUrl.trim()) && models.length > 0;

  const create = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      // One env name per instance, derived from its id, so two providers can never
      // collide on a variable and hand each other the wrong credential.
      const apiKeyEnv = `HB_PROVIDER_${id.toUpperCase().replace(/-/g, '_')}_KEY`;
      await api.post('/api/instances', {
        instanceId: id,
        driver: 'openaiCompat',
        config: {
          displayName: form.name.trim(),
          config: { baseUrl: form.baseUrl.trim(), apiKeyEnv, models: models.map((m) => ({ id: m })) },
          ...(form.apiKey.trim() ? { environment: { [apiKeyEnv]: form.apiKey.trim() } } : {}),
        },
      });
      await refreshInstances();
      await refreshConfig();
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Add a provider">
      <div className="text-[15px] font-semibold">Add a provider</div>
      <p className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Any OpenAI-compatible endpoint — OpenRouter, Together, vLLM, LM Studio, your own gateway.
        Once it is here, any bot can be pointed at it.
      </p>

      <label htmlFor="prov-name" className="mt-3 block text-[12px] font-medium">
        Name
      </label>
      <input
        id="prov-name"
        autoFocus
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        placeholder="OpenRouter"
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={inputStyle}
      />
      {id ? (
        <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          id: {id}
        </p>
      ) : null}

      <label htmlFor="prov-url" className="mt-3 block text-[12px] font-medium">
        Base URL
      </label>
      <input
        id="prov-url"
        value={form.baseUrl}
        onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        placeholder="https://openrouter.ai/api/v1"
        className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
        style={inputStyle}
      />

      <label htmlFor="prov-key" className="mt-3 block text-[12px] font-medium">
        API key
      </label>
      <input
        id="prov-key"
        type="password"
        value={form.apiKey}
        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
        placeholder="sk-…"
        className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
        style={inputStyle}
      />
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Stored on this machine and sent only to the endpoint above. It is never read back by the
        interface — to change it, type a new one.
      </p>

      <label htmlFor="prov-models" className="mt-3 block text-[12px] font-medium">
        Models
      </label>
      <textarea
        id="prov-models"
        value={form.models}
        onChange={(e) => setForm({ ...form, models: e.target.value })}
        rows={3}
        placeholder={'One per line:\nanthropic/claude-sonnet-4.5\nopenai/gpt-4o'}
        className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
        style={inputStyle}
      />
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        The first one is the default. This engine is text and reasoning only — it is never offered
        a computer or connected apps, because it has no way to use them.
      </p>

      {error ? (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void create()}
          className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
        >
          {busy ? 'Adding…' : 'Add provider'}
        </button>
      </div>
    </Modal>
  );
}

/** An instance id the server will accept: the same rule it validates against. */
function slugId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Switching engine from where you can see which one is running.
 *
 * Two states, deliberately exclusive so there is nothing to reason about: either the
 * bot follows whatever engine is connected, or it is pinned to one you chose. Picking
 * an engine pins it; the toggle hands it back to the workspace. A pinned engine that
 * later dies says so instead of silently rerouting, because a bot that quietly changed
 * provider mid-project is a worse surprise than one that stops and tells you.
 */
export function EngineSwitcher({ bot, onClose }: { bot: BotRecord; onClose: () => void }) {
  const { state, refreshBots, refreshInstances } = useStore();
  const selection = bot.modelSelection;
  const auto = selection.auto === true;
  const current = state.instances.find((i) => i.instanceId === selection.instanceId);
  const live = state.instances.find((i) => i.state === 'available');
  const [adding, setAdding] = useState(false);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const pending = state.instances.filter(
      (instance) => instance.driver === 'hermes' && instance.state === 'available' && !instance.models.some((model) => model.id.includes(':')),
    );
    if (!pending.length) return;
    let gone = false;
    setProbing(true);
    void Promise.all(pending.map((instance) => api.post(`/api/instances/${instance.instanceId}/models`, {}).catch(() => undefined)))
      .then(() => refreshInstances())
      .finally(() => {
        if (!gone) setProbing(false);
      });
    return () => {
      gone = true;
    };
    // Once per open. The parent mounts this dialog when the user asks to change engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (next: BotRecord['modelSelection']): Promise<void> => {
    await api.patch(`/api/bots/${bot.id}`, { modelSelection: next });
    await refreshBots();
  };

  return (
    <Modal onClose={onClose} label={`Engine for ${bot.name}`}>
      <div className="flex items-center gap-2">
        <Avatar name={bot.name} color={bot.color} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{bot.name}</div>
          <div className="truncate text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {current?.state === 'unavailable' ? current.reason : `${current?.displayName ?? selection.instanceId} · ${selection.model}`}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() =>
          void save(
            auto
              ? { instanceId: selection.instanceId, model: selection.model, effort: selection.effort }
              : { instanceId: live?.instanceId ?? selection.instanceId, model: selection.model, auto: true },
          )
        }
        aria-pressed={auto}
        className="mt-3 flex w-full items-start gap-2 rounded-lg p-2.5 text-left"
        style={{
          background: auto ? 'color-mix(in srgb, var(--color-accent) 12%, var(--color-inset))' : 'var(--color-inset)',
          border: `1px solid ${auto ? 'var(--color-accent-border)' : 'transparent'}`,
        }}
      >
        <span
          className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full"
          style={{ border: `1.5px solid ${auto ? 'var(--color-accent)' : 'var(--color-hairline)'}` }}
        >
          {auto ? <span className="h-2 w-2 rounded-full" style={{ background: 'var(--color-accent)' }} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">Follow the workspace</span>
          <span className="block text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Use whichever engine is connected. Switch provider once in Settings and every bot on
            this setting comes with you.
          </span>
        </span>
      </button>

      <div className="mt-3 text-[12px] font-medium">{auto ? 'Or pin one engine' : 'Pinned to'}</div>
      {probing ? (
        <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Loading every provider Hermes is signed into…
        </div>
      ) : null}
      <div className="mt-1 max-h-64 overflow-y-auto scroll-thin">
        <ModelPicker
          instances={state.instances}
          value={selection}
          /* An explicit pick is a pin: `auto` is dropped rather than left on to fight it.
             ModelPicker types effort loosely because drivers declare their own levels. */
          onChange={(next) => void save({ ...next, effort: next.effort as BotRecord['modelSelection']['effort'], auto: false })}
        />
      </div>

      <div className="mt-4 flex items-center gap-2">
        {/* "None of these" is a real answer, and it used to lead nowhere. */}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px]"
          style={{ background: 'var(--color-raised)' }}
        >
          <Icon name="plus" size={12} />
          Use my own API key
        </button>
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
          Done
        </button>
      </div>

      {adding ? <AddProviderDialog onClose={() => setAdding(false)} /> : null}
    </Modal>
  );
}

/**
 * `onCreated` lets a page that owns a canvas place the new bot itself — the team map
 * needs the id before the roster refresh lands, or the card appears wherever the
 * default layout puts it instead of where the user was looking.
 */
export function NewBotDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (botId: string) => void | Promise<void> }) {
  const { state, refreshBots, dispatch } = useStore();
  const available = state.instances.filter((i) => i.state === 'available');
  const [tab, setTab] = useState<'bot' | 'room' | 'import'>('bot');
  const [form, setForm] = useState({
    name: '',
    title: '',
    description: '',
    color: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)] as HarnessbotColor,
    cwd: '',
    modelSelection: {
      instanceId: available[0]?.instanceId ?? '',
      model: available[0]?.models.find((m) => m.default)?.id ?? available[0]?.models[0]?.id ?? '',
    } as { instanceId: string; model: string; effort?: string },
  });
  const [members, setMembers] = useState<string[]>([]);
  const [roomName, setRoomName] = useState('');

  return (
    <Modal onClose={onClose} label="New">
      <div className="flex gap-1">
        {(['bot', 'room', 'import'] as const).map((name) => (
          <button key={name} type="button" onClick={() => setTab(name)} className="rounded-lg px-2 py-1 text-[13px] capitalize" style={{ background: tab === name ? 'var(--color-raised)' : 'transparent' }}>
            {name === 'import' ? 'Import team' : `New ${name}`}
          </button>
        ))}
      </div>

      {tab === 'bot' ? (
        <>
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={form.name || 'New'} color={form.color} size={44} />
            <input autoFocus placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="flex-1 rounded-lg px-2 py-1.5 text-[14px]" style={inputStyle} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {BOT_COLORS.map((color) => (
              <button key={color} type="button" onClick={() => setForm({ ...form, color })} aria-label={color} className="h-6 w-6 rounded-full" style={{ background: botColor(color), outline: form.color === color ? '2px solid var(--color-focus)' : 'none', outlineOffset: 2 }} />
            ))}
          </div>
          <input placeholder="Title, e.g. Research lead" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="mt-2 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
          <textarea placeholder="What is this bot for? This becomes its system prompt." rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-2 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
          <input placeholder="Working folder (optional)" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} className="mt-2 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]" style={inputStyle} />

          <div className="mt-3 text-[12px] font-medium">Engine</div>
          <div className="mt-1 max-h-56 overflow-y-auto">
            <ModelPicker instances={state.instances} value={form.modelSelection} onChange={(modelSelection) => setForm({ ...form, modelSelection })} />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!form.name || !form.modelSelection.instanceId}
              onClick={async () => {
                const bot = await api.post<{ id: string }>('/api/bots', { ...form, cwd: form.cwd || undefined });
                await refreshBots();
                if (onCreated) await onCreated(bot.id);
                else dispatch({ type: 'select', selected: { kind: 'bot', id: bot.id } });
                onClose();
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              Create bot
            </button>
          </div>
        </>
      ) : tab === 'room' ? (
        <>
          <input autoFocus placeholder="Room name" value={roomName} onChange={(e) => setRoomName(e.target.value)} className="mt-3 w-full rounded-lg px-2 py-1.5 text-[14px]" style={inputStyle} />
          <div className="mt-2 max-h-56 overflow-y-auto">
            {state.bots
              .filter((b) => !b.hidden)
              .map((bot) => (
                <label key={bot.id} className="flex items-center gap-2 px-1 py-1 text-[13px]">
                  <input type="checkbox" checked={members.includes(bot.id)} onChange={(e) => setMembers(e.target.checked ? [...members, bot.id] : members.filter((id) => id !== bot.id))} />
                  <Avatar name={bot.name} color={bot.color} size={22} />
                  {bot.name}
                </label>
              ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!roomName || members.length === 0}
              onClick={async () => {
                const group = await api.post<{ id: string }>('/api/groups', { name: roomName, memberIds: members });
                await refreshBots();
                dispatch({ type: 'select', selected: { kind: 'group', id: group.id } });
                onClose();
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              Create room
            </button>
          </div>
        </>
      ) : (
        <TeamImport onClose={onClose} />
      )}
    </Modal>
  );
}

/** Two phase by design: parse to a plan the user reads, then apply. */
function TeamImport({ onClose }: { onClose: () => void }) {
  const { refreshBots } = useStore();
  const [source, setSource] = useState('');
  const [plan, setPlan] = useState<any>(null);
  const [error, setError] = useState('');

  return (
    <>
      <textarea
        placeholder="Paste a team Markdown package, or a GitHub URL"
        rows={5}
        value={source}
        onChange={(e) => setSource(e.target.value)}
        className="mt-3 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
        style={inputStyle}
      />
      {error ? (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      {plan ? (
        <div className="mt-3 max-h-64 overflow-y-auto">
          <div className="text-[13px] font-semibold">{plan.name}</div>
          <div className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {plan.summary}
          </div>
          <div className="mt-2 text-[12px]">
            {plan.bots.length} bot(s): {plan.bots.map((b: any) => b.name).join(', ')}
          </div>
          {plan.channels.length ? <div className="text-[12px]">{plan.channels.length} channel(s)</div> : null}
          {plan.routines.length ? <div className="text-[12px]">{plan.routines.length} routine(s) — they arrive paused</div> : null}
          {plan.requiredApps.length ? (
            <div className="mt-2 rounded-lg p-2 text-[12px]" style={{ background: 'var(--color-inset)' }}>
              Connector checklist: {plan.requiredApps.map((a: any) => a.slug).join(', ')}. Connections stay off until you approve them.
            </div>
          ) : null}
          {plan.rejected.length ? (
            <div className="mt-2 rounded-lg p-2 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-warning)' }}>
              {plan.rejected.join(' ')}
            </div>
          ) : null}
          <div className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Packages never carry credentials, conversations, permissions, memory, or computer access.
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
          Cancel
        </button>
        {plan ? (
          <button
            type="button"
            onClick={async () => {
              await api.post('/api/teams/import', { plan });
              await refreshBots();
              onClose();
            }}
            className="rounded-lg px-3 py-1.5 text-[13px]"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            Create this team
          </button>
        ) : (
          <button
            type="button"
            disabled={!source.trim()}
            onClick={async () => {
              setError('');
              try {
                const isUrl = /^https?:\/\//.test(source.trim());
                setPlan(await api.post('/api/teams/parse', isUrl ? { url: source.trim() } : { markdown: source }));
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
              }
            }}
            className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            Review
          </button>
        )}
      </div>
    </>
  );
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { state, dispatch } = store;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ threadId: string; message: { id: string; text?: string } }[]>([]);

  useEffect(() => {
    if (query.length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void api.get<{ messages: typeof hits }>(`/api/search?q=${encodeURIComponent(query)}`).then((r) => setHits(r.messages.slice(0, 20)));
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const lower = query.toLowerCase();
  const bots = state.bots.filter((b) => !b.hidden && b.name.toLowerCase().includes(lower)).slice(0, 8);
  const groups = state.groups.filter((g) => !g.dm && g.name.toLowerCase().includes(lower)).slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center p-4 pt-[12vh]" style={{ background: '#0009' }} onClick={onClose}>
      <div className="card anim-pop w-[min(600px,96vw)] overflow-hidden" style={{ background: 'var(--color-panel)' }} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="Jump to a bot, a room, or search every transcript"
          className="w-full px-4 py-3 text-[14px] outline-none"
          style={{ background: 'transparent', color: 'var(--color-ink)' }}
        />
        <div className="max-h-[50vh] overflow-y-auto border-t hairline">
          {bots.map((bot) => (
            <button
              key={bot.id}
              type="button"
              onClick={() => {
                dispatch({ type: 'select', selected: { kind: 'bot', id: bot.id } });
                onClose();
              }}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px]"
            >
              <Avatar name={bot.name} color={bot.color} size={22} />
              {bot.name}
            </button>
          ))}
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => {
                dispatch({ type: 'select', selected: { kind: 'group', id: group.id } });
                onClose();
              }}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px]"
            >
              # {group.name}
            </button>
          ))}
          {hits.map((hit) => (
            <button
              key={hit.message.id}
              type="button"
              onClick={async () => {
                await jumpToMessage(store, hit.threadId, hit.message.id);
                onClose();
              }}
              className="block w-full px-4 py-2 text-left text-[12px]"
              style={{ color: 'var(--color-ink-secondary)' }}
            >
              {hit.message.text?.slice(0, 110)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A specific screen, not an empty chat that looks broken. It only renders once
 * /api/instances has actually answered.
 */
export function NoEngines({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state } = useStore();
  return (
    <div className="grid flex-1 place-items-center p-8" style={{ background: 'var(--color-app)' }}>
      <div className="max-w-lg text-center">
        <h1 className="text-[18px] font-semibold">{t('noEngines.title')}</h1>
        <p className="mt-2 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {t('noEngines.body')}
        </p>
        <div className="card mt-4 p-3 text-left">
          {state.instances.map((instance) => (
            <div key={instance.instanceId} className="py-1 text-[12px]">
              <span className="font-medium">{instance.displayName}</span>
              <span className="ml-2" style={{ color: 'var(--color-warning)' }}>
                {instance.reason}
              </span>
            </div>
          ))}
        </div>
        <button type="button" onClick={onOpenSettings} className="mt-4 rounded-lg px-4 py-2 text-[13px]" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}>
          {t('noEngines.action')}
        </button>
      </div>
    </div>
  );
}

/** Skippable at every step. Onboarding must never be able to brick the app. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const { state, refreshConfig } = useStore();
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const isMac = navigator.platform.toLowerCase().includes('mac');

  const finish = async (): Promise<void> => {
    await api.patch('/api/config', { onboardedAt: Date.now(), analyticsEmail: email || undefined });
    await refreshConfig();
    onDone();
  };

  const steps = [
    {
      title: 'Welcome to HarnessBot',
      body: (
        <>
          <p className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Every contact here is a real agent running on this computer. Transcripts and keys stay in your home folder.
          </p>
          <input placeholder="Email (optional, for product analytics only)" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-3 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle} />
        </>
      ),
    },
    {
      title: 'Your engines',
      body: (
        <div className="max-h-56 overflow-y-auto">
          {state.instances.map((instance) => (
            <div key={instance.instanceId} className="flex items-center gap-2 py-1 text-[13px]">
              <span className="h-2 w-2 rounded-full" style={{ background: instance.state === 'available' ? 'var(--color-success)' : 'var(--color-warning)' }} />
              <span className="flex-1">{instance.displayName}</span>
              <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {instance.state}
              </span>
            </div>
          ))}
          <p className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            You can continue without any of these and set one up later.
          </p>
        </div>
      ),
    },
    {
      title: 'Voice',
      body: (
        <p className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {isMac
            ? 'Dictation uses on-device Apple speech. Speaking replies needs an ElevenLabs key and is off by default. Screen Recording is not requested here — only when a bot actually needs to see this computer.'
            : 'Speaking replies needs an ElevenLabs key. Dictation and calls are macOS-only in this version, and the UI will not pretend otherwise.'}
        </p>
      ),
    },
  ];

  const current = steps[step]!;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: 'var(--color-app)' }}>
      <div className="card w-[min(520px,96vw)] p-5">
        <h1 className="text-[16px] font-semibold">{current.title}</h1>
        <div className="mt-3">{current.body}</div>
        <div className="mt-5 flex items-center gap-2">
          <span className="flex-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Step {step + 1} of {steps.length}
          </span>
          <button type="button" onClick={() => void finish()} className="text-[13px]">
            Skip
          </button>
          <button
            type="button"
            onClick={() => (step === steps.length - 1 ? void finish() : setStep(step + 1))}
            className="rounded-lg px-3 py-1.5 text-[13px]"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            {step === steps.length - 1 ? 'Start' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

const NOTIFICATION_TONE: Record<string, string> = {
  'needs-approval': 'var(--color-warning)',
  'needs-hands': 'var(--color-warning)',
  finished: 'var(--color-success)',
  failed: 'var(--color-danger)',
};

/**
 * One line in the footer only ever showed the newest event, so anything that arrived
 * while you were reading something else was gone. This keeps the list, and every row
 * opens the exact bot and task that raised it.
 */
export function NotificationCentre() {
  const store = useStore();
  const { state } = store;
  const [open, setOpen] = useState(false);
  const waiting = state.notifications.filter((n) => n.kind === 'needs-approval' || n.kind === 'needs-hands').length;

  if (!state.notifications.length) return null;

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5" aria-expanded={open}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: waiting ? 'var(--color-warning)' : 'var(--color-ink-secondary)' }} />
        Activity
        {waiting ? <span style={{ color: 'var(--color-warning)' }}>{waiting}</span> : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="card anim-pop absolute bottom-6 left-0 z-40 max-h-80 w-80 overflow-y-auto py-1" style={{ background: 'var(--color-raised)' }}>
            {state.notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={async () => {
                  await jumpToThread(store, notification.threadId, notification.botId);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left"
              >
                <span className="flex items-center gap-1.5 text-[12px] font-medium">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: NOTIFICATION_TONE[notification.kind] }} />
                  {notification.botName}
                  <span className="font-normal" style={{ color: 'var(--color-ink-secondary)' }}>
                    {notification.kind.replace('-', ' ')}
                  </span>
                  <span className="flex-1" />
                  <span className="font-normal text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                    {new Date(notification.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {notification.preview.slice(0, 90)}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** macOS half-duplex call view: the mic is muted while the bot speaks. */
export function CallView({ botId, onClose }: { botId: string; onClose: () => void }) {
  const { state } = useStore();
  const bot = state.bots.find((b) => b.id === botId);
  const [speaking, setSpeaking] = useState(false);
  const messages = useMemo(() => (bot ? (state.threads[bot.threadId]?.messages ?? []) : []), [bot, state.threads]);
  const last = messages.filter((m) => m.role === 'bot' && m.kind === 'text').at(-1);

  if (!bot) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 p-8" style={{ background: 'var(--color-app)' }}>
      <Avatar name={bot.name} color={bot.color} activity={bot.activity} size={96} />
      <div className="text-[18px] font-semibold">{bot.name}</div>
      <div className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }} aria-live="polite">
        {speaking ? 'Speaking — your mic is muted' : bot.activity === 'working' ? 'Working' : 'Listening'}
      </div>
      <div className="max-w-lg text-center text-[14px]">{last?.text?.slice(0, 300)}</div>
      <div className="flex gap-2">
        <button type="button" onClick={() => setSpeaking(!speaking)} className="rounded-lg px-4 py-2 text-[13px]" style={{ background: 'var(--color-raised)' }}>
          {speaking ? 'Mute bot' : 'Hear reply'}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-[13px]" style={{ background: 'var(--color-danger)', color: '#fff' }}>
          End call
        </button>
      </div>
    </div>
  );
}
