/**
 * The flat catalogue the in-chat model switcher reads.
 *
 * Every connected engine contributes its built-in models plus anything the user
 * added on that instance. Grouping and search live here so the popover and a
 * test can share one answer for "what can I switch this bot to".
 */

export interface CatalogEngine {
  instanceId: string;
  displayName: string;
  state: 'available' | 'unavailable';
  reason?: string;
  models: { id: string; label: string; default?: boolean; extra?: boolean }[];
}

export interface CatalogRow {
  instanceId: string;
  displayName: string;
  available: boolean;
  reason?: string;
  modelId: string;
  modelLabel: string;
  extra?: boolean;
  default?: boolean;
}

export interface CatalogGroup {
  instanceId: string;
  displayName: string;
  available: boolean;
  reason?: string;
  models: CatalogRow[];
}

export function flattenModels(instances: CatalogEngine[]): CatalogRow[] {
  return instances.flatMap((instance) =>
    instance.models.map((model) => ({
      instanceId: instance.instanceId,
      displayName: instance.displayName,
      available: instance.state === 'available',
      reason: instance.reason,
      modelId: model.id,
      modelLabel: model.label,
      extra: model.extra,
      default: model.default,
    })),
  );
}

export function filterModels(rows: CatalogRow[], query: string): CatalogRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (row) =>
      row.modelId.toLowerCase().includes(q) ||
      row.modelLabel.toLowerCase().includes(q) ||
      row.displayName.toLowerCase().includes(q),
  );
}

/** Available engines first, then unavailable; models keep their instance order. */
export function groupModels(rows: CatalogRow[]): CatalogGroup[] {
  const order: string[] = [];
  const byEngine = new Map<string, CatalogGroup>();
  for (const row of rows) {
    let group = byEngine.get(row.instanceId);
    if (!group) {
      group = {
        instanceId: row.instanceId,
        displayName: row.displayName,
        available: row.available,
        reason: row.reason,
        models: [],
      };
      byEngine.set(row.instanceId, group);
      order.push(row.instanceId);
    }
    group.models.push(row);
  }
  return order
    .map((id) => byEngine.get(id)!)
    .sort((a, b) => Number(b.available) - Number(a.available) || a.displayName.localeCompare(b.displayName));
}

/** Hermes advertises `provider:model`. The provider is the part before the first colon. */
export function modelProvider(modelId: string): string | undefined {
  const cut = modelId.indexOf(':');
  return cut > 0 ? modelId.slice(0, cut) : undefined;
}

/**
 * The name a picker row should show.
 *
 * Hermes inventory labels look like `openai-codex · ChatGPT or Codex Subscription · gpt-5.4`.
 * A single-line truncate keeps the provider prefix and clips the model id, so every row
 * looks the same. The id after the colon is what distinguishes them.
 */
export function visibleModelName(modelId: string, label: string): string {
  const cut = modelId.indexOf(':');
  const modelPart = (cut > 0 ? modelId.slice(cut + 1) : modelId).trim() || modelId;
  const trimmed = label.trim();
  if (!trimmed || trimmed === modelId) return modelPart;
  const sep = trimmed.lastIndexOf(' · ');
  if (sep < 0) return trimmed;
  const tail = trimmed.slice(sep + 3).trim();
  if (!tail || /[.…]$/.test(tail)) return modelPart;
  if (tail.toLowerCase() === modelPart.toLowerCase()) return tail;
  if (tail.length <= 64) return tail;
  return modelPart;
}

/**
 * Name for the header and the composer button.
 *
 * Picker rows can stay short because the provider is already a group heading.
 * The chrome has no heading, and a long subscription label truncates before the
 * model id, so every pin looks like the same provider. Show `provider · model`.
 */
export function chromeModelName(modelId: string, label?: string): string {
  const provider = modelProvider(modelId);
  let name = modelId;
  if (label !== undefined) name = visibleModelName(modelId, label);
  else if (provider) name = modelId.slice(modelId.indexOf(':') + 1);
  if (!provider) return name || modelId;
  return `${provider} · ${name}`;
}

export function currentModelLabel(
  selection: { instanceId: string; model: string } | undefined,
  instances: CatalogEngine[],
): { engine: string; model: string } {
  if (!selection) return { engine: '', model: '' };
  const instance = instances.find((i) => i.instanceId === selection.instanceId);
  const model = instance?.models.find((m) => m.id === selection.model);
  return {
    engine: instance?.displayName ?? selection.instanceId,
    model: model ? chromeModelName(model.id, model.label) : chromeModelName(selection.model),
  };
}
