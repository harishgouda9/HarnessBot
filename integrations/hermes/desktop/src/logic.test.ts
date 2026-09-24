import { describe, expect, it } from 'vitest';
import type { BotRecord, Message } from '../../../../shared/types.ts';
import { ago, BUSY_POLL_MS, canUseWebview, IDLE_POLL_MS, matches, nextHarnessAction, pollIntervalFor, productUrl, sectionsOf, toneFor, visibleMessages } from './logic.ts';

const bot = (name: string, extra: Partial<BotRecord> = {}): BotRecord =>
  ({ id: name, name, ...extra }) as BotRecord;

const message = (extra: Partial<Message> = {}): Message =>
  ({ id: Math.random().toString(36), role: 'bot', kind: 'text', at: 0, ...extra }) as Message;

describe('toneFor', () => {
  it('maps activity onto the tones Hermes draws', () => {
    expect(toneFor(bot('a', { activity: 'working' }))).toBe('positive');
    expect(toneFor(bot('a', { activity: 'waiting-on-you' }))).toBe('caution');
    expect(toneFor(bot('a', { activity: 'no-signal' }))).toBe('critical');
    expect(toneFor(bot('a', { activity: 'dead' }))).toBe('critical');
    expect(toneFor(bot('a', { activity: 'idle' }))).toBe('neutral');
  });

  it('is neutral for a bot that has never reported', () => {
    expect(toneFor(bot('a'))).toBe('neutral');
  });
});

describe('sectionsOf', () => {
  it('groups by section, alphabetically', () => {
    const sections = sectionsOf([
      bot('zoe', { section: 'Sales' }),
      bot('amy', { section: 'Engineering' }),
      bot('bob', { section: 'Sales' }),
    ]);
    expect(sections.map((s) => s.name)).toEqual(['Engineering', 'Sales']);
    expect(sections[1]!.bots.map((b) => b.name)).toEqual(['zoe', 'bob']);
  });

  it('puts unsectioned bots last, under one heading', () => {
    const sections = sectionsOf([bot('loose'), bot('amy', { section: 'Engineering' })]);
    expect(sections.map((s) => s.name)).toEqual(['Engineering', 'Unsectioned']);
  });

  it('treats whitespace as no section at all', () => {
    expect(sectionsOf([bot('a', { section: '   ' })]).map((s) => s.name)).toEqual(['Unsectioned']);
  });

  it('omits the unsectioned heading when everything is filed', () => {
    expect(sectionsOf([bot('a', { section: 'Ops' })]).map((s) => s.name)).toEqual(['Ops']);
  });

  it('is empty for an empty roster', () => {
    expect(sectionsOf([])).toEqual([]);
  });
});

describe('matches', () => {
  const research = bot('Research', { title: 'Deep digger', section: 'Ops' });

  it('matches everything on an empty query', () => {
    expect(matches(research, '')).toBe(true);
    expect(matches(research, '   ')).toBe(true);
  });

  it('searches name, title and section, case-insensitively', () => {
    expect(matches(research, 'rese')).toBe(true);
    expect(matches(research, 'DIGGER')).toBe(true);
    expect(matches(research, 'ops')).toBe(true);
    expect(matches(research, 'finance')).toBe(false);
  });

  it('does not fall over on a bot with no title or section', () => {
    expect(matches(bot('plain'), 'plain')).toBe(true);
    expect(matches(bot('plain'), 'nope')).toBe(false);
  });
});

describe('visibleMessages', () => {
  it('keeps text, cards and tool lines', () => {
    const kept = visibleMessages([
      message({ text: 'hello' }),
      message({ card: { title: 'Allow?', options: [] } }),
      message({ tool: { name: 'bash' } }),
    ]);
    expect(kept).toHaveLength(3);
  });

  it('drops queued echoes and empty rows', () => {
    const kept = visibleMessages([
      message({ text: 'queued', queued: true }),
      message({}),
      message({ text: 'real' }),
    ]);
    expect(kept.map((m) => m.text)).toEqual(['real']);
  });
});

describe('pollIntervalFor', () => {
  it('follows the bot: fast while it works, slow while it does not', () => {
    expect(pollIntervalFor(bot('a', { activity: 'working' }))).toBe(BUSY_POLL_MS);
    expect(pollIntervalFor(bot('a', { activity: 'waiting-on-you' }))).toBe(BUSY_POLL_MS);
    expect(pollIntervalFor(bot('a', { activity: 'idle' }))).toBe(IDLE_POLL_MS);
  });

  it('is slow for no bot at all, rather than hammering nothing', () => {
    expect(pollIntervalFor(undefined)).toBe(IDLE_POLL_MS);
  });
});

describe('ago', () => {
  it('does not throw on a unix-ms timestamp — that is the ageNow crash', () => {
    expect(() => ago(Date.now() - 1_000)).not.toThrow();
    expect(ago(Date.now() - 1_000)).toBe('just now');
    expect(ago(Date.now() - 120_000)).toBe('2m');
  });

  it('is empty for missing or zero timestamps rather than "55 years ago"', () => {
    expect(ago(undefined)).toBe('');
    expect(ago(null)).toBe('');
    expect(ago(0)).toBe('');
  });
});

describe('nextHarnessAction', () => {
  it('asks for a build when the standalone UI is missing', () => {
    expect(nextHarnessAction({ running: false, static_ui_built: false })).toBe('build');
    expect(nextHarnessAction({ running: true, static_ui_built: false, health: { static: true } })).toBe('build');
  });

  it('starts a harness that is not up', () => {
    expect(nextHarnessAction({ running: false, static_ui_built: true })).toBe('start');
  });

  it('restarts an API-only process so HB_STATIC_DIR takes effect', () => {
    expect(nextHarnessAction({ running: true, static_ui_built: true, health: { static: false } })).toBe('restart');
    expect(nextHarnessAction({ running: true, static_ui_built: true, health: null })).toBe('restart');
  });

  it('is ready when the harness is serving the UI', () => {
    expect(nextHarnessAction({ running: true, static_ui_built: true, health: { static: true } })).toBe('ready');
  });

  it('does not demand static_ui_built from an older supervisor payload', () => {
    expect(nextHarnessAction({ running: false })).toBe('start');
    expect(nextHarnessAction({ running: true, health: { static: true } })).toBe('ready');
  });
});

describe('productUrl', () => {
  it('returns null for missing urls', () => {
    expect(productUrl(null)).toBeNull();
    expect(productUrl(undefined)).toBeNull();
    expect(productUrl('')).toBeNull();
  });

  it('adds a trailing slash so SPA assets resolve', () => {
    expect(productUrl('http://127.0.0.1:8799')).toBe('http://127.0.0.1:8799/');
    expect(productUrl('http://127.0.0.1:8799/')).toBe('http://127.0.0.1:8799/');
  });
});

describe('canUseWebview', () => {
  it('is false when the tag comes back as HTMLUnknownElement', () => {
    class HTMLUnknownElement {}
    (globalThis as { HTMLUnknownElement?: unknown }).HTMLUnknownElement = HTMLUnknownElement;
    expect(canUseWebview(() => ({ constructor: HTMLUnknownElement, tagName: 'WEBVIEW' }))).toBe(false);
  });

  it('is true for a real webview custom element', () => {
    class WebView {}
    (globalThis as { HTMLUnknownElement?: unknown }).HTMLUnknownElement = class HTMLUnknownElement {};
    expect(canUseWebview(() => ({ constructor: WebView, tagName: 'WEBVIEW' }))).toBe(true);
  });
});
