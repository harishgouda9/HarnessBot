import type { McpServerRecord } from '../shared/types.ts';
import { getConfig, saveConfig } from './config.ts';
import { dataPath, newId, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { confirmSkill, fetchText, removeSkill, sha256, slugFromPath, stageSkill, summarize } from './skills.ts';

/**
 * Plugins: one source that contributes several skills and MCP servers at once.
 *
 * Two phase on purpose, the same way team packages are (HB-PRD-001 F-TEAM-02). A
 * repository off the internet is untrusted input, so parsing produces a plan the user
 * reads — every skill name, its summary, its digest, and every MCP server the package
 * wants mounted — and installing applies only that reviewed plan. Nothing is fetched
 * again between the two, because a source that changes under a confirmed digest is
 * exactly the attack the digest exists to stop.
 */

const FILE = dataPath('plugins.json');
const MAX_SKILLS_PER_PLUGIN = 25;
const MAX_PLUGINS = 50;

export interface PluginSkill {
  name: string;
  summary: string;
  path: string;
  body: string;
  sha256: string;
}

export interface PluginPlan {
  name: string;
  description: string;
  source: string;
  /** Where the files actually came from, so the plan can be audited. */
  repo?: { owner: string; repo: string; ref: string; subPath: string };
  skills: PluginSkill[];
  mcpServers: McpServerRecord[];
  warnings: string[];
}

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  source: string;
  /** The scope its skills were installed into: a bot id, or `global`. */
  scope: string;
  skills: string[];
  mcpServers: string[];
  installedAt: number;
}

interface PluginFile {
  version: 1;
  plugins: InstalledPlugin[];
}

const load = (): PluginFile => readJsonSafe<PluginFile>(FILE, { version: 1, plugins: [] });
const save = (file: PluginFile): void => writeJsonAtomic(FILE, file);

export const listPlugins = (): InstalledPlugin[] => load().plugins;

// ---------------------------------------------------------------------------
// Parsing a source into a plan
// ---------------------------------------------------------------------------

interface RepoRef {
  owner: string;
  repo: string;
  ref: string;
  subPath: string;
}

/**
 * The four shapes people actually paste: `owner/repo`, the repo page, a `tree` URL
 * with a branch and folder, and the same with a trailing slash.
 */
export function parseRepoRef(input: string): RepoRef | null {
  const raw = String(input ?? '').trim().replace(/\/+$/, '');
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(raw);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, ref: '', subPath: '' };

  const url = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/i.exec(raw);
  if (!url) return null;
  return { owner: url[1]!, repo: url[2]!.replace(/\.git$/, ''), ref: url[3] ?? '', subPath: url[4] ?? '' };
}

async function githubJson<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'harnessbot' },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub is rate limiting anonymous requests. Try again in a few minutes.');
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** Parse a plugin source into a reviewable plan. Fetches, never installs. */
export async function parsePlugin(source: string): Promise<PluginPlan> {
  const ref = parseRepoRef(source);
  if (!ref) {
    // Not a repo: treat it as a single SKILL.md so one pasted URL still works here.
    const body = await fetchText(source);
    const meta = summarize(body);
    const name = meta.name ?? slugFromPath(source) ?? 'imported-skill';
    return {
      name,
      description: meta.summary,
      source,
      skills: [{ name, summary: meta.summary, path: source, body, sha256: sha256(body) }],
      mcpServers: [],
      warnings: [],
    };
  }

  const branch =
    ref.ref || (await githubJson<{ default_branch?: string }>(`/repos/${ref.owner}/${ref.repo}`)).default_branch || 'main';
  const tree = await githubJson<{ tree?: { path: string; type: string }[]; truncated?: boolean }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );

  const warnings: string[] = [];
  if (tree.truncated) warnings.push('This repository is large; GitHub truncated its file list, so some skills may be missing.');

  const inScope = (p: string): boolean => !ref.subPath || p === ref.subPath || p.startsWith(`${ref.subPath}/`);
  const raw = (p: string): string => `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${p}`;

  const skillPaths = (tree.tree ?? [])
    .filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/i.test(e.path) && inScope(e.path))
    .map((e) => e.path);
  if (skillPaths.length > MAX_SKILLS_PER_PLUGIN) {
    warnings.push(`Only the first ${MAX_SKILLS_PER_PLUGIN} of ${skillPaths.length} skills are listed.`);
  }

  const skills: PluginSkill[] = [];
  const seen = new Set<string>();
  for (const path of skillPaths.slice(0, MAX_SKILLS_PER_PLUGIN)) {
    try {
      const body = await fetchText(raw(path));
      const meta = summarize(body);
      const name = meta.name ?? slugFromPath(path) ?? 'skill';
      // Two folders can legitimately hold the same skill name; the first wins and
      // the second is reported rather than silently overwriting it on install.
      if (seen.has(name)) {
        warnings.push(`Skipped a second skill also called "${name}" (${path}).`);
        continue;
      }
      seen.add(name);
      skills.push({ name, summary: meta.summary, path, body, sha256: sha256(body) });
    } catch (err) {
      warnings.push(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const manifestPath = (tree.tree ?? []).find((e) => inScope(e.path) && /(^|\/)\.claude-plugin\/plugin\.json$/.test(e.path));
  let name = ref.repo;
  let description = '';
  if (manifestPath) {
    try {
      const manifest = JSON.parse(await fetchText(raw(manifestPath.path))) as { name?: string; description?: string };
      name = String(manifest.name ?? name).slice(0, 80);
      description = String(manifest.description ?? '').slice(0, 300);
    } catch {
      warnings.push('plugin.json could not be read; falling back to the repository name.');
    }
  }

  const mcpPath = (tree.tree ?? []).find((e) => inScope(e.path) && /(^|\/)\.mcp\.json$/.test(e.path));
  const mcpServers: McpServerRecord[] = [];
  if (mcpPath) {
    try {
      const parsed = JSON.parse(await fetchText(raw(mcpPath.path))) as {
        mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string> }>;
      };
      for (const [serverName, entry] of Object.entries(parsed.mcpServers ?? {})) {
        const transport = entry.url ? (entry.type === 'sse' ? 'sse' : 'http') : 'stdio';
        if (transport === 'stdio' && !entry.command) continue;
        mcpServers.push({
          name: `${name}/${serverName}`.slice(0, 80),
          // Off on arrival. A package does not get to decide what runs on this machine.
          enabled: false,
          transport,
          command: entry.command,
          args: entry.args,
          env: entry.env,
          url: entry.url,
        });
      }
    } catch {
      warnings.push('.mcp.json could not be read; no servers will be added.');
    }
  }

  if (!skills.length && !mcpServers.length) warnings.push('No SKILL.md files and no MCP servers were found here.');

  return {
    name,
    description,
    source,
    repo: { owner: ref.owner, repo: ref.repo, ref: branch, subPath: ref.subPath },
    skills,
    mcpServers,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Installing a reviewed plan
// ---------------------------------------------------------------------------

/**
 * Apply the plan the user read. Each skill is staged and confirmed against the digest
 * carried in the plan, so a body that differs from the one shown cannot install.
 */
export function installPlugin(scope: string, plan: PluginPlan): { plugin: InstalledPlugin; notes: string[] } {
  const file = load();
  if (file.plugins.length >= MAX_PLUGINS) throw new Error(`plugin limit reached (${MAX_PLUGINS})`);
  // A plan that contributes nothing is a wrong path, not an install. Recording it
  // would leave a row in the list that removes nothing when removed.
  if (!plan.skills?.length && !plan.mcpServers?.length) {
    throw new Error('that source contributes no skills and no MCP servers - check the path');
  }

  const notes: string[] = [];
  const installed: string[] = [];
  for (const skill of plan.skills ?? []) {
    try {
      const staged = stageSkill(scope, skill.name, skill.summary, skill.body);
      if (staged.sha256 !== skill.sha256) throw new Error('bytes differ from the reviewed plan');
      confirmSkill(scope, staged.name, staged.sha256);
      installed.push(staged.name);
    } catch (err) {
      notes.push(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const servers = [...getConfig().mcpServers];
  const mounted: string[] = [];
  for (const server of plan.mcpServers ?? []) {
    if (servers.some((s) => s.name === server.name)) {
      notes.push(`An MCP server called ${server.name} already exists; it was left alone.`);
      continue;
    }
    servers.push({ ...server, enabled: false });
    mounted.push(server.name);
  }
  if (mounted.length) {
    saveConfig({ mcpServers: servers });
    notes.push(`${mounted.length} MCP server${mounted.length === 1 ? '' : 's'} added, switched off. Turn on the ones you want.`);
  }

  const plugin: InstalledPlugin = {
    id: newId('plg'),
    name: plan.name.slice(0, 80),
    description: (plan.description ?? '').slice(0, 300),
    source: plan.source,
    scope,
    skills: installed,
    mcpServers: mounted,
    installedAt: Date.now(),
  };
  file.plugins.push(plugin);
  save(file);
  return { plugin, notes };
}

/** Remove a plugin and everything it brought with it. */
export function removePlugin(id: string): boolean {
  const file = load();
  const plugin = file.plugins.find((p) => p.id === id);
  if (!plugin) return false;

  for (const name of plugin.skills) removeSkill(plugin.scope, name);
  if (plugin.mcpServers.length) {
    saveConfig({ mcpServers: getConfig().mcpServers.filter((s) => !plugin.mcpServers.includes(s.name)) });
  }
  file.plugins = file.plugins.filter((p) => p.id !== id);
  save(file);
  return true;
}
