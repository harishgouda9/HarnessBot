import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotRecord } from '../../shared/types.ts';
import { api } from '../api.ts';
import { t } from '../i18n.ts';
import { currentModelLabel, filterModels, flattenModels, groupModels, modelProvider, visibleModelName, type CatalogRow } from '../model-catalog.ts';
import { useStore } from '../store.tsx';
import { Icon } from './Icons.tsx';
import { AddProviderDialog } from './Overlays.tsx';

/**
 * In-chat model switcher.
 *
 * The header still names the engine; this is the place you change it without
 * leaving the composer — every connected CLI, Hermes, a custom endpoint, and
 * models added on those engines, in one searchable list. A pick pins the bot
 * (drops `auto`) so the next send uses that pair, not whichever engine happens
 * to be up.
 */

function subgroup(rows: CatalogRow[]): { provider?: string; rows: CatalogRow[] }[] {
  const blocks: { provider?: string; rows: CatalogRow[] }[] = [];
  for (const row of rows) {
    const provider = modelProvider(row.modelId);
    const last = blocks[blocks.length - 1];
    if (last && last.provider === provider) last.rows.push(row);
    else blocks.push({ provider, rows: [row] });
  }
  return blocks;
}

export function ChatModelPicker({ bot }: { bot: BotRecord }) {
  const { state, refreshBots, refreshInstances, refreshConfig } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [draft, setDraft] = useState({ instanceId: bot.modelSelection.instanceId, id: '', label: '' });
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const instances = state.instances;
  const selection = bot.modelSelection;
  const current = currentModelLabel(selection, instances);
  const groups = useMemo(
    () => groupModels(filterModels(flattenModels(instances), query)),
    [instances, query],
  );
  const active = instances.find((i) => i.instanceId === selection.instanceId);
  const live = instances.find((i) => i.state === 'available');

  const refreshCatalog = async (force: boolean): Promise<void> => {
    const hermes = instances.filter((instance) => instance.driver === 'hermes' && instance.state === 'available');
    const pending = force ? hermes : hermes.filter((instance) => !instance.models.some((model) => model.id.includes(':')));
    if (!pending.length) {
      if (force) setProbeError(hermes.length ? '' : 'Hermes is not connected, so the model list cannot be reloaded.');
      return;
    }
    setProbing(true);
    setProbeError('');
    try {
      const results = await Promise.all(
        pending.map((instance) =>
          api.post(`/api/instances/${instance.instanceId}/models`, {}).then(
            () => true,
            () => false,
          ),
        ),
      );
      await refreshInstances();
      if (results.some((ok) => !ok)) setProbeError('Could not reload the model list. Try again.');
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refreshCatalog(false);
    // Probe once per open. `instances` is read at open time; Refresh reloads even when ids already have a provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const save = async (next: BotRecord['modelSelection']): Promise<void> => {
    await api.patch(`/api/bots/${bot.id}`, { modelSelection: next });
    await refreshBots();
  };

  const pick = (instanceId: string, model: string): void => {
    const instance = instances.find((i) => i.instanceId === instanceId);
    if (!instance || instance.state !== 'available') return;
    const effort =
      selection.effort && instance.capabilities.effortLevels.includes(selection.effort)
        ? selection.effort
        : undefined;
    void save({ instanceId, model, effort, auto: false });
    setOpen(false);
    setQuery('');
  };

  const addModel = async (): Promise<void> => {
    const id = draft.id.trim();
    if (!id || !draft.instanceId) return;
    setBusy(true);
    try {
      const existing = state.config?.instances[draft.instanceId]?.extraModels ?? [];
      if (!existing.some((m) => m.id === id)) {
        await api.patch(`/api/instances/${draft.instanceId}`, {
          extraModels: [...existing, { id, label: draft.label.trim() || undefined }],
        });
        await refreshInstances();
        await refreshConfig();
      }
      await save({ instanceId: draft.instanceId, model: id, auto: false });
      setDraft({ instanceId: draft.instanceId, id: '', label: '' });
      setAddingModel(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${current.engine} · ${current.model}`}
        aria-label={t('composer.changeModel')}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex max-w-[18rem] items-center gap-1 rounded-xl px-2 py-1.5 text-left text-[12px]"
        style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
      >
        <span className="min-w-0 flex-1 truncate">{current.model || current.engine || 'Model'}</span>
        {selection.auto ? (
          <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--color-raised)', color: 'var(--color-ink-secondary)' }}>
            auto
          </span>
        ) : null}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className="card absolute bottom-11 right-0 z-30 flex w-[min(28rem,calc(100vw-2rem))] flex-col py-2"
            style={{ background: 'var(--color-panel)', maxHeight: 'min(24rem, 70vh)' }}
            role="listbox"
            aria-label={t('composer.changeModel')}
          >
            <div className="flex items-center gap-1 px-2 pb-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('composer.searchModels')}
                aria-label={t('composer.searchModels')}
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[13px]"
                style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
              />
              <button
                type="button"
                disabled={probing}
                onClick={() => void refreshCatalog(true)}
                className="shrink-0 rounded-lg px-2 py-1.5 text-[12px] disabled:opacity-50"
                style={{ background: 'var(--color-raised)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
                title="Reload the model list from Hermes"
              >
                {probing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {probeError ? (
              <div className="px-3 pb-2 text-[11px]" style={{ color: 'var(--color-warning, var(--color-ink-secondary))' }}>
                {probeError}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => {
                void save({
                  instanceId: live?.instanceId ?? selection.instanceId,
                  model: selection.model,
                  effort: selection.effort,
                  auto: true,
                });
                setOpen(false);
              }}
              className="mx-2 mb-1 rounded-lg px-2 py-1.5 text-left text-[13px]"
              style={{
                background: selection.auto ? 'color-mix(in srgb, var(--color-accent) 12%, var(--color-inset))' : 'transparent',
                border: `1px solid ${selection.auto ? 'var(--color-accent-border)' : 'transparent'}`,
              }}
            >
              <span className="block font-medium">Follow the workspace</span>
              <span className="block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Use whichever engine is connected
              </span>
            </button>

            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-1">
              {groups.length === 0 ? (
                <div className="px-3 py-4 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  Nothing matched. Add the model id below if the provider has it.
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.instanceId} className="mb-2">
                    <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-ink-secondary)' }}>
                      {group.displayName}
                      {!group.available ? ` · ${group.reason || t('engines.unavailable')}` : null}
                    </div>
                    {probing && group.instanceId === instances.find((i) => i.driver === 'hermes')?.instanceId ? (
                      <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                        Loading Hermes providers…
                      </div>
                    ) : null}
                    {subgroup(group.models).map((block) => (
                      <div key={block.provider ?? group.instanceId}>
                        {block.provider ? (
                          <div className="px-2 pt-1 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                            {block.provider}
                          </div>
                        ) : null}
                        {block.rows.map((row) => {
                      const selected = selection.instanceId === row.instanceId && selection.model === row.modelId;
                      return (
                        <button
                          key={`${row.instanceId}:${row.modelId}`}
                          type="button"
                          disabled={!row.available}
                          onClick={() => pick(row.instanceId, row.modelId)}
                          className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] disabled:opacity-45"
                          style={{ background: selected ? 'var(--color-raised)' : 'transparent' }}
                          role="option"
                          aria-selected={selected}
                          title={row.modelId}
                        >
                          <span className="min-w-0 flex-1 whitespace-normal break-words">{visibleModelName(row.modelId, row.modelLabel)}</span>
                          {row.extra ? (
                            <span className="shrink-0 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                              added
                            </span>
                          ) : null}
                          {selected ? <Icon name="check" size={12} /> : null}
                        </button>
                      );
                        })}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>

            {active?.capabilities.effortLevels.length ? (
              <div className="px-2 pt-1">
                <select
                  value={selection.effort ?? ''}
                  onChange={(e) =>
                    void save({
                      ...selection,
                      effort: (e.target.value || undefined) as BotRecord['modelSelection']['effort'],
                    })
                  }
                  className="w-full rounded-lg px-2 py-1.5 text-[12px]"
                  style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
                  aria-label="Effort"
                >
                  <option value="">Default effort</option>
                  {active.capabilities.effortLevels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {addingModel ? (
              <div className="mx-2 mt-2 rounded-lg p-2" style={{ background: 'var(--color-inset)' }}>
                <div className="text-[12px] font-medium">Add a model from any provider</div>
                <select
                  value={draft.instanceId}
                  onChange={(e) => setDraft({ ...draft, instanceId: e.target.value })}
                  className="mt-1 w-full rounded-lg px-2 py-1.5 text-[12px]"
                  style={{ background: 'var(--color-raised)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
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
                  style={{ background: 'var(--color-raised)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
                />
                <input
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="Label (optional)"
                  className="mt-1 w-full rounded-lg px-2 py-1.5 text-[12px]"
                  style={{ background: 'var(--color-raised)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => setAddingModel(false)} className="rounded-lg px-2 py-1 text-[12px]">
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
              <div className="flex flex-wrap gap-1 px-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAddingModel(true)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px]"
                  style={{ background: 'var(--color-raised)' }}
                >
                  <Icon name="plus" size={12} />
                  Add a model
                </button>
                <button
                  type="button"
                  onClick={() => setAddingProvider(true)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px]"
                  style={{ background: 'var(--color-raised)' }}
                >
                  <Icon name="plus" size={12} />
                  Use my own API key
                </button>
              </div>
            )}
          </div>
        </>
      ) : null}

      {addingProvider ? (
        <AddProviderDialog
          onClose={() => {
            setAddingProvider(false);
            void refreshInstances();
          }}
        />
      ) : null}
    </div>
  );
}
