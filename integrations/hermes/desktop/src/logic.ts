import type { BotRecord, Message } from '../../../../shared/types.ts';

/**
 * The decisions the native views make, kept clear of the SDK.
 *
 * The components import `@hermes/plugin-sdk`, which only exists inside the Hermes
 * renderer as an injected shim — so anything that lives beside a component import
 * cannot be tested outside the app. Grouping, filtering and poll pacing are real
 * logic with real edge cases, so they live here where a test can reach them.
 */

export type DotTone = 'positive' | 'caution' | 'critical' | 'neutral';

/** HarnessBot's activity vocabulary, mapped onto the dot tones Hermes already has. */
export function toneFor(bot: Pick<BotRecord, 'activity'>): DotTone {
  switch (bot.activity) {
    case 'working':
      return 'positive';
    case 'waiting-on-you':
      return 'caution';
    case 'no-signal':
    case 'dead':
      return 'critical';
    default:
      return 'neutral';
  }
}

export const ACTIVITY_LABEL: Record<string, string> = {
  working: 'Working',
  'waiting-on-you': 'Waiting on you',
  'no-signal': 'No signal',
  dead: 'Unavailable',
  idle: 'Idle',
};

export interface RosterSection {
  name: string;
  bots: BotRecord[];
}

/** Group by HarnessBot's own sections, keeping unsectioned bots last. */
export function sectionsOf(bots: BotRecord[]): RosterSection[] {
  const bySection = new Map<string, BotRecord[]>();
  for (const bot of bots) {
    const key = bot.section?.trim() || '';
    const list = bySection.get(key);
    if (list) list.push(bot);
    else bySection.set(key, [bot]);
  }

  const named = [...bySection.entries()]
    .filter(([name]) => name)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => ({ name, bots: list }));

  const loose = bySection.get('') ?? [];
  return loose.length ? [...named, { name: 'Unsectioned', bots: loose }] : named;
}

export function matches(bot: BotRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [bot.name, bot.title, bot.section].some((field) => (field ?? '').toLowerCase().includes(q));
}

/** Messages worth drawing. A queued echo is not yet a turn. */
export function visibleMessages(messages: Message[]): Message[] {
  return messages.filter((m) => !m.queued && Boolean(m.text || m.card || m.tool));
}

export const BUSY_POLL_MS = 1500;
export const IDLE_POLL_MS = 12_000;

/**
 * How often to re-read a conversation.
 *
 * Freshness is polled rather than streamed on purpose: Hermes' auth gate is HTTP
 * middleware and does not run for WebSocket routes, so a socket into a harness
 * that has no auth of its own would be an unauthenticated door. Following the bot
 * instead keeps the cost where the activity is.
 */
export function pollIntervalFor(bot: Pick<BotRecord, 'activity'> | undefined): number {
  const busy = bot?.activity === 'working' || bot?.activity === 'waiting-on-you';
  return busy ? BUSY_POLL_MS : IDLE_POLL_MS;
}

/**
 * Relative time that does not depend on Hermes' `formatAgo`.
 *
 * Hermes' helper expects its own timestamp object (it reads `.ageNow`) and
 * throws `"Cannot read properties of undefined (reading 'ageNow')"` when handed
 * HarnessBot's unix-ms `message.at`. Keep this next to the rest of the
 * SDK-free logic so a test can pin the contract.
 */
export function ago(at: number | string | Date | null | undefined): string {
  if (at == null || at === '' || at === 0) return '';
  const then = typeof at === 'number' ? at : new Date(at).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1m';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export type HarnessLifecycle = {
  running: boolean;
  static_ui_built?: boolean;
  health?: { static?: boolean } | null;
};

/**
 * What the desktop page should do before it dares point an iframe at the harness.
 *
 * `static_ui_built === false` is a missing build (actionable). An already-running
 * harness with `health.static !== true` is the API-only process the plugin used
 * to spawn — restart it so `HB_STATIC_DIR` takes effect. Missing `static_ui_built`
 * (an older supervisor) is treated as "assume the files are there".
 */
export function nextHarnessAction(status: HarnessLifecycle): 'build' | 'start' | 'restart' | 'ready' {
  if (status.static_ui_built === false) return 'build';
  if (!status.running) return 'start';
  if (!status.health?.static) return 'restart';
  return 'ready';
}

/** Harness origin as a directory URL so `/assets/…` resolve. */
export function productUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Electron registers `<webview>` when `webviewTag` is on. Hermes Desktop has
 * that flag (it is how the built-in browser pane loads localhost). An iframe
 * from `app://hermes` to `http://127.0.0.1` is the thing Chromium sometimes
 * refuses; the webview is a guest process and does not care.
 */
export function canUseWebview(create: (tag: string) => { constructor: unknown; tagName: string } | null): boolean {
  const el = create('webview');
  if (!el) return false;
  return el.tagName.toLowerCase() === 'webview' && el.constructor !== (globalThis as { HTMLUnknownElement?: unknown }).HTMLUnknownElement;
}
