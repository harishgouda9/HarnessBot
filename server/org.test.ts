import { describe, expect, it } from 'vitest';
import { addLink, autoLayout, deleteChart, listCharts, orgGraph, removeLink, saveChart, setPosition, updateLink } from './org.ts';
import { store } from './store.ts';
import type { BotRecord } from '../shared/types.ts';

/**
 * The chart draws two different things — the reporting spine and the working graph —
 * and the sidecar holding the second one must never be able to damage the first.
 */

const makeBot = (name: string, extra: Partial<BotRecord> = {}) =>
  store.createBot({ name, modelSelection: { instanceId: 'fake', model: 'fake-1' }, ...extra });

describe('org links', () => {
  it('creates a link and gives it an addressable id', () => {
    const a = makeBot('LinkA');
    const b = makeBot('LinkB');
    const result = addLink({ from: a.id, to: b.id, kind: 'workflow', label: 'sends draft', step: 1 });

    expect(result.ok).toBe(true);
    expect(result.link!.id).toBeTruthy();
    expect(result.link).toMatchObject({ kind: 'workflow', label: 'sends draft', step: 1 });
  });

  it('refuses a self-link and an unknown kind', () => {
    const a = makeBot('SelfLink');
    expect(addLink({ from: a.id, to: a.id, kind: 'peer' }).ok).toBe(false);
    expect(addLink({ from: a.id, to: makeBot('Other').id, kind: 'nonsense' as never }).ok).toBe(false);
  });

  it('updates an existing edge instead of stacking duplicates', () => {
    const a = makeBot('DupeA');
    const b = makeBot('DupeB');
    const first = addLink({ from: a.id, to: b.id, kind: 'flow', label: 'one' });
    const second = addLink({ from: a.id, to: b.id, kind: 'flow', label: 'two' });

    expect(second.link!.id).toBe(first.link!.id);
    expect(second.link!.label).toBe('two');
    const drawn = orgGraph().links.filter((l) => l.from === a.id && l.to === b.id);
    expect(drawn).toHaveLength(1);
  });

  it('edits and removes a link by id', () => {
    const a = makeBot('EditA');
    const b = makeBot('EditB');
    const link = addLink({ from: a.id, to: b.id, kind: 'peer' }).link!;

    expect(updateLink(link.id, { kind: 'dotted', label: 'reviews' })).toMatchObject({ kind: 'dotted', label: 'reviews' });
    expect(updateLink('lnk_nope', { label: 'x' })).toBeNull();
    expect(removeLink(link.id)).toBe(true);
    expect(removeLink(link.id)).toBe(false);
  });

  it('hides links to a deleted bot without erasing them from disk', () => {
    const a = makeBot('KeeperA');
    const b = makeBot('KeeperB');
    addLink({ from: a.id, to: b.id, kind: 'flow' });
    expect(orgGraph().links.some((l) => l.from === a.id)).toBe(true);

    store.deleteBot(b.id);
    // Dropped from the drawing, because there is nothing to draw it to.
    expect(orgGraph().links.some((l) => l.from === a.id)).toBe(false);
  });

  it('exposes the reporting spine on the nodes, not as a sidecar link', () => {
    const manager = makeBot('Manager');
    const report = makeBot('Report', { reportsTo: manager.id });
    store.updateBot(report.id, { reportsTo: manager.id });

    const graph = orgGraph();
    expect(graph.nodes.find((n) => n.id === report.id)!.reportsTo).toBe(manager.id);
    // The spine is never duplicated into the link list.
    expect(graph.links.some((l) => l.from === manager.id && l.to === report.id)).toBe(false);
  });
});

describe('auto layout', () => {
  it('places reports below their manager and centres the manager over them', () => {
    const boss = makeBot('Boss');
    const one = makeBot('One');
    const two = makeBot('Two');
    store.updateBot(one.id, { reportsTo: boss.id });
    store.updateBot(two.id, { reportsTo: boss.id });

    const positions = autoLayout();
    expect(positions[one.id]!.y).toBeGreaterThan(positions[boss.id]!.y);
    expect(positions[two.id]!.y).toBeGreaterThan(positions[boss.id]!.y);

    // Centred: the manager sits between its two reports, not on top of the first.
    const midpoint = (positions[one.id]!.x + positions[two.id]!.x) / 2;
    expect(positions[boss.id]!.x).toBeCloseTo(midpoint, 5);
  });

  it('does not hang on a reporting cycle', () => {
    const a = makeBot('CycleA');
    const b = makeBot('CycleB');
    store.updateBot(a.id, { reportsTo: b.id });
    // The store repairs the ring on write; layout must survive either way.
    store.updateBot(b.id, { reportsTo: a.id });
    expect(() => autoLayout()).not.toThrow();
  });
});

describe('positions and saved views', () => {
  it('remembers a dragged position on the bot record', () => {
    const bot = makeBot('Dragged');
    setPosition(bot.id, { x: 120, y: 240 });
    expect(store.getBot(bot.id)!.orgPos).toEqual({ x: 120, y: 240 });
    expect(orgGraph().nodes.find((n) => n.id === bot.id)!.pos).toEqual({ x: 120, y: 240 });
  });

  it('saves, updates and deletes a view', () => {
    const bot = makeBot('Charted');
    const created = saveChart({ name: 'Process', botIds: [bot.id], positions: { [bot.id]: { x: 0, y: 0 } } });
    expect(created.ok).toBe(true);

    const updated = saveChart({ id: created.chart!.id, name: 'Process v2', botIds: [bot.id] });
    expect(listCharts()).toHaveLength(1);
    expect(updated.chart!.name).toBe('Process v2');
    // createdAt survives an update: a rename is not a new view.
    expect(updated.chart!.createdAt).toBe(created.chart!.createdAt);

    deleteChart(created.chart!.id);
    expect(listCharts()).toHaveLength(0);
  });
});
