import type { MemoryEntry, Routine, SkillRecord } from '../shared/types.ts';
import { getConfig } from './config.ts';
import { listAllMemory } from './memory.ts';
import { listRoutines, loadWebhooks } from './routines.ts';
import { listSkills } from './skills.ts';
import { store } from './store.ts';

export interface RosterBackup {
  version: 1;
  exportedAt: number;
  bots: unknown[];
  memory: MemoryEntry[];
  skills: SkillRecord[];
  routines: Routine[];
}

const SECRET_KEYS = /^(secrets|secret|secretHash|password|apiKey|token|authorization|headers|environment|env|resumeCursors)$/i;

function collectSecrets(): string[] {
  const values = new Set<string>();
  const config = getConfig();
  for (const value of Object.values(config.secrets)) if (value) values.add(value);
  for (const server of config.mcpServers) {
    for (const value of Object.values(server.env ?? {})) if (value) values.add(value);
    for (const value of Object.values(server.headers ?? {})) if (value) values.add(value);
  }
  for (const instance of Object.values(config.instances)) {
    for (const value of Object.values(instance.environment ?? {})) if (value) values.add(value);
  }
  for (const hook of loadWebhooks().webhooks) if (hook.secretHash) values.add(hook.secretHash);
  return [...values].filter((value) => value.length >= 8);
}

function scrub(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(key)) continue;
      out[key] = scrub(item, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Bots, memory, skills, and routines. API keys, webhook hashes, connector
 * headers, and instance environment values are left out.
 */
export function buildRosterBackup(): RosterBackup {
  const skills: SkillRecord[] = [];
  const seen = new Set<string>();
  const scopes = ['global', ...store.listBots().map((bot) => bot.id)];
  for (const scope of scopes) {
    let installed: SkillRecord[] = [];
    try {
      installed = listSkills(scope);
    } catch {
      continue;
    }
    for (const skill of installed) {
      const key = `${scope}:${skill.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(skill);
    }
  }

  const raw: RosterBackup = {
    version: 1,
    exportedAt: Date.now(),
    bots: store.listBots(),
    memory: listAllMemory(),
    skills,
    routines: listRoutines().map((routine) => ({ ...routine, attachments: undefined })),
  };
  return scrub(raw, collectSecrets()) as RosterBackup;
}
