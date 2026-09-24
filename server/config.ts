import type { BrowserProfile, ComputerPlacement, ExtraModel, McpServerRecord } from '../shared/types.ts';
import { mergeMcpServers } from './hermes-bridge.ts';
import { dataPath, readJsonSafe, writeJsonAtomic } from './paths.ts';

/**
 * config.json. Secrets are write-only through the API: GET returns booleans only
 * (HB-PROMPT-001 invariant 3). Values leave this process only as child-process env.
 */

export interface InstanceConfig {
  /** Any slug — not an enum. Unknown drivers must round-trip, not be dropped. */
  driver: string;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Models the user added; merged onto the driver's built-in catalogue at snapshot. */
  extraModels?: ExtraModel[];
}

export interface HarnessConfig {
  secrets: Record<string, string>;
  instances: Record<string, InstanceConfig>;
  mcpServers: McpServerRecord[];
  vps: { sshAlias?: string };
  room: { turnTimeoutMinutes: number };
  localVm: { mode: 'shared' | 'per-bot'; maxInstances: number };
  /** Placement new bots inherit. Unset means Auto. */
  defaultComputer?: ComputerPlacement;
  /**
   * Lean is the workspace default for prompt size. Bots can pin on or off. It is on
   * by default because the alternative is paying for 40 turns and 40 skills forever.
   */
  lean: { enabled: boolean; preferSmallModel: boolean };
  browserProfiles: BrowserProfile[];
  language: string;
  skin: string;
  voice: string;
  theme: 'light' | 'dark' | 'system';
  updates: 'Automatic' | 'Manual';
  showToolCalls: boolean;
  experimental: { skillRecorder: boolean; embeddedBrowser: boolean };
  analyticsEmail?: string;
  onboardedAt?: number;
}

/** Secret names the API accepts. Anything else is refused rather than quietly stored. */
export const SECRET_KEYS = [
  'xai.key',
  'composio.apiKey',
  'box.token',
  'elevenlabs.key',
  'openai.imageKey',
  'opencodeGo.apiKey',
  'anthropic.key',
  'openaiCompat.key',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** Env fallbacks, so a source run can be keyed without touching config.json. */
const SECRET_ENV: Record<SecretKey, string> = {
  'xai.key': 'XAI_API_KEY',
  'composio.apiKey': 'COMPOSIO_API_KEY',
  'box.token': 'BOX_TOKEN',
  'elevenlabs.key': 'HB_TTS_KEY',
  'openai.imageKey': 'HB_OPENAI_IMAGE_KEY',
  'opencodeGo.apiKey': 'OPENCODE_API_KEY',
  'anthropic.key': 'ANTHROPIC_API_KEY',
  'openaiCompat.key': 'HB_OPENAI_COMPAT_KEY',
};

const DEFAULT_INSTANCES: Record<string, InstanceConfig> = Object.fromEntries(
  ['claude', 'codex', 'grok', 'cursor', 'kimi', 'droid', 'antigravity', 'opencode', 'opencodeGo', 'qwen', 'hermes', 'pi'].map(
    (id) => [id, { driver: id } as InstanceConfig],
  ),
);

const DEFAULTS: HarnessConfig = {
  secrets: {},
  instances: DEFAULT_INSTANCES,
  mcpServers: [],
  vps: {},
  room: { turnTimeoutMinutes: 5 },
  localVm: { mode: 'shared', maxInstances: 2 },
  lean: { enabled: true, preferSmallModel: false },
  browserProfiles: [{ id: 'default', name: 'Default' }],
  language: '',
  skin: 'white',
  voice: '',
  theme: 'system',
  updates: 'Automatic',
  showToolCalls: false,
  experimental: { skillRecorder: false, embeddedBrowser: false },
};

const CONFIG_FILE = dataPath('config.json');

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  allowed.includes(v as T) ? (v as T) : dflt;

/** Lowercase, [a-z0-9_-]{1,40}, never `guest` (reserved throwaway partition). */
export function canonicalProfileId(raw: string): string | null {
  const id = String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!id || id === 'guest' || id.length > 40) return null;
  return id;
}

function normalize(raw: Partial<HarnessConfig> | null): HarnessConfig {
  const r = raw ?? {};
  const profiles: BrowserProfile[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(r.browserProfiles) ? r.browserProfiles : DEFAULTS.browserProfiles) {
    const id = canonicalProfileId(p?.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    profiles.push({ id, name: String(p?.name || id) });
  }
  if (profiles.length === 0) profiles.push({ id: 'default', name: 'Default' });

  const instances: Record<string, InstanceConfig> = {};
  for (const [id, inst] of Object.entries(r.instances ?? DEFAULTS.instances)) {
    if (!inst || typeof inst !== 'object' || typeof inst.driver !== 'string') continue;
    // Unknown drivers round-trip untouched so a downgrade cannot destroy config.
    const extraModels = Array.isArray(inst.extraModels)
      ? inst.extraModels
          .filter((m): m is ExtraModel => !!m && typeof m.id === 'string' && m.id.trim().length > 0)
          .map((m) => ({ id: m.id.trim().slice(0, 200), label: typeof m.label === 'string' ? m.label.trim().slice(0, 80) : undefined }))
      : undefined;
    instances[id] = extraModels?.length ? { ...inst, extraModels } : { ...inst, extraModels: undefined };
  }
  if (Object.keys(instances).length === 0) Object.assign(instances, DEFAULT_INSTANCES);

  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.secrets ?? {})) {
    if ((SECRET_KEYS as readonly string[]).includes(k) && typeof v === 'string' && v) secrets[k] = v;
  }

  return {
    secrets,
    instances,
    // Servers the host Hermes has configured are folded in here, off, so the rest
    // of the harness sees one list and nothing downstream has to know about the
    // host. Their definitions are refreshed from Hermes on every load; only the
    // on/off switch is HarnessBot's, and only that is kept.
    mcpServers: mergeMcpServers(
      (Array.isArray(r.mcpServers) ? r.mcpServers : []).filter(
        (m): m is McpServerRecord => !!m && typeof m.name === 'string',
      ),
    ),
    vps: { sshAlias: typeof r.vps?.sshAlias === 'string' ? r.vps.sshAlias.replace(/[^\w.@-]/g, '') : undefined },
    room: { turnTimeoutMinutes: clampInt(r.room?.turnTimeoutMinutes, 1, 1440, 5) },
    localVm: {
      mode: oneOf(r.localVm?.mode, ['shared', 'per-bot'] as const, 'shared'),
      maxInstances: clampInt(r.localVm?.maxInstances, 1, 4, 2),
    },
    defaultComputer: (['cloud', 'vm', 'local', 'off'] as const).includes(r.defaultComputer as ComputerPlacement)
      ? (r.defaultComputer as ComputerPlacement)
      : undefined,
    lean: {
      enabled: r.lean?.enabled !== false,
      preferSmallModel: r.lean?.preferSmallModel === true,
    },
    browserProfiles: profiles,
    language: typeof r.language === 'string' ? r.language : '',
    skin: typeof r.skin === 'string' ? r.skin : 'white',
    voice: typeof r.voice === 'string' ? r.voice : '',
    theme: oneOf(r.theme, ['light', 'dark', 'system'] as const, 'system'),
    updates: oneOf(r.updates, ['Automatic', 'Manual'] as const, 'Automatic'),
    showToolCalls: r.showToolCalls === true,
    experimental: {
      skillRecorder: r.experimental?.skillRecorder === true,
      embeddedBrowser: r.experimental?.embeddedBrowser === true,
    },
    analyticsEmail: typeof r.analyticsEmail === 'string' ? r.analyticsEmail : undefined,
    onboardedAt: typeof r.onboardedAt === 'number' ? r.onboardedAt : undefined,
  };
}

let cache: HarnessConfig | null = null;
const listeners = new Set<(c: HarnessConfig) => void>();

export function getConfig(): HarnessConfig {
  if (!cache) cache = normalize(readJsonSafe<Partial<HarnessConfig> | null>(CONFIG_FILE, null));
  return cache;
}

export function onConfigChange(fn: (c: HarnessConfig) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function saveConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const next = normalize({ ...getConfig(), ...patch });
  cache = next;
  writeJsonAtomic(CONFIG_FILE, next);
  for (const fn of listeners) fn(next);
  return next;
}

export function setSecret(key: string, value: string | null): void {
  if (!(SECRET_KEYS as readonly string[]).includes(key)) throw new Error(`unknown secret: ${key}`);
  const secrets = { ...getConfig().secrets };
  if (value) secrets[key] = value;
  else delete secrets[key];
  saveConfig({ secrets });
}

export function getSecret(key: SecretKey): string | undefined {
  return getConfig().secrets[key] || process.env[SECRET_ENV[key]] || undefined;
}

/** An instance as the renderer may see it: its env names, never their values. */
export type PublicInstanceConfig = Omit<InstanceConfig, 'environment'> & { environmentKeys?: string[] };

/**
 * The only shape of config that ever leaves the process over HTTP or SSE.
 *
 * `secrets` was stripped here from the start, but `instances[].environment` was not —
 * and that is where a custom provider's API key lives. Anything written there was
 * echoed verbatim by GET /api/config and broadcast to every renderer on the `config`
 * event, which breaks the write-only rule the whole surface is built on. Env values
 * are replaced by their names, so the UI can still say "key set" without holding one.
 */
export function publicConfig(): Omit<HarnessConfig, 'secrets' | 'instances'> & {
  instances: Record<string, PublicInstanceConfig>;
  configured: Record<string, boolean>;
} {
  const { secrets: _secrets, instances, ...rest } = getConfig();
  const configured: Record<string, boolean> = {};
  for (const key of SECRET_KEYS) configured[key] = Boolean(getSecret(key));

  const publicInstances: Record<string, PublicInstanceConfig> = {};
  for (const [id, instance] of Object.entries(instances)) {
    const { environment, ...safe } = instance;
    publicInstances[id] = environment ? { ...safe, environmentKeys: Object.keys(environment) } : safe;
  }
  return { ...rest, instances: publicInstances, configured };
}
