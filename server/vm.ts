import { createHash } from 'node:crypto';
import { getConfig } from './config.ts';
import { execCli, findCli, spawnCli } from './drivers/spawn.ts';
import { dataPath, ensureDir } from './paths.ts';

/**
 * Local VM computers: an isolated containerised desktop over Docker or Podman.
 *
 * Two properties matter more than features here. First, workspaces mount durably —
 * a container is disposable but the work inside it is not. Second, every call is
 * argv-only through spawn.ts, because container names and image tags reach this code
 * from configuration the model can influence.
 */

const IMAGE = process.env.HB_VM_IMAGE ?? 'ghcr.io/harnessbot/desktop:0.1.44';
const LABEL = 'harnessbot.vm';
const IDLE_MS = 20 * 60 * 1000;

/**
 * 1024x768 on purpose. A frame at this size costs roughly 1,600 input tokens; 1080p
 * and 4K cost two to four times that and read no better, because the model is doing
 * OCR on the same glyphs either way. Overridable, because an image with a different
 * default panel layout may genuinely need a different canvas.
 */
const WIDTH = Number(process.env.HB_VM_WIDTH ?? 1024);
const HEIGHT = Number(process.env.HB_VM_HEIGHT ?? 768);

/**
 * The container's noVNC port, published on an ephemeral loopback port rather than a
 * fixed one: per-bot mode runs several desktops at once and a fixed port collides on
 * the second container.
 */
const NOVNC_PORT = 6080;

export type Runtime = 'docker' | 'podman';

export function runtimeBin(): { name: Runtime; path: string } | null {
  const docker = findCli('docker');
  if (docker) return { name: 'docker', path: docker };
  const podman = findCli('podman');
  if (podman) return { name: 'podman', path: podman };
  return null;
}

/** Container name for a bot, honouring shared vs per-bot mode. */
export function containerFor(botId: string): string {
  const { mode } = getConfig().localVm;
  return mode === 'per-bot' ? `harnessbot-vm-${sha16(botId)}` : 'harnessbot-vm-shared';
}

/** Durable mount for a container. Shared mode keeps one home; per-bot keeps its own. */
export function workspaceFor(botId: string): string {
  const { mode } = getConfig().localVm;
  return mode === 'per-bot' ? ensureDir(dataPath('vm-homes', sha16(botId))) : ensureDir(dataPath('vm-home'));
}

const sha16 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

export interface VmState {
  runtime: Runtime | null;
  available: boolean;
  reason?: string;
  image: string;
  mode: 'shared' | 'per-bot';
  maxInstances: number;
  containers: { name: string; status: string; running: boolean; image: string; botId?: string; viewerUrl?: string }[];
  width: number;
  height: number;
}

/**
 * Pull the loopback noVNC address out of a `docker ps` ports column, which looks like
 * `127.0.0.1:49154->6080/tcp, 5900/tcp`. Anything not bound to loopback is ignored:
 * a desktop reachable from the network is not a desktop we are willing to link to.
 */
export function viewerFrom(ports: string): string | undefined {
  const match = new RegExp(String.raw`127\.0\.0\.1:(\d+)->${NOVNC_PORT}/tcp`).exec(ports);
  return match ? `http://127.0.0.1:${match[1]}/vnc.html?autoconnect=1&resize=scale` : undefined;
}

async function run(args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string }> {
  const bin = runtimeBin();
  if (!bin) throw new Error('Install Docker or Podman to use a Local VM');
  return execCli(bin.path, args, { env: process.env, timeoutMs });
}

export async function vmState(): Promise<VmState> {
  const bin = runtimeBin();
  const { mode, maxInstances } = getConfig().localVm;
  const base: VmState = {
    runtime: bin?.name ?? null,
    available: false,
    image: IMAGE,
    mode,
    maxInstances,
    containers: [],
    width: WIDTH,
    height: HEIGHT,
  };
  if (!bin) return { ...base, reason: 'Install Docker or Podman to use a Local VM' };

  try {
    // Labels and ports come back in the same listing. Without the label the `botId`
    // field on every container stayed undefined, so the UI fell back to matching by
    // name — which in per-bot mode matched the first container for every bot.
    const { stdout } = await run([
      'ps',
      '-a',
      '--filter',
      `label=${LABEL}`,
      '--format',
      '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Labels}}\t{{.Ports}}',
    ]);
    const containers = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', status = '', image = '', labels = '', ports = ''] = line.split('\t');
        return {
          name,
          status,
          image,
          running: /^Up\b/i.test(status),
          botId: /(?:^|,)harnessbot\.vm\.bot=([^,]+)/.exec(labels)?.[1],
          viewerUrl: viewerFrom(ports),
        };
      });
    return { ...base, available: true, containers };
  } catch (err) {
    // The binary exists but the daemon is not reachable — say which, it is a different fix.
    return { ...base, reason: `${bin.name} is installed but not responding: ${message(err)}` };
  }
}

export async function pullImage(): Promise<{ ok: boolean; output: string }> {
  const bin = runtimeBin();
  if (!bin) return { ok: false, output: 'Install Docker or Podman to use a Local VM' };
  try {
    // Pulls are slow and worth their own generous budget.
    const { stdout, stderr } = await run(['pull', IMAGE], 10 * 60_000);
    return { ok: true, output: (stdout || stderr).slice(-4000) };
  } catch (err) {
    return { ok: false, output: message(err) };
  }
}

export async function startVm(botId: string): Promise<{ ok: boolean; container?: string; reason?: string }> {
  const state = await vmState();
  if (!state.available) return { ok: false, reason: state.reason };

  const name = containerFor(botId);
  const existing = state.containers.find((c) => c.name === name);
  if (existing?.running) return { ok: true, container: name };

  if (existing) {
    try {
      await run(['start', name]);
      return { ok: true, container: name };
    } catch (err) {
      return { ok: false, reason: message(err) };
    }
  }

  const running = state.containers.filter((c) => c.running).length;
  if (running >= state.maxInstances) {
    return { ok: false, reason: `At most ${state.maxInstances} Local VMs at once. Stop one first.` };
  }

  try {
    await run([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${LABEL}=1`,
      '--label',
      `${LABEL}.bot=${botId}`,
      // The workspace mount is the durable part; the container itself is not. Only
      // this directory is mounted: never the home directory, never a project folder.
      '-v',
      `${workspaceFor(botId)}:/home/harness/workspace`,
      // Fix the canvas so every frame costs the same, predictable number of tokens.
      '-e',
      `WIDTH=${WIDTH}`,
      '-e',
      `HEIGHT=${HEIGHT}`,
      // Ephemeral loopback port for the noVNC viewer. Loopback because the trust
      // boundary here is the OS user account, the same as the harness API's.
      '-p',
      `127.0.0.1:0:${NOVNC_PORT}`,
      '--shm-size',
      '1g',
      IMAGE,
    ]);
    return { ok: true, container: name };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

export async function stopVm(botId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await run(['stop', containerFor(botId)]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

export async function removeVm(botId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await run(['rm', '-f', containerFor(botId)]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

/** A PNG frame of the container's desktop, base64. Preview only — never control. */
export async function screenshotVm(botId: string): Promise<{ ok: boolean; png?: string; reason?: string }> {
  const bin = runtimeBin();
  if (!bin) return { ok: false, reason: 'Install Docker or Podman to use a Local VM' };
  const name = containerFor(botId);
  return new Promise((resolve) => {
    const child = spawnCli(bin.path, ['exec', name, 'scrot', '-o', '/dev/stdout'], { env: process.env });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        resolve({ ok: false, reason: stderr.trim().slice(0, 200) || `screenshot failed (${code})` });
        return;
      }
      resolve({ ok: true, png: Buffer.concat(chunks).toString('base64') });
    });
  });
}

/**
 * Idle leases. A desktop container costs real memory, so one that nobody has touched
 * for a while gets stopped — not removed, because the workspace mount and any
 * installed state inside are worth keeping.
 */
const lastTouched = new Map<string, number>();

export function touchVm(botId: string): void {
  lastTouched.set(containerFor(botId), Date.now());
}

export function startIdleReaper(intervalMs = 5 * 60_000): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const state = await vmState();
      if (!state.available) return;
      const now = Date.now();
      for (const container of state.containers) {
        if (!container.running) continue;
        const touched = lastTouched.get(container.name) ?? 0;
        if (now - touched < IDLE_MS) continue;
        try {
          await run(['stop', container.name]);
          lastTouched.delete(container.name);
        } catch {
          // A container that will not stop is not worth crashing the reaper over.
        }
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

const message = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Command failed:.*?\n/, '').trim().slice(0, 300);
};

// ---------------------------------------------------------------------------
// Browser workspace
// ---------------------------------------------------------------------------

/**
 * The browser lives in the desktop shell (one Electron WebContentsView per
 * bot/profile), not in the harness. The harness holds the state the UI needs and
 * fails closed with a real reason when there is no desktop attached, rather than
 * pretending a tab exists.
 */

export interface BrowserTab {
  botId: string;
  profileId: string;
  url: string;
  title: string;
  loading: boolean;
  updatedAt: number;
}

const tabs = new Map<string, BrowserTab>();

export const browserAvailable = (): boolean => process.env.HB_DESKTOP_PARENT === '1';

export function browserState(botId: string, profileId: string): { available: boolean; reason?: string; tab?: BrowserTab } {
  const tab = tabs.get(`${botId}:${profileId}`);
  if (!browserAvailable()) {
    return {
      available: false,
      reason: 'The built-in browser runs in the HarnessBot desktop app. Open the desktop app to use it.',
      tab,
    };
  }
  return { available: true, tab };
}

/** The desktop shell reports tab state back through here. */
export function setBrowserTab(tab: Omit<BrowserTab, 'updatedAt'>): BrowserTab {
  const next = { ...tab, updatedAt: Date.now() };
  tabs.set(`${tab.botId}:${tab.profileId}`, next);
  return next;
}

export function clearBrowserTab(botId: string, profileId: string): void {
  tabs.delete(`${botId}:${profileId}`);
}
