import fs from 'node:fs';
import path from 'node:path';
import type { McpServerRecord } from '../shared/types.ts';

/**
 * What the host Hermes brought with it.
 *
 * When HarnessBot runs as a Hermes plugin, the plugin writes a small manifest
 * naming Hermes' MCP servers and its skills directory, and points
 * `HB_HERMES_BRIDGE` at it. Standalone, the variable is unset and every function
 * here answers empty — nothing else in the harness needs to know which it is.
 *
 * Read once per process. The manifest is rewritten before each harness start, so
 * a stale read cannot outlive the run it belongs to, and re-reading it on every
 * turn would be filesystem work for a file that cannot change underneath us.
 */

export interface HermesBridge {
  version: number;
  profile?: string;
  skillsRoot?: string | null;
  mcpServers?: McpServerRecord[];
  writtenAt?: number;
}

/** Imported servers are named `hermes/<name>` so a refresh never touches the user's own. */
export const HERMES_PREFIX = 'hermes/';

const MAX_SKILLS = 300;
const MAX_SKILL_BYTES = 128 * 1024;

let cache: HermesBridge | null | undefined;

export function bridge(): HermesBridge | null {
  if (cache !== undefined) return cache;
  const file = process.env.HB_HERMES_BRIDGE;
  if (!file) return (cache = null);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HermesBridge;
    cache = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // A missing or malformed manifest means no bridge, never a failed boot: the
    // harness has to run standalone, and that is the same code path.
    cache = null;
  }
  return cache;
}

/** Test seam. The manifest is process-scoped in every other respect. */
export function resetBridgeCache(): void {
  cache = undefined;
}

export function bridgedMcpServers(): McpServerRecord[] {
  const servers = bridge()?.mcpServers;
  if (!Array.isArray(servers)) return [];
  return servers
    .filter((s): s is McpServerRecord => !!s && typeof s.name === 'string' && s.name.startsWith(HERMES_PREFIX))
    .map((s) => ({ ...s, enabled: false }));
}

/**
 * Merge imported definitions into the stored list.
 *
 * The definition always comes from Hermes and the *switch* always comes from
 * HarnessBot: whether a bot may hold a tool is a HarnessBot decision, and it must
 * survive Hermes rewriting its own config. An import that disappears from Hermes
 * disappears here too, rather than lingering as a server nobody can explain.
 */
export function mergeMcpServers(stored: McpServerRecord[]): McpServerRecord[] {
  const imported = bridgedMcpServers();
  const own = stored.filter((s) => !s.name.startsWith(HERMES_PREFIX));
  const wasEnabled = new Map(stored.filter((s) => s.name.startsWith(HERMES_PREFIX)).map((s) => [s.name, s.enabled]));
  return [...own, ...imported.map((s) => ({ ...s, enabled: wasEnabled.get(s.name) ?? false }))];
}

/**
 * Every `SKILL.md` under Hermes' skills directory, as raw bodies.
 *
 * Returns bodies rather than records so this module never imports `skills.ts`,
 * which imports this one to extend the library.
 */
export function hermesSkillFiles(): { name: string; body: string }[] {
  const root = bridge()?.skillsRoot;
  if (!root) return [];

  const found: { name: string; body: string }[] = [];
  const seen = new Set<string>();

  // Hermes files skills one category deep (`skills/<category>/<name>/SKILL.md`);
  // HarnessBot's own library is flat. Walking a bounded depth covers both without
  // caring which layout it was handed.
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || found.length >= MAX_SKILLS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_SKILLS) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (entry.name.toLowerCase() !== 'skill.md') continue;
      const name = path.basename(dir);
      if (seen.has(name)) continue;
      try {
        if (fs.statSync(full).size > MAX_SKILL_BYTES) continue;
        found.push({ name, body: fs.readFileSync(full, 'utf8') });
        seen.add(name);
      } catch {
        // An unreadable skill is skipped, not fatal.
      }
    }
  };

  walk(root, 0);
  return found;
}

/** What Settings shows about the host, and what the tests assert on. */
export function bridgeStatus(): {
  connected: boolean;
  profile?: string;
  skillsRoot?: string | null;
  mcpServers: number;
  skills: number;
} {
  const found = bridge();
  if (!found) return { connected: false, mcpServers: 0, skills: 0 };
  return {
    connected: true,
    profile: found.profile,
    skillsRoot: found.skillsRoot ?? null,
    mcpServers: bridgedMcpServers().length,
    skills: hermesSkillFiles().length,
  };
}
