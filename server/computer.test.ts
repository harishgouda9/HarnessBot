import { afterEach, describe, expect, it } from 'vitest';
import {
  capturePreview,
  computerMount,
  countAction,
  desktopSession,
  hostControlStatus,
  isComputerTool,
  isHeld,
  MAX_COMPUTER_ACTIONS,
  peekActions,
  releaseControl,
  resetActions,
  resolvePlacement,
  setLocalOptIn,
  takeControl,
} from './computer.ts';
import { buildIntegrations, mentionedBots } from './turns.ts';
import { saveConfig } from './config.ts';
import { store } from './store.ts';
import { NO_CAPABILITIES, type InstanceSnapshot } from './contracts.ts';
import type { BotRecord } from '../shared/types.ts';

/**
 * Hands. Every assertion here is a fail-closed rule: the expensive failure mode is a
 * bot typing on a real keyboard that nobody authorised.
 */

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const makeBot = (name: string, extra: Partial<BotRecord> = {}) =>
  store.createBot({ name, modelSelection: { instanceId: 'fake', model: 'fake-1' }, ...extra });

const snapshot = (capabilities: Partial<InstanceSnapshot['capabilities']>): InstanceSnapshot => ({
  instanceId: 'fake',
  driver: 'fake',
  displayName: 'Fake',
  state: 'available',
  models: [],
  capabilities: { ...NO_CAPABILITIES, ...capabilities },
});

describe('desktop session detection', () => {
  it('detects Wayland from the session type', () => {
    if (process.platform !== 'linux') return; // The check is Linux-only by construction.
    process.env.XDG_SESSION_TYPE = 'wayland';
    expect(desktopSession()).toBe('wayland');
  });
});

describe('host control gating', () => {
  it('always requires an explicit opt-in', () => {
    const bot = makeBot('HostBot');
    expect(hostControlStatus(bot.id).enabled).toBe(false);
    expect(hostControlStatus(bot.id).requiresOptIn).toBe(true);
  });

  it('turns on only after the user opts that bot in', () => {
    const bot = makeBot('OptedIn');
    setLocalOptIn(bot.id, true);
    const status = hostControlStatus(bot.id);
    // On Wayland this stays false no matter what the user clicked.
    expect(status.enabled).toBe(status.session !== 'wayland');
  });

  it('refuses and clears a Wayland opt-in', () => {
    const bot = makeBot('WaylandBot');
    process.env.XDG_SESSION_TYPE = 'wayland';
    process.env.WAYLAND_DISPLAY = 'wayland-0';

    setLocalOptIn(bot.id, true);
    const status = hostControlStatus(bot.id);
    if (status.session === 'wayland') {
      expect(status.supported).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.reason).toMatch(/Wayland/);
      // Placement collapses to off rather than silently falling back to something else.
      expect(resolvePlacement(store.getBot(bot.id)!).placement).toBe('off');
    }
  });

  it('computer = off means off', () => {
    const bot = makeBot('NoHands', { computer: 'off' });
    const decision = resolvePlacement(store.getBot(bot.id)!);
    expect(decision.placement).toBe('off');
    expect(decision.available).toBe(false);
  });

  it('Auto never reaches for the host desktop', () => {
    const bot = makeBot('AutoBot'); // computer unset = Auto
    const decision = resolvePlacement(store.getBot(bot.id)!);
    expect(decision.backend).not.toBe('host');
  });

  it('Auto reuses an enabled Hermes screen driver instead of giving up', () => {
    saveConfig({
      mcpServers: [{ name: 'playwright', enabled: true, transport: 'stdio', command: 'playwright-mcp' }],
    });
    const bot = makeBot('HermesHands');
    const decision = resolvePlacement(store.getBot(bot.id)!);
    expect(decision).toMatchObject({ backend: 'hermes', available: true });
    const { integrations } = buildIntegrations(store.getBot(bot.id)!, snapshot({ computerMcp: true, customMcp: true }), 'please click the desktop');
    expect(integrations.computer).toMatchObject({ transport: 'stdio', command: 'playwright-mcp' });
  });

  it('a cloud placement without a token is unavailable, with the fix in the reason', () => {
    const bot = makeBot('CloudBot', { computer: 'cloud', cloudBackend: 'box' });
    const decision = resolvePlacement(store.getBot(bot.id)!);
    expect(decision.available).toBe(false);
    expect(decision.reason).toMatch(/Settings/);
  });
});

describe('human-in-the-loop hold', () => {
  it('is two phase: only the holder token releases it', () => {
    const bot = makeBot('Held');
    const token = takeControl(bot.id);
    expect(isHeld(bot.id)).toBe(true);

    // UI state alone must never be able to assert a release.
    expect(releaseControl(bot.id, 'guessed-token')).toBe(false);
    expect(isHeld(bot.id)).toBe(true);

    expect(releaseControl(bot.id, token)).toBe(true);
    expect(isHeld(bot.id)).toBe(false);
  });

  it('withholds the computer mount while a person is driving', () => {
    const bot = makeBot('Driving', { computer: 'vm' });
    takeControl(bot.id);
    const { integrations, notes } = buildIntegrations(store.getBot(bot.id)!, snapshot({ computerMcp: true }));
    expect(integrations.computer).toBeUndefined();
    expect(integrations.localComputer).toBeUndefined();
    expect(notes.join(' ')).toMatch(/driving/i);
  });
});

describe('capability gating', () => {
  it('mounts nothing for an engine that declares no capabilities', () => {
    const bot = makeBot('Bare');
    const { integrations } = buildIntegrations(store.getBot(bot.id)!, snapshot({}));
    expect(Object.keys(integrations)).toHaveLength(0);
  });

  it('mounts peer tools only when the driver supports them', () => {
    const bot = makeBot('Peered');
    expect(buildIntegrations(store.getBot(bot.id)!, snapshot({})).integrations.agents).toBeUndefined();
    expect(buildIntegrations(store.getBot(bot.id)!, snapshot({ agentsMcp: true })).integrations.agents).toBeDefined();
  });

  it('respects the per-bot switch even when the driver supports the tool', () => {
    const bot = makeBot('PeerOff', { peerTools: false });
    const { integrations } = buildIntegrations(store.getBot(bot.id)!, snapshot({ agentsMcp: true }));
    expect(integrations.agents).toBeUndefined();
  });

  it('does not mount connected apps without a Composio key', () => {
    const bot = makeBot('NoComposio');
    const { integrations } = buildIntegrations(store.getBot(bot.id)!, snapshot({ composioMcp: true }));
    expect(integrations.composio).toBeUndefined();
  });

  it('lean skips Auto computer when the turn did not ask for a desktop', () => {
    saveConfig({ lean: { enabled: true, preferSmallModel: false } });
    const bot = makeBot('LeanAuto');
    const long = 'Please explain this idea in careful detail, with examples and caveats, so I can teach it. '.repeat(4);
    const { integrations, notes } = buildIntegrations(store.getBot(bot.id)!, snapshot({ computerMcp: true }), long);
    expect(integrations.computer).toBeUndefined();
    expect(integrations.localComputer).toBeUndefined();
    expect(notes.join(' ')).toMatch(/Lean skipped computer/i);
  });

  it('a short question mounts no tools at all, so it does not wait on MCP', () => {
    const bot = makeBot('Quick');
    const { integrations, notes } = buildIntegrations(
      store.getBot(bot.id)!,
      snapshot({ computerMcp: true, agentsMcp: true, browserMcp: true }),
      'hi, what is 2+2?',
    );
    expect(integrations).toEqual({});
    expect(notes).toEqual([]);
  });

  it('lean still offers Auto computer when the turn asks for the desktop', () => {
    saveConfig({ lean: { enabled: true, preferSmallModel: false } });
    const bot = makeBot('LeanHands');
    const { notes } = buildIntegrations(store.getBot(bot.id)!, snapshot({ computerMcp: true }), 'please click the desktop');
    expect(notes.join(' ')).not.toMatch(/Lean skipped computer/i);
  });

  it('mounts the in-repo desktop driver when this computer is opted in', () => {
    const bot = makeBot('LocalDriver', { computer: 'local' });
    setLocalOptIn(bot.id, true);
    const { integrations } = buildIntegrations(store.getBot(bot.id)!, snapshot({ computerMcp: true }), 'please click the desktop');
    if (desktopSession() === 'wayland') {
      expect(integrations.localComputer).toBeUndefined();
      return;
    }
    const mount = integrations.localComputer;
    expect(mount?.transport).toBe('stdio');
    if (!mount || mount.transport !== 'stdio') return;
    expect(mount.command).toBe(process.execPath);
    expect(mount.args.some((arg) => arg.endsWith('computer-driver.mjs'))).toBe(true);
    expect(mount.env?.HB_INTERNAL_TOKEN).toBeTruthy();
    expect(mount.env?.HB_APPROVAL_SCOPE).toBe('local-computer');
    expect(computerMount(store.getBot(bot.id)!).mount).toBeTruthy();
  });

  it('captures a preview without touching the real desktop when dry-run is set', async () => {
    process.env.HB_COMPUTER_DRY = '1';
    const shot = await capturePreview();
    expect(shot.mime).toMatch(/^image\//);
    expect(shot.data.length).toBeGreaterThan(20);
    expect(shot.width).toBeGreaterThan(0);
  });

  it('a bot that pinned Lean off still gets Auto computer', () => {
    saveConfig({ lean: { enabled: true, preferSmallModel: false } });
    const bot = makeBot('LeanOff', { lean: false });
    const { notes } = buildIntegrations(store.getBot(bot.id)!, snapshot({ computerMcp: true }), 'hello there');
    expect(notes.join(' ')).not.toMatch(/Lean skipped computer/i);
  });
});

describe('room mention routing', () => {
  it('matches on word boundaries, longest name first', () => {
    const ana = makeBot('Ana');
    const anabel = makeBot('Anabel');
    const members = [store.getBot(ana.id)!, store.getBot(anabel.id)!];

    // "@Anabel" must not also trigger Ana.
    expect(mentionedBots('@Anabel can you look?', members).map((b) => b.name)).toEqual(['Anabel']);
    expect(mentionedBots('@Ana can you look?', members).map((b) => b.name)).toEqual(['Ana']);
    expect(mentionedBots('no mentions here', members)).toHaveLength(0);
  });

  it('is case insensitive and finds several mentions', () => {
    const a = makeBot('Bo');
    const b = makeBot('Cy');
    const members = [store.getBot(a.id)!, store.getBot(b.id)!];
    expect(mentionedBots('@bo and @CY please', members).map((x) => x.name).sort()).toEqual(['Bo', 'Cy']);
  });
});

describe('computer action ceiling', () => {
  afterEach(() => {
    resetActions('cap-test');
  });

  it('counts until the ceiling and then refuses', () => {
    if (MAX_COMPUTER_ACTIONS === 0) return;
    for (let i = 0; i < MAX_COMPUTER_ACTIONS; i++) {
      expect(countAction('cap-test').allowed).toBe(true);
    }
    expect(countAction('cap-test').allowed).toBe(false);
    expect(peekActions('cap-test').allowed).toBe(false);
  });

  it('treats local-computer scope and screen tools as computer actions', () => {
    expect(isComputerTool('Bash', undefined)).toBe(false);
    expect(isComputerTool('screenshot', undefined)).toBe(true);
    expect(isComputerTool('left_click', undefined)).toBe(true);
    expect(isComputerTool('click', undefined)).toBe(true);
    expect(isComputerTool('localComputer__open_target', undefined)).toBe(true);
    expect(isComputerTool('api_key', undefined)).toBe(false);
    expect(isComputerTool('Bash', 'local-computer')).toBe(true);
  });
});
