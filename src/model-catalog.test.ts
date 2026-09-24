import { describe, expect, it } from 'vitest';
import { currentModelLabel, filterModels, flattenModels, groupModels, modelProvider, type CatalogEngine } from './model-catalog.ts';

const engines = (): CatalogEngine[] => [
  {
    instanceId: 'hermes',
    displayName: 'Hermes',
    state: 'available',
    models: [
      { id: 'default', label: 'As configured in hermes', default: true },
      { id: 'nemotron-3-ultra-free', label: 'Nemotron 3 Ultra', extra: true },
    ],
  },
  {
    instanceId: 'grok',
    displayName: 'Grok',
    state: 'available',
    models: [
      { id: 'grok-4', label: 'Grok 4', default: true },
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
    ],
  },
  {
    instanceId: 'codex',
    displayName: 'Codex',
    state: 'unavailable',
    reason: 'CLI not found',
    models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', default: true }],
  },
];

describe('modelProvider', () => {
  it('splits a Hermes provider:model id and leaves a plain id alone', () => {
    expect(modelProvider('openrouter:anthropic/claude')).toBe('openrouter');
    expect(modelProvider('grok-4.6')).toBeUndefined();
  });
});

describe('flattenModels', () => {
  it('lists every engine model, including added ones and unavailable engines', () => {
    const rows = flattenModels(engines());
    expect(rows.map((r) => `${r.displayName}:${r.modelId}`)).toEqual([
      'Hermes:default',
      'Hermes:nemotron-3-ultra-free',
      'Grok:grok-4',
      'Grok:grok-4-fast',
      'Codex:gpt-5-codex',
    ]);
    expect(rows.find((r) => r.modelId === 'nemotron-3-ultra-free')?.extra).toBe(true);
    expect(rows.find((r) => r.instanceId === 'codex')?.available).toBe(false);
  });
});

describe('filterModels', () => {
  it('matches engine name, model id and label', () => {
    const rows = flattenModels(engines());
    expect(filterModels(rows, 'hermes').map((r) => r.modelId)).toEqual(['default', 'nemotron-3-ultra-free']);
    expect(filterModels(rows, 'fast').map((r) => r.modelId)).toEqual(['grok-4-fast']);
    expect(filterModels(rows, 'GROK-4').map((r) => r.modelId)).toEqual(['grok-4', 'grok-4-fast']);
  });
});

describe('groupModels', () => {
  it('keeps available engines above unavailable ones', () => {
    const groups = groupModels(flattenModels(engines()));
    expect(groups.map((g) => g.displayName)).toEqual(['Grok', 'Hermes', 'Codex']);
    expect(groups[2]?.available).toBe(false);
    expect(groups[2]?.reason).toBe('CLI not found');
  });
});

describe('currentModelLabel', () => {
  it('prefers the catalogue label over the raw id', () => {
    expect(currentModelLabel({ instanceId: 'grok', model: 'grok-4-fast' }, engines())).toEqual({
      engine: 'Grok',
      model: 'Grok 4 Fast',
    });
  });

  it('falls back to ids when the engine is gone', () => {
    expect(currentModelLabel({ instanceId: 'missing', model: 'x' }, engines())).toEqual({
      engine: 'missing',
      model: 'x',
    });
  });
});
