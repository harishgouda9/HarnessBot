import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { BotRecord, ComputerPlacement, McpServerRecord } from '../shared/types.ts';
import type { McpMount } from './contracts.ts';
import { getConfig, getSecret } from './config.ts';
import { execCli, findCli } from './drivers/spawn.ts';
import { bridge } from './hermes-bridge.ts';
import { dataPath, writeFileAtomic } from './paths.ts';

/**
 * Where a bot's hands are, and whether they are allowed to move.
 *
 * The rules here are the ones that cost the most to get wrong, so they are all
 * fail-closed: preview is not permission, Auto never reaches for the real seat on
 * Linux, and Wayland never starts host automation at all.
 */

export type DesktopSession = 'x11' | 'wayland' | 'quartz' | 'windows' | 'unknown';

export function desktopSession(): DesktopSession {
  if (process.platform === 'darwin') return 'quartz';
  if (process.platform === 'win32') return 'windows';
  const type = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (type === 'wayland' || process.env.WAYLAND_DISPLAY) return 'wayland';
  if (type === 'x11' || process.env.DISPLAY) return 'x11';
  return 'unknown';
}

export interface HostControlStatus {
  supported: boolean;
  /** True only when the user has explicitly opted in AND the platform allows it. */
  enabled: boolean;
  requiresOptIn: boolean;
  session: DesktopSession;
  reason?: string;
}

/**
 * Per-bot opt-in for the real seat, kept out of config.json's general settings.
 * The set is also written to disk: a harness restart must not quietly drop a
 * checkbox the user already confirmed.
 */
const localOptIn = new Set<string>();
let optInsLoaded = false;

function loadOptIns(): void {
  if (optInsLoaded) return;
  optInsLoaded = true;
  try {
    const ids = JSON.parse(fs.readFileSync(dataPath('local-computer.json'), 'utf8'));
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') localOptIn.add(id);
  } catch {
    // No file yet, or a torn write. The in-memory set still works for this process.
  }
}

function saveOptIns(): void {
  try {
    writeFileAtomic(dataPath('local-computer.json'), JSON.stringify([...localOptIn]));
  } catch {
    // A failed save must not undo the in-memory choice for this process.
  }
}

export function setLocalOptIn(botId: string, value: boolean): void {
  loadOptIns();
  if (value && desktopSession() === 'wayland') return; // Never record an opt-in we would refuse.
  if (value) localOptIn.add(botId);
  else localOptIn.delete(botId);
  saveOptIns();
}

export function hostControlStatus(botId?: string): HostControlStatus {
  loadOptIns();
  const session = desktopSession();
  if (session === 'wayland') {
    // Wayland gives no safe way to scope input injection to our own surfaces.
    // Legacy opt-ins are cleared rather than honoured (HB-TRD-001 consideration 11).
    if (botId && localOptIn.delete(botId)) saveOptIns();
    return {
      supported: false,
      enabled: false,
      requiresOptIn: true,
      session,
      reason: 'Ubuntu Wayland host control is disabled. Use Local VM, Box, or an Xorg session.',
    };
  }
  if (session === 'x11') {
    return {
      supported: true,
      enabled: botId ? localOptIn.has(botId) : false,
      requiresOptIn: true,
      session,
      reason: 'Xorg host control is beta and off until you opt in for this bot. There is no overlay.',
    };
  }
  if (session === 'quartz') {
    return {
      supported: true,
      enabled: botId ? localOptIn.has(botId) : false,
      requiresOptIn: true,
      session,
      reason: 'Requires Screen Recording and Accessibility permission for HarnessBot.',
    };
  }
  return {
    supported: true,
    enabled: botId ? localOptIn.has(botId) : false,
    requiresOptIn: true,
    session,
    reason: 'Local control follows the desktop capability gates.',
  };
}

/**
 * A screen-driving MCP server lent by a host Hermes, if the user switched one on.
 *
 * HarnessBot's own backends are a cloud desktop, a Local VM or this computer, and
 * on a headless VPS none of them exist. A host Hermes is usually already holding a
 * browser driver, and once that server is enabled a bot can drive it directly —
 * so when nothing else is available, say so instead of reporting no hands at all.
 *
 * Matched by name, and only among servers the user enabled. A tool this reaches
 * for without being asked is the failure this whole module is shaped to avoid.
 */
const SCREEN_DRIVER = /playwright|puppeteer|browser|computer|desktop|cua/i;

export function hostScreenServer(): McpServerRecord | undefined {
  return getConfig().mcpServers.find((server) => server.enabled && SCREEN_DRIVER.test(server.name));
}

export function hostedInHermes(): boolean {
  return Boolean(bridge());
}

function mountFromServer(server: McpServerRecord): McpMount | undefined {
  if (server.transport === 'stdio' && server.command) {
    return { transport: 'stdio', command: server.command, args: server.args ?? [], env: server.env };
  }
  if ((server.transport === 'http' || server.transport === 'sse') && server.url) {
    return { transport: server.transport, url: server.url, headers: server.headers };
  }
  return undefined;
}

export interface PlacementDecision {
  placement: ComputerPlacement | 'hermes';
  backend?: 'box' | 'vps' | 'local-vm' | 'host' | 'hermes';
  available: boolean;
  reason?: string;
}

/**
 * Resolve `computer` for a turn. Unset means Auto, and Auto may only reuse a backend
 * that is already verified — it never provisions everything, and it never reaches for
 * the host desktop (HB-TRD-001 consideration 10).
 */
export function resolvePlacement(bot: BotRecord): PlacementDecision {
  const requested = bot.computer;
  const config = getConfig();

  if (requested === 'off') return { placement: 'off', available: false, reason: 'Computer is off for this bot' };

  if (requested === 'local') {
    const status = hostControlStatus(bot.id);
    if (!status.supported) return { placement: 'off', available: false, reason: status.reason };
    if (!status.enabled) return { placement: 'local', backend: 'host', available: false, reason: status.reason };
    return { placement: 'local', backend: 'host', available: true };
  }

  if (requested === 'vm') {
    const runtime = findCli('docker') ?? findCli('podman');
    return runtime
      ? { placement: 'vm', backend: 'local-vm', available: true }
      : { placement: 'vm', backend: 'local-vm', available: false, reason: 'Install Docker or Podman to use a Local VM' };
  }

  if (requested === 'cloud') {
    const backend = bot.cloudBackend ?? 'box';
    if (backend === 'vps') {
      return config.vps.sshAlias
        ? { placement: 'cloud', backend: 'vps', available: true }
        : { placement: 'cloud', backend: 'vps', available: false, reason: 'Set an SSH alias in Settings -> VPS' };
    }
    return getSecret('box.token')
      ? { placement: 'cloud', backend: 'box', available: true }
      : { placement: 'cloud', backend: 'box', available: false, reason: 'Add a Box token in Settings -> Keys' };
  }

  // Auto. Reuse something already configured, in order of least surprise.
  if (getSecret('box.token')) return { placement: 'cloud', backend: 'box', available: true };
  if (findCli('docker') ?? findCli('podman')) return { placement: 'vm', backend: 'local-vm', available: true };
  const hosted = hostScreenServer();
  const hermesMount = hosted ? mountFromServer(hosted) : undefined;
  if (hosted && hermesMount) {
    // Hermes itself has no computer-use. A screen driver it already runs (Playwright,
    // browser, CUA, …) is a real pair of hands — Auto may reuse it, never the seat.
    return { placement: 'hermes', backend: 'hermes', available: true };
  }
  if (hostedInHermes()) {
    const status = hostControlStatus(bot.id);
    return {
      placement: 'off',
      available: false,
      reason: status.supported
        ? 'Hermes has no computer-use. Pick “This computer” and opt this bot in — HarnessBot will drive this machine. Or enable a Hermes browser MCP in Settings → MCP servers.'
        : status.reason,
    };
  }
  return { placement: 'off', available: false, reason: 'No verified computer backend; Auto will not start host control' };
}

/** Action ceiling per proxy session. 0 disables the cap. */
export const MAX_COMPUTER_ACTIONS = Number(process.env.HB_COMPUTER_MAX_ACTIONS ?? 300);

const actionCounts = new Map<string, number>();

export function peekActions(sessionKey: string): { allowed: boolean; used: number } {
  if (MAX_COMPUTER_ACTIONS === 0) return { allowed: true, used: 0 };
  const used = actionCounts.get(sessionKey) ?? 0;
  return { allowed: used < MAX_COMPUTER_ACTIONS, used };
}

export function countAction(sessionKey: string): { allowed: boolean; used: number } {
  if (MAX_COMPUTER_ACTIONS === 0) return { allowed: true, used: 0 };
  const used = (actionCounts.get(sessionKey) ?? 0) + 1;
  actionCounts.set(sessionKey, used);
  return { allowed: used <= MAX_COMPUTER_ACTIONS, used };
}

export function resetActions(sessionKey: string): void {
  actionCounts.delete(sessionKey);
}

/** Permission cards and tool names that count as driving a screen. */
export function isComputerTool(toolName?: string, scope?: string): boolean {
  if (scope === 'local-computer') return true;
  if (!toolName) return false;
  if (/(?:^|__)(screenshot|click|move|scroll|type_text|key|open_target)$/i.test(toolName)) return true;
  return /computer|cua|screenshot|left_click|right_click|middle_click|double_click|mouse|hotkey|keypress|keyboard|type_text|scroll|screen|desktop/i.test(
    toolName,
  );
}

/** The in-repo desktop driver. Packaged builds copy this next to the compiled server. */
export function localDriverScript(): string {
  return fileURLToPath(new URL('./mcp/computer-driver.mjs', import.meta.url));
}

/**
 * Human-in-the-loop hold. Two phase: the panel takes the wheel, and only a trusted
 * release from the same holder gives it back. UI state alone must never assert release.
 */
const holds = new Map<string, { token: string; at: number }>();

export function takeControl(botId: string): string {
  resetActions(botId);
  const token = `${botId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  holds.set(botId, { token, at: Date.now() });
  return token;
}

export function releaseControl(botId: string, token: string): boolean {
  const held = holds.get(botId);
  if (!held || held.token !== token) return false;
  holds.delete(botId);
  return true;
}

export function isHeld(botId: string): boolean {
  return holds.has(botId);
}

/**
 * Build the computer MCP mount for a turn, or nothing when the placement is not
 * actually usable. A mount that cannot work is worse than no mount: the model would
 * plan around hands it does not have.
 */
export function computerMount(bot: BotRecord): { mount?: McpMount; kind: 'computer' | 'localComputer'; reason?: string } {
  // The hold is checked first on purpose: when a person has taken the wheel, that is
  // the reason the bot has no hands, whatever the backend would otherwise say.
  if (isHeld(bot.id)) return { kind: 'computer', reason: 'A person is driving this computer right now' };
  const decision = resolvePlacement(bot);
  if (!decision.available) return { kind: 'computer', reason: decision.reason };

  if (decision.backend === 'host') {
    const script = localDriverScript();
    if (!fs.existsSync(script)) return { kind: 'localComputer', reason: 'The desktop driver is missing from this install.' };
    return {
      kind: 'localComputer',
      mount: {
        transport: 'stdio',
        command: process.execPath,
        args: [script],
        env: { HB_APPROVAL_SCOPE: 'local-computer' },
      },
    };
  }
  if (decision.backend === 'hermes') {
    const server = hostScreenServer();
    const mount = server ? mountFromServer(server) : undefined;
    if (!mount) return { kind: 'computer', reason: 'Hermes screen driver is not mounted' };
    return { kind: 'computer', mount };
  }
  if (!findCli('hb-computer-proxy')) {
    return {
      kind: 'computer',
      reason: 'hb-computer-proxy is not installed, so a cloud desktop or Local VM cannot start. This computer does not need it.',
    };
  }
  return {
    kind: 'computer',
    mount: {
      transport: 'stdio',
      command: 'hb-computer-proxy',
      args: ['--backend', decision.backend ?? 'box', '--bot', bot.id],
    },
  };
}

/** One preview frame of this machine. Opt-in is not required; clicking still is. */
export async function capturePreview(): Promise<{ data: string; mime: string; width: number; height: number }> {
  const script = localDriverScript();
  const { stdout } = await execCli(process.execPath, [script, '--shot'], { timeoutMs: 30_000 });
  const parsed = JSON.parse(stdout.trim() || '{}') as { data?: string; mime?: string; width?: number; height?: number; error?: string };
  if (!parsed.data) throw new Error(parsed.error || 'Could not capture the screen');
  return { data: parsed.data, mime: parsed.mime || 'image/png', width: parsed.width ?? 0, height: parsed.height ?? 0 };
}

export function platformSummary() {
  return {
    platform: process.platform,
    release: os.release(),
    session: desktopSession(),
    hostControl: hostControlStatus(),
    maxActions: MAX_COMPUTER_ACTIONS,
    dockerAvailable: Boolean(findCli('docker') ?? findCli('podman')),
    hostScreenServer: hostScreenServer()?.name ?? null,
    hermes: hostedInHermes(),
  };
}
