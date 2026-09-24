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

export function currentModelLabel(
  selection: { instanceId: string; model: string } | undefined,
  instances: CatalogEngine[],
): { engine: string; model: string } {
  if (!selection) return { engine: '', model: '' };
  const instance = instances.find((i) => i.instanceId === selection.instanceId);
  const model = instance?.models.find((m) => m.id === selection.model);
  return {
    engine: instance?.displayName ?? selection.instanceId,
    model: model?.label ?? selection.model,
  };
}
