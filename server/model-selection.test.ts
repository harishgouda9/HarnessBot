import { describe, expect, it } from 'vitest';
import { mergeModelSelection } from './model-selection.ts';

describe('mergeModelSelection', () => {
  const current = { instanceId: 'grok', model: 'grok-4', effort: 'high' as const, auto: true };

  it('keeps effort and auto when a client sends only the engine and model', () => {
    expect(mergeModelSelection(current, { instanceId: 'grok', model: 'grok-4-fast' })).toEqual({
      instanceId: 'grok',
      model: 'grok-4-fast',
      effort: 'high',
      auto: true,
    });
  });

  it('replaces effort when the patch includes it', () => {
    expect(mergeModelSelection(current, { instanceId: 'grok', model: 'grok-4', effort: 'low', auto: false })).toMatchObject({
      effort: 'low',
      auto: false,
    });
  });

  it('rejects a selection with no engine or model', () => {
    expect(() => mergeModelSelection(current, { instanceId: '  ', model: 'grok-4' })).toThrow(/engine and a model/);
    expect(() => mergeModelSelection(current, null)).toThrow(/object/);
    expect(() => mergeModelSelection(current, { effort: 'banana' })).toThrow(/effort/);
  });
});
