import { request as httpRequest } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, server, resolveStaticDir } from './index.ts';
import { findAppSource } from './paths.ts';
import { VERSION } from './version.ts';
import { saveConfig } from './config.ts';
import { registry } from './harness/registry.ts';

/**
 * API smoke against a real server on a throwaway home. Not a mock: the invariants
 * being checked here (no secret echo, webhook isolation, Host refusal) are properties
 * of the actual HTTP surface, and a mock would happily pass while the real one leaks.
 */

const PORT = Number(process.env.HB_PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_BASE = `http://127.0.0.1:${PORT + 1}`;

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testing', 'fake-cli.mjs');

async function call(method: string, endpoint: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

/** Wait on an SSE event instead of sleeping and hoping. */
function waitForEvent(kind: string, match: (data: any) => boolean, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);

    void (async () => {
      const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
          else if (line.startsWith('data: ') && currentEvent === kind) {
            const data = JSON.parse(line.slice(6));
            if (match(data)) {
              clearTimeout(timer);
              controller.abort();
              resolve(data);
              return;
            }
          }
        }
      }
    })().catch(() => {
      /* aborted on success */
    });
  });
}

type SseFrame = { id: string; event: string; data: string };

/** Read SSE frames until `until` says the assertion has what it needs. No sleeps. */
function collectFrames(endpoint: string, until: (frames: SseFrame[]) => boolean, timeoutMs = 8_000): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out reading ${endpoint}`));
    }, timeoutMs);
    const frames: SseFrame[] = [];

    const finish = (): void => {
      clearTimeout(timer);
      controller.abort();
      resolve(frames);
    };

    void (async () => {
      const res = await fetch(`${BASE}${endpoint}`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let id = '';
      let event = '';
      let data: string[] = [];
      const push = (): void => {
        if (!event && data.length === 0) {
          id = '';
          return;
        }
        frames.push({ id, event: event || 'message', data: data.join('\n') });
        id = '';
        event = '';
        data = [];
        if (until(frames)) finish();
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line === '') push();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
      }
      if (!controller.signal.aborted) {
        clearTimeout(timer);
        reject(new Error(`stream ended before ${endpoint} matched`));
      }
    })().catch((err) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function botFrame(frames: SseFrame[], id: string): SseFrame | undefined {
  return frames.find((frame) => {
    if (frame.event !== 'bot') return false;
    try {
      return (JSON.parse(frame.data) as { id?: string }).id === id;
    } catch {
      return false;
    }
  });
}

beforeAll(async () => {
  saveConfig({
    instances: { testcli: { driver: 'claude', displayName: 'Test CLI', config: { command: FAKE_CLI } } },
  });
  await start(PORT);
}, 30_000);

afterAll(async () => {
  await registry.disposeAll();
  server.close();
});

describe('health and identity', () => {
  it('identifies itself so a probe can tell us from a stranger on the port', async () => {
    const { body } = await call('GET', '/api/health');
    expect(body.app).toBe('harnessbot');
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    expect(body.version).toBe(pkg.version);
    expect(body.version).toBe(VERSION);
    expect(body.static).toBe(false);
  });

  it('does not pretend GET / is a UI when no static dir is configured', async () => {
    const res = await fetch(`${BASE}/`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(text).toContain('HarnessBot is running');
    expect(text).not.toContain('id="root"');
    expect(text).not.toContain('/assets/');
    expect(text.trimStart().startsWith('{')).toBe(false);
  });

  it('still 404s unknown API paths as JSON', async () => {
    const { status, body } = await call('GET', '/api/this-route-does-not-exist');
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
  });
});

describe('event resume', () => {
  it('numbers frames, replays only newer ones, and resyncs a foreign boot', async () => {
    const { body: first } = await call('POST', '/api/bots', { name: 'SeqOne' });
    const { body: second } = await call('POST', '/api/bots', { name: 'SeqTwo' });

    const opened = await collectFrames('/api/events', (frames) => Boolean(botFrame(frames, second.id)));
    const hello = opened.find((frame) => frame.event === 'hello');
    const boot = (JSON.parse(hello?.data ?? '{}') as { serverBootId?: string }).serverBootId;
    const firstFrame = botFrame(opened, first.id);
    const secondFrame = botFrame(opened, second.id);
    expect(boot).toEqual(expect.any(String));
    expect(Number(firstFrame?.id)).toBeGreaterThan(0);
    expect(Number(secondFrame?.id)).toBeGreaterThan(Number(firstFrame?.id));

    const resumed = await collectFrames(
      `/api/events?since=${firstFrame!.id}&boot=${encodeURIComponent(boot!)}`,
      (frames) => Boolean(botFrame(frames, second.id)),
    );
    expect(botFrame(resumed, first.id)).toBeUndefined();
    expect(botFrame(resumed, second.id)?.id).toBe(secondFrame?.id);

    const foreign = await collectFrames(
      `/api/events?since=${firstFrame!.id}&boot=not-this-process`,
      (frames) => frames.some((frame) => frame.event === 'resync'),
    );
    expect(foreign.some((frame) => frame.event === 'bot')).toBe(false);
    expect((JSON.parse(foreign.find((frame) => frame.event === 'resync')!.data) as { serverBootId: string }).serverBootId).toBe(boot);

    const gapped = await collectFrames(
      `/api/events?since=-1&boot=${encodeURIComponent(boot!)}`,
      (frames) => frames.some((frame) => frame.event === 'resync'),
    );
    expect(gapped.some((frame) => frame.event === 'bot')).toBe(false);
  });
});

describe('resolveStaticDir', () => {
  const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.tmp-static-dir');

  const writeIndex = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"></div>');
  };

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('honours an explicit env, including empty (API-only)', () => {
    expect(resolveStaticDir({ env: '/given/ui', cwd: tmp, here: tmp })).toBe('/given/ui');
    expect(resolveStaticDir({ env: '', cwd: tmp, here: tmp })).toBe('');
  });

  it('discovers a sibling ui/ when env is unset — the Hermes plugin layout', () => {
    const here = path.join(tmp, 'plugin', 'server');
    const ui = path.join(tmp, 'plugin', 'ui');
    writeIndex(ui);
    expect(resolveStaticDir({ env: undefined, cwd: path.join(tmp, 'empty-cwd'), here })).toBe(ui);
  });

  it('discovers ../dist from the source server/ directory', () => {
    const here = path.join(tmp, 'checkout', 'server');
    const dist = path.join(tmp, 'checkout', 'dist');
    writeIndex(dist);
    expect(resolveStaticDir({ env: undefined, cwd: path.join(tmp, 'empty-cwd'), here })).toBe(dist);
  });

  it('discovers ../../dist from dist-server/server', () => {
    const here = path.join(tmp, 'checkout', 'dist-server', 'server');
    const dist = path.join(tmp, 'checkout', 'dist');
    writeIndex(dist);
    expect(resolveStaticDir({ env: undefined, cwd: path.join(tmp, 'empty-cwd'), here })).toBe(dist);
  });

  it('falls back to cwd/dist so `pnpm dev:server` from the checkout serves the UI', () => {
    const cwd = path.join(tmp, 'from-cwd');
    writeIndex(path.join(cwd, 'dist'));
    expect(resolveStaticDir({ env: undefined, cwd, here: path.join(tmp, 'nowhere', 'server') })).toBe(
      path.join(cwd, 'dist'),
    );
  });
});

describe('secrets', () => {
  it('accepts a key and never returns it', async () => {
    const secret = 'xai-thisisatestsecretvalue123456';
    await call('PATCH', '/api/config', { secrets: { 'xai.key': secret } });

    const { raw, body } = await call('GET', '/api/config');
    // The whole response body, not just a field: nothing may carry the value.
    expect(raw).not.toContain(secret);
    expect(body.secrets).toBeUndefined();
    expect(body.configured['xai.key']).toBe(true);
  });

  it('refuses a secret name that is not on the allowlist', async () => {
    const { status } = await call('PATCH', '/api/config', { secrets: { 'not.a.real.key': 'x' } });
    expect(status).toBe(400);
  });
});

describe('bots and turns', () => {
  it('runs a full turn: send, stream, settle, persist', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Smoke',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });
    expect(bot.id).toBeTruthy();

    const settled = waitForEvent('message', (d) => d.threadId === bot.threadId && d.message.role === 'bot' && d.message.kind === 'text');
    await call('POST', `/api/bots/${bot.id}/messages`, { text: 'reply with the word ping', sendId: 'smoke-1' });
    const event = await settled;
    expect(event.message.text).toContain('pong');

    const { body: thread } = await call('GET', `/api/threads/${bot.threadId}/messages`);
    const roles = thread.messages.map((m: any) => `${m.role}/${m.kind}`);
    expect(roles).toContain('user/text');
    expect(roles).toContain('bot/text');
  });

  it('an edit shows the new text once', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Editor',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });
    const settled = waitForEvent('message', (d) => d.threadId === bot.threadId && d.message.role === 'bot' && d.message.kind === 'text');
    await call('POST', `/api/bots/${bot.id}/messages`, { text: 'original line', sendId: 'edit-1' });
    await settled;

    const { body: before } = await call('GET', `/api/threads/${bot.threadId}/messages`);
    const original = before.messages.find((m: { role: string }) => m.role === 'user');
    const { status } = await call('POST', `/api/bots/${bot.id}/messages/${original.id}/edit`, {
      text: 'edited line',
      threadId: bot.threadId,
    });
    expect(status).toBe(200);

    const { body: after } = await call('GET', `/api/threads/${bot.threadId}/messages`);
    const users = after.messages.filter((m: { role: string; kind: string }) => m.role === 'user' && m.kind === 'text');
    expect(users.map((m: { text: string }) => m.text)).toEqual(['edited line']);
  });

  it('is idempotent on a repeated sendId', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Idempotent',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });
    const settled = waitForEvent('message', (d) => d.threadId === bot.threadId && d.message.role === 'bot');
    await call('POST', `/api/bots/${bot.id}/messages`, { text: 'hello', sendId: 'dupe' });
    await settled;
    await call('POST', `/api/bots/${bot.id}/messages`, { text: 'hello', sendId: 'dupe' });

    const { body: thread } = await call('GET', `/api/threads/${bot.threadId}/messages`);
    expect(thread.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  });

  it('never exposes resume cursors to the client', async () => {
    const { raw } = await call('GET', '/api/bots');
    expect(raw).not.toContain('resumeCursors');
  });

  it('refuses a PATCH field that is not on the allowlist', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Guarded',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });
    // alwaysAllow is a grant. It is set by answering a card, never by a PATCH.
    const { body: patched } = await call('PATCH', `/api/bots/${bot.id}`, { alwaysAllow: ['Bash:rm'], name: 'Renamed' });
    expect(patched.name).toBe('Renamed');
    expect(patched.alwaysAllow ?? []).not.toContain('Bash:rm');
  });

  it('reports an unavailable engine as a setup problem instead of hanging', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Broken',
      modelSelection: { instanceId: 'does-not-exist', model: 'nope' },
    });
    await call('POST', `/api/bots/${bot.id}/messages`, { text: 'hi' });
    const { body: thread } = await call('GET', `/api/threads/${bot.threadId}/messages`);
    const last = thread.messages.at(-1);
    expect(last.role).toBe('bot');
    expect(last.tool?.setup).toBe(true);
  });
});

describe('network boundaries', () => {
  // fetch() refuses to send a custom Host header, so this goes through node:http,
  // which is also closer to what a DNS-rebinding attack would actually look like.
  const requestWithHost = (host: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/bots', method: 'GET', headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  it('refuses a non-loopback Host header', async () => {
    await expect(requestWithHost('evil.example.com')).resolves.toBe(403);
  });

  it('accepts localhost as loopback', async () => {
    await expect(requestWithHost(`localhost:${PORT}`)).resolves.toBe(200);
  });

  it('the webhook receiver exposes health and hooks, and nothing else', async () => {
    const health = await fetch(`${WEBHOOK_BASE}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { app: string }).app).toBe('harnessbot-webhooks');

    // The whole point of the separate port: the API is not reachable from it.
    for (const endpoint of ['/api/bots', '/api/config', '/api/events', '/api/health']) {
      expect((await fetch(`${WEBHOOK_BASE}${endpoint}`)).status).toBe(404);
    }
  });

  it('rejects an unknown webhook secret without saying why', async () => {
    const res = await fetch(`${WEBHOOK_BASE}/hooks/wh_not_a_real_secret`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('a malformed path does not take down the process', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: PORT, path: '/api/bots/%ZZ', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
    const health = await call('GET', '/api/health');
    expect(health.body.app).toBe('harnessbot');
  });

  it('a malformed webhook secret does not take down the harness', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: PORT + 1, path: '/hooks/%ZZ', method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    const health = await call('GET', '/api/health');
    expect(health.body.app).toBe('harnessbot');
  });
});

describe('webhook secrets', () => {
  it('shows the secret exactly once and stores only a hash', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Hooked',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });
    const { body: routine } = await call('POST', '/api/routines', {
      name: 'Hook target',
      prompt: 'do the thing',
      botId: bot.id,
      enabled: false,
      schedule: { kind: 'once', at: Date.now() + 86_400_000 },
    });

    const { body: created } = await call('POST', '/api/webhooks', { name: 'CI', routineId: routine.id });
    expect(created.secret).toMatch(/^wh_/);
    expect(created.secretHash).toBeUndefined();

    // Listing it again must not reveal the secret or its hash.
    const { raw, body: listed } = await call('GET', '/api/webhooks');
    expect(raw).not.toContain(created.secret);
    expect(raw).not.toContain('secretHash');
    // A hook that has never fired says so, rather than looking the same as a live one.
    expect(listed[0].lastDeliveryAt).toBeUndefined();

    // Rotating hands back a usable URL, and invalidates the old secret.
    const { body: rotated } = await call('POST', `/api/webhooks/${created.id}/rotate`);
    expect(rotated.secret).toMatch(/^wh_/);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.url).toContain(rotated.secret);

    const stale = await fetch(`${WEBHOOK_BASE}/hooks/${created.secret}`, { method: 'POST', body: '{}' });
    expect(stale.status).toBe(404);
  });
});

describe('editing the app', () => {
  it('finds a checkout by its package name and ignores anything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-src-'));
    expect(findAppSource([dir])).toBeNull();
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'index.ts'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'harnessbot' }));
    expect(findAppSource([path.join(dir, 'server')])).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('points a Claude, Grok, or Hermes bot at the checkout and refuses anyone else', async () => {
    const source = await call('GET', '/api/app-source');
    expect(source.body.available).toBe(true);

    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Editor',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });
    const on = await call('POST', `/api/bots/${bot.id}/work-on-app`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.path).toBe(source.body.path);

    const { body: listed } = await call('GET', '/api/bots');
    const edited = listed.find((item: { id: string; cwd?: string; tasks: { cwd?: string }[] }) => item.id === bot.id);
    expect(edited.cwd).toBe(source.body.path);
    expect(edited.tasks[0].cwd).toBe(source.body.path);

    const stranger = await call('POST', '/api/bots', {
      name: 'Stranger',
      modelSelection: { instanceId: 'nope', model: 'x' },
    });
    const denied = await call('POST', `/api/bots/${stranger.body.id}/work-on-app`, { enabled: true });
    expect(denied.status).toBe(400);

    const off = await call('POST', `/api/bots/${bot.id}/work-on-app`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.path).toBeNull();
  });
});

describe('tasks', () => {
  it('renames a task without creating one, and refuses an empty title', async () => {
    const { body: bot } = await call('POST', '/api/bots', {
      name: 'Renamer',
      modelSelection: { instanceId: 'testcli', model: 'claude-opus-5' },
    });

    const { body: renamed } = await call('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { title: '  Q3 audit  ' });
    expect(renamed.ok).toBe(true);

    const { body: after } = await call('GET', `/api/bots`);
    const subject = after.find((b: { id: string }) => b.id === bot.id);
    expect(subject.tasks).toHaveLength(1);
    expect(subject.tasks[0].title).toBe('Q3 audit');

    const { status } = await call('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { title: '   ' });
    expect(status).toBe(400);
  });
});

describe('internal routes', () => {
  it('rejects an unauthenticated internal call', async () => {
    const { status } = await call('POST', '/api/internal/list-bots');
    expect(status).toBe(401);
  });

  it('rejects a wrong bearer', async () => {
    const { status } = await call('POST', '/api/internal/list-bots', {}, { authorization: 'Bearer not-a-real-token' });
    expect(status).toBe(401);
  });
});

describe('org chart attach and detach', () => {
  it('clears a manager when the client sends null, and refuses a scope that escapes the data dir', async () => {
    const boss = (await call('POST', '/api/bots', { name: 'Boss' })).body;
    const report = (await call('POST', '/api/bots', { name: 'Report' })).body;

    await call('PATCH', `/api/bots/${report.id}`, { reportsTo: boss.id });
    let graph = (await call('GET', '/api/org-graph')).body;
    expect(graph.nodes.find((n: { id: string }) => n.id === report.id).reportsTo).toBe(boss.id);

    // Detach. `undefined` would vanish in JSON.stringify and the PATCH would be empty.
    await call('PATCH', `/api/bots/${report.id}`, { reportsTo: null });
    graph = (await call('GET', '/api/org-graph')).body;
    expect(graph.nodes.find((n: { id: string }) => n.id === report.id).reportsTo).toBeUndefined();

    // The skill scope becomes a directory name, so it is validated, not trusted.
    expect((await call('GET', '/api/skills?scope=..%2F..%2Fetc')).status).toBe(400);
    expect((await call('GET', `/api/skills?scope=${report.id}`)).status).toBe(200);
  });
});
