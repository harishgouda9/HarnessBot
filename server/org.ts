import { newId, dataPath, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { store } from './store.ts';

/**
 * The org chart. `BotRecord.reportsTo` is the spine and is repaired on load; this
 * sidecar holds the decoration — extra link kinds, saved positions, saved charts —
 * so a corrupt sidecar can never break the hierarchy itself.
 */

/**
 * `reports` is the spine and lives on the bot record, not here.
 * `dotted` is a secondary reporting line, `peer` is a working relationship,
 * `flow` is a handoff, and `workflow` is an ordered step with a label — the thing
 * you draw when the chart is describing a process rather than a hierarchy.
 */
export type LinkKind = 'dotted' | 'peer' | 'flow' | 'workflow';

export const LINK_KINDS: LinkKind[] = ['dotted', 'peer', 'flow', 'workflow'];

export interface OrgLink {
  id: string;
  from: string;
  to: string;
  kind: LinkKind;
  label?: string;
  /** Ordering hint for workflow links, so a process reads in sequence. */
  step?: number;
}

export interface OrgChart {
  id: string;
  name: string;
  botIds: string[];
  /** A chart can pin its own positions, so two views of the same team can differ. */
  positions?: Record<string, { x: number; y: number }>;
  createdAt: number;
}

interface OrgFile {
  version: 1;
  links: OrgLink[];
  charts: OrgChart[];
  positions: Record<string, { x: number; y: number }>;
}

const FILE = dataPath('org-graph.json');
const MAX_LINKS = 4000;
const MAX_LINKS_PER_BOT = 64;
const MAX_CHARTS = 24;

const load = (): OrgFile => {
  const file = readJsonSafe<OrgFile>(FILE, { version: 1, links: [], charts: [], positions: {} });
  // Links predate ids. Give the old ones one so the UI can address them.
  let changed = false;
  for (const link of file.links) {
    if (!link.id) {
      link.id = newId('lnk');
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(FILE, file);
  return file;
};

const save = (file: OrgFile): void => writeJsonAtomic(FILE, file);

export function orgGraph() {
  const file = load();
  const bots = store.listBots().filter((b) => !b.hidden);
  const ids = new Set(bots.map((b) => b.id));
  return {
    nodes: bots.map((b) => ({
      id: b.id,
      name: b.name,
      title: b.title,
      color: b.color,
      section: b.section ?? '',
      chiefOfStaff: b.chiefOfStaff === true,
      reportsTo: b.reportsTo,
      activity: b.activity ?? 'idle',
      unread: b.unread === true,
      avatarUrl: b.avatarUrl,
      mascotExpression: b.mascotExpression,
      pos: b.orgPos ?? file.positions[b.id],
    })),
    // A link to a deleted bot is dropped from the view but left on disk; deleting a
    // bot should not silently rewrite a chart the user drew.
    links: file.links.filter((l) => ids.has(l.from) && ids.has(l.to)),
    charts: file.charts,
  };
}

export function addLink(input: Omit<OrgLink, 'id'> & { id?: string }): { ok: boolean; reason?: string; link?: OrgLink } {
  if (input.from === input.to) return { ok: false, reason: 'a bot cannot link to itself' };
  if (!LINK_KINDS.includes(input.kind)) return { ok: false, reason: `unknown link kind: ${input.kind}` };

  const file = load();
  if (file.links.length >= MAX_LINKS) return { ok: false, reason: 'link limit reached' };
  if (file.links.filter((l) => l.from === input.from).length >= MAX_LINKS_PER_BOT) {
    return { ok: false, reason: 'this bot has too many links' };
  }

  const existing = file.links.find((l) => l.from === input.from && l.to === input.to && l.kind === input.kind);
  if (existing) {
    // Re-adding the same edge updates its label rather than stacking duplicates.
    if (input.label !== undefined) existing.label = input.label;
    if (input.step !== undefined) existing.step = input.step;
    save(file);
    return { ok: true, link: existing };
  }

  const link: OrgLink = { ...input, id: input.id ?? newId('lnk') };
  file.links.push(link);
  save(file);
  return { ok: true, link };
}

export function updateLink(id: string, patch: Partial<Omit<OrgLink, 'id'>>): OrgLink | null {
  const file = load();
  const link = file.links.find((l) => l.id === id);
  if (!link) return null;
  if (patch.kind && !LINK_KINDS.includes(patch.kind)) return null;
  Object.assign(link, patch);
  save(file);
  return link;
}

export function removeLink(id: string): boolean {
  const file = load();
  const next = file.links.filter((l) => l.id !== id);
  if (next.length === file.links.length) return false;
  file.links = next;
  save(file);
  return true;
}

export function setPosition(botId: string, pos: { x: number; y: number }): void {
  store.updateBot(botId, { orgPos: pos });
  const file = load();
  file.positions[botId] = pos;
  save(file);
}

export function listCharts(): OrgChart[] {
  return load().charts;
}

export function saveChart(input: Partial<OrgChart> & { name: string; botIds: string[] }): { ok: boolean; reason?: string; chart?: OrgChart } {
  const file = load();
  const id = input.id ?? newId('chart');
  const index = file.charts.findIndex((c) => c.id === id);
  if (index < 0 && file.charts.length >= MAX_CHARTS) return { ok: false, reason: 'chart limit reached' };

  const chart: OrgChart = {
    id,
    name: input.name.slice(0, 80),
    botIds: input.botIds,
    positions: input.positions,
    createdAt: index >= 0 ? file.charts[index]!.createdAt : Date.now(),
  };
  if (index >= 0) file.charts[index] = chart;
  else file.charts.push(chart);
  save(file);
  return { ok: true, chart };
}

export function deleteChart(id: string): void {
  const file = load();
  file.charts = file.charts.filter((c) => c.id !== id);
  save(file);
}

/**
 * First-time layout is hierarchical from the roots, never a random scatter.
 *
 * Subtree widths are measured before placing anything, so siblings sit under their
 * own manager instead of drifting across the canvas as the tree gets deeper.
 */
export function autoLayout(): Record<string, { x: number; y: number }> {
  const bots = store.listBots().filter((b) => !b.hidden);
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const bot of bots) {
    if (bot.reportsTo && bots.some((b) => b.id === bot.reportsTo)) {
      children.set(bot.reportsTo, [...(children.get(bot.reportsTo) ?? []), bot.id]);
    } else {
      roots.push(bot.id);
    }
  }

  const COL = 200;
  const ROW = 150;
  const widths = new Map<string, number>();

  const measure = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 1;
    seen.add(id);
    const kids = children.get(id) ?? [];
    const width = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + measure(kid, seen), 0);
    widths.set(id, width);
    return width;
  };
  for (const root of roots) measure(root);

  const positions: Record<string, { x: number; y: number }> = {};
  let cursor = 0;

  const place = (id: string, depth: number, seen = new Set<string>()): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const kids = children.get(id) ?? [];
    const start = cursor;
    if (kids.length === 0) {
      positions[id] = { x: cursor * COL, y: depth * ROW };
      cursor++;
      return;
    }
    for (const kid of kids) place(kid, depth + 1, seen);
    // Centre a manager over the span its reports actually occupy.
    positions[id] = { x: ((start + cursor - 1) / 2) * COL, y: depth * ROW };
  };

  for (const root of roots) place(root, 0);
  return positions;
}

export function teamMap() {
  const groups = store.listGroups().filter((g) => !g.dm);
  const bots = store.listBots().filter((b) => !b.hidden);
  return {
    sections: [...new Set(bots.map((b) => b.section ?? ''))].map((section) => ({
      section,
      chief: store.chiefOf(section || undefined)?.id,
      botIds: bots.filter((b) => (b.section ?? '') === section).map((b) => b.id),
    })),
    rooms: groups.map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds, section: g.section ?? '' })),
  };
}
