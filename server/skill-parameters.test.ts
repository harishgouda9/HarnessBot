import { describe, expect, it } from 'vitest';
import { parameterise, renderParameters } from './skill-parameters.ts';

/**
 * The point of parameterising is that a recording made against one customer runs
 * against the next. The behaviour that matters is consistency — the same literal
 * has to become the same placeholder everywhere, or step 5 quietly refers to a
 * different customer than step 2.
 */

describe('parameterise', () => {
  it('lifts a repeated literal to one placeholder', () => {
    const { steps, parameters } = parameterise([
      'Open the record for "Acme Corp"',
      'Set the invoice name to "Acme Corp"',
    ]);
    expect(steps).toEqual(['Open the record for "{{value}}"', 'Set the invoice name to "{{value}}"']);
    expect(parameters).toEqual([{ name: 'value', example: 'Acme Corp' }]);
  });

  it('gives distinct literals of one kind distinct names', () => {
    const { steps, parameters } = parameterise(['Email "first" then "second"']);
    expect(steps[0]).toBe('Email "{{value}}" then "{{value_2}}"');
    expect(parameters.map((p) => p.name)).toEqual(['value', 'value_2']);
  });

  it('recognises addresses, links and dates by shape', () => {
    const { steps, parameters } = parameterise([
      'Send it to ops@example.com',
      'Open https://example.com/reports?q=1',
      'Filter to 2026-04-01',
    ]);
    expect(steps).toEqual(['Send it to {{email}}', 'Open {{url}}', 'Filter to {{date}}']);
    expect(parameters.map((p) => p.name)).toEqual(['email', 'url', 'date']);
  });

  it('does not template a value twice when a shape sits inside quotes', () => {
    const { steps, parameters } = parameterise(['Type "ops@example.com" into the field']);
    expect(steps[0]).toBe('Type "{{email}}" into the field');
    expect(parameters).toEqual([{ name: 'email', example: 'ops@example.com' }]);
  });

  it('leaves a step with nothing input-shaped exactly as recorded', () => {
    const { steps, parameters } = parameterise(['Click the Export button', 'Wait for the spinner to stop']);
    expect(steps).toEqual(['Click the Export button', 'Wait for the spinner to stop']);
    expect(parameters).toEqual([]);
  });

  it('stops before a step becomes more placeholder than instruction', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Set field to "v${i}"`);
    const { parameters, steps } = parameterise(many);
    expect(parameters).toHaveLength(12);
    // Everything past the ceiling keeps its recorded literal rather than breaking.
    expect(steps[29]).toBe('Set field to "v29"');
  });

  it('handles an empty recording', () => {
    expect(parameterise([])).toEqual({ steps: [], parameters: [] });
  });
});

describe('renderParameters', () => {
  it('renders nothing when there was nothing to lift', () => {
    expect(renderParameters([])).toEqual([]);
  });

  it('lists each placeholder with the value it was recorded from', () => {
    const block = renderParameters([{ name: 'email', example: 'ops@example.com' }]).join('\n');
    expect(block).toContain('## Parameters');
    expect(block).toContain('`{{email}}` — e.g. ops@example.com');
  });
});
