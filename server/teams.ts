import type { BotRecord, HarnessbotColor, InstalledPlaybook, RoutineSchedule } from '../shared/types.ts';
import { BOT_COLORS } from '../shared/types.ts';
import { createRoutine } from './routines.ts';
import { store } from './store.ts';

/**
 * Team packages: a whole roster in one Markdown file (HB-PRD-001 F-ROOM-07).
 *
 * A package is untrusted input. It may describe people, process, and which apps a
 * role *needs*, and it may not carry credentials, conversations, permissions, memory,
 * or computer access. Import is two-phase — parse to a plan the user reviews, then
 * apply — because "install this team" should never be a single irreversible click.
 */

export interface TeamPlanBot {
  name: string;
  title: string;
  description: string;
  color?: HarnessbotColor;
  section?: string;
  chiefOfStaff?: boolean;
  reportsTo?: string;
  playbooks: InstalledPlaybook[];
  requiredApps: { slug: string; label: string; reason: string; optional?: boolean }[];
}

export interface TeamPlanRoutine {
  botName: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  durationMinutes: number;
}

export interface TeamPlan {
  id: string;
  name: string;
  release?: string;
  summary: string;
  bots: TeamPlanBot[];
  channels: { name: string; members: string[]; bulletin: string; defaultResponder?: 'member' | 'everyone' | 'mentions' }[];
  routines: TeamPlanRoutine[];
  requiredApps: { slug: string; label: string; reason: string; optional?: boolean }[];
  skills: string[];
  mcpServers: string[];
  /** Anything the package asked for that import refuses to honour. Shown on review. */
  rejected: string[];
}

/** Keys a package is never allowed to set, whatever it claims. */
const FORBIDDEN_KEYS = [
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'credential',
  'alwaysallow',
  'autoapprove',
  'computer',
  'cloudbackend',
  'composio',
  'memory',
  'conversation',
  'transcript',
  'cwd',
];

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Split on `## Heading` into labelled blocks. */
function sections(body: string): { heading: string; content: string }[] {
  const out: { heading: string; content: string }[] = [];
  const parts = body.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    out.push({
      heading: (newline < 0 ? part : part.slice(0, newline)).trim(),
      content: newline < 0 ? '' : part.slice(newline + 1),
    });
  }
  return out;
}

function fields(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const kv = /^\s*[-*]?\s*([A-Za-z0-9_ -]+):\s*(.+)$/.exec(line);
    if (kv) out[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }
  return out;
}

function parseSchedule(raw: string | undefined): RoutineSchedule {
  const time = /(\d{1,2}):(\d{2})/.exec(raw ?? '');
  const hh = String(Math.min(23, Number(time?.[1] ?? 9))).padStart(2, '0');
  const mm = String(Math.min(59, Number(time?.[2] ?? 0))).padStart(2, '0');
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const weekdays = names.map((n, i) => (raw?.toLowerCase().includes(n) ? i : -1)).filter((i) => i >= 0);
  return { kind: 'daily', time: `${hh}:${mm}`, weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5] };
}

export function parseTeamPackage(markdown: string): TeamPlan {
  const { meta, body } = parseFrontmatter(markdown);
  const rejected: string[] = [];

  for (const key of Object.keys(meta)) {
    if (FORBIDDEN_KEYS.some((f) => key.includes(f))) {
      rejected.push(`Ignored "${key}": packages cannot carry credentials or grants.`);
      delete meta[key];
    }
  }

  const plan: TeamPlan = {
    id: meta.id ?? `pkg_${Date.now()}`,
    name: meta.name ?? 'Imported team',
    release: meta.release,
    summary: meta.summary ?? '',
    bots: [],
    channels: [],
    routines: [],
    requiredApps: [],
    skills: (meta.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    mcpServers: (meta.mcpservers ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rejected,
  };

  for (const { heading, content } of sections(body)) {
    const [kindRaw, ...rest] = heading.split(':');
    const kind = (kindRaw ?? '').trim().toLowerCase();
    const label = rest.join(':').trim();
    const f = fields(content);

    for (const key of Object.keys(f)) {
      if (FORBIDDEN_KEYS.some((forbidden) => key.replace(/\s/g, '').includes(forbidden))) {
        rejected.push(`Ignored "${key}" on ${label || heading}: not allowed in a package.`);
        delete f[key];
      }
    }

    if (kind === 'bot') {
      const apps = (f.apps ?? f['connected apps'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((slug) => ({ slug, label: slug, reason: `${label} uses ${slug}`, optional: false }));
      plan.bots.push({
        name: label || 'Teammate',
        title: f.title ?? '',
        description: (f.description ?? content.split('\n').filter((l) => !l.includes(':')).join('\n')).trim().slice(0, 4000),
        color: (BOT_COLORS as string[]).includes(f.color ?? '') ? (f.color as HarnessbotColor) : undefined,
        section: f.section,
        chiefOfStaff: /^(true|yes)$/i.test(f['chief of staff'] ?? f.chief ?? ''),
        reportsTo: f['reports to'] ?? f.reportsto,
        playbooks: f.playbook
          ? [{ key: f.playbook.toLowerCase().replace(/\s+/g, '-'), name: f.playbook, summary: '', triggers: [], instructions: content.trim() }]
          : [],
        requiredApps: apps,
      });
      plan.requiredApps.push(...apps);
    } else if (kind === 'channel' || kind === 'room') {
      plan.channels.push({
        name: label || 'Room',
        members: (f.members ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        bulletin: f.bulletin ?? '',
        defaultResponder: (['member', 'everyone', 'mentions'] as const).find((d) => d === f['default responder']),
      });
    } else if (kind === 'routine') {
      plan.routines.push({
        botName: f.bot ?? '',
        name: label || 'Routine',
        prompt: f.prompt ?? content.trim(),
        schedule: parseSchedule(f.schedule),
        durationMinutes: Math.min(240, Math.max(15, Number(f.duration ?? 30))),
      });
    }
  }

  // De-duplicate the connector checklist by slug.
  const bySlug = new Map(plan.requiredApps.map((a) => [a.slug, a]));
  plan.requiredApps = [...bySlug.values()];
  return plan;
}

export interface ApplyResult {
  bots: BotRecord[];
  channels: string[];
  routines: string[];
  notes: string[];
}

/**
 * Apply a reviewed plan. Every switch that could act on the user's behalf starts off:
 * connections off, MCP off, routines paused (HB-TRD-001 consideration 6).
 */
export function applyTeamPlan(plan: TeamPlan, defaults: BotRecord['modelSelection']): ApplyResult {
  const result: ApplyResult = { bots: [], channels: [], routines: [], notes: [...plan.rejected] };
  const byName = new Map<string, BotRecord>();

  for (const spec of plan.bots) {
    const bot = store.createBot({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      color: spec.color,
      section: spec.section,
      modelSelection: defaults,
      playbooks: spec.playbooks,
      // Imported members cannot reach the user's connected accounts until they say so.
      composio: false,
      customMcp: false,
      installedPackage: {
        id: plan.id,
        name: plan.name,
        release: plan.release,
        requiredApps: spec.requiredApps,
        skills: plan.skills,
        mcpServers: plan.mcpServers,
      },
    });
    byName.set(spec.name.toLowerCase(), bot);
    result.bots.push(bot);
  }

  // Second pass: org links, once every name in the package resolves to an id.
  for (const spec of plan.bots) {
    const bot = byName.get(spec.name.toLowerCase());
    if (!bot) continue;
    const manager = spec.reportsTo ? byName.get(spec.reportsTo.toLowerCase()) : undefined;
    if (manager) store.updateBot(bot.id, { reportsTo: manager.id });
    if (spec.chiefOfStaff) store.setChiefOfStaff(bot.id, true);
  }

  for (const channel of plan.channels) {
    const memberIds = channel.members.map((n) => byName.get(n.toLowerCase())?.id).filter((id): id is string => !!id);
    if (!memberIds.length) {
      result.notes.push(`Skipped channel "${channel.name}": none of its members were created.`);
      continue;
    }
    const group = store.createGroup({
      name: channel.name,
      memberIds,
      bulletin: channel.bulletin,
      defaultResponder: channel.defaultResponder ?? 'member',
    });
    result.channels.push(group.id);
  }

  for (const routine of plan.routines) {
    const bot = byName.get(routine.botName.toLowerCase()) ?? result.bots[0];
    if (!bot) continue;
    const created = createRoutine({
      name: routine.name,
      prompt: routine.prompt,
      botId: bot.id,
      runOn: 'harnessbot',
      // Paused on arrival. A package must not start scheduling work by itself.
      enabled: false,
      schedule: routine.schedule,
      durationMinutes: routine.durationMinutes,
    });
    result.routines.push(created.id);
  }

  if (plan.requiredApps.length) {
    result.notes.push(
      `Connector checklist: ${plan.requiredApps.map((a) => a.slug).join(', ')}. Connections stay off until you approve each one.`,
    );
  }
  if (plan.mcpServers.length) {
    result.notes.push(`Package suggested MCP servers (${plan.mcpServers.join(', ')}). Add them yourself in Settings if you want them.`);
  }
  return result;
}

/** Export the roster as a package. Never includes keys, transcripts, or grants. */
export function exportTeam(botIds?: string[]): string {
  const bots = store.listBots().filter((b) => !b.hidden && (!botIds || botIds.includes(b.id)));
  const groups = store.listGroups().filter((g) => !g.dm && g.memberIds.some((id) => bots.some((b) => b.id === id)));
  const nameOf = (id: string): string => store.getBot(id)?.name ?? '';

  const lines = [
    '---',
    `name: ${'Exported team'}`,
    `id: pkg_${Date.now()}`,
    `summary: Exported from HarnessBot`,
    '---',
    '',
  ];

  for (const bot of bots) {
    lines.push(`## Bot: ${bot.name}`, '');
    if (bot.title) lines.push(`title: ${bot.title}`);
    if (bot.section) lines.push(`section: ${bot.section}`);
    lines.push(`color: ${bot.color}`);
    if (bot.chiefOfStaff) lines.push('chief of staff: true');
    if (bot.reportsTo) lines.push(`reports to: ${nameOf(bot.reportsTo)}`);
    const apps = bot.installedPackage?.requiredApps.map((a) => a.slug) ?? [];
    if (apps.length) lines.push(`apps: ${apps.join(', ')}`);
    lines.push('', bot.description, '');
  }

  for (const group of groups) {
    lines.push(`## Channel: ${group.name}`, '');
    lines.push(`members: ${group.memberIds.map(nameOf).filter(Boolean).join(', ')}`);
    lines.push(`default responder: ${group.defaultResponder}`);
    if (group.bulletin) lines.push(`bulletin: ${group.bulletin.replace(/\n/g, ' ')}`);
    lines.push('');
  }

  return lines.join('\n');
}
