import http from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileKey, sanitizeTarget } from './computer-driver.mjs';

const DRIVER = fileURLToPath(new URL('./computer-driver.mjs', import.meta.url));

function listen(handler: (body: { act?: boolean }) => Record<string, unknown>): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? (JSON.parse(raw) as { act?: boolean }) : {};
        if (req.url === '/api/internal/screen') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(handler(body)));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function openDriver(port: number): { child: ChildProcessWithoutNullStreams; rpc: (id: number, method: string, params?: unknown) => Promise<Record<string, unknown>> } {
  const child = spawn(process.execPath, [DRIVER], {
    env: {
      ...process.env,
      HB_COMPUTER_DRY: '1',
      HB_INTERNAL_TOKEN: 'test-token',
      HB_INTERNAL_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  let buffer = '';
  const waiters = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      if (typeof message.id !== 'number') continue;
      const waiter = waiters.get(message.id);
      if (!waiter) continue;
      waiters.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    }
  });
  const rpc = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, rpc };
}

describe('desktop driver guards', () => {
  it('accepts a plain app or https URL and refuses a password or a command', () => {
    expect(sanitizeTarget('https://example.com/login')).toBe('https://example.com/login');
    expect(sanitizeTarget('notepad')).toBe('notepad');
    expect(() => sanitizeTarget('https://user:secret@example.com')).toThrow(/password/);
    expect(() => sanitizeTarget('cmd /c whoami')).toThrow(/simple app name/);
  });

  it('compiles a small key allowlist', () => {
    expect(compileKey('enter')).toBe('{ENTER}');
    expect(compileKey('ctrl+l')).toBe('^l');
    expect(compileKey('alt+tab')).toBe('%{TAB}');
    expect(() => compileKey('ctrl+alt+shift+delete')).toThrow();
  });
});

describe('desktop driver protocol', () => {
  it('lists the tools and refuses to click while a person is driving', async () => {
    const server = await listen(() => ({
      held: true,
      placement: { available: true, backend: 'host' },
      actions: { allowed: true, used: 0 },
      maxActions: 300,
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const { child, rpc } = openDriver(address.port);
    try {
      const listed = await rpc(1, 'initialize', {});
      expect(listed).toMatchObject({ serverInfo: { name: 'harnessbot-computer' } });
      const tools = await rpc(2, 'tools/list', {});
      const names = (tools.tools as { name: string }[]).map((tool) => tool.name);
      expect(names).toEqual(['screenshot', 'click', 'move', 'scroll', 'type_text', 'key', 'open_target']);
      const blocked = await rpc(3, 'tools/call', { name: 'click', arguments: { x: 1, y: 1 } });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked.content)).toMatch(/driving/i);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('scales a click from the screenshot and does not touch the real pointer in dry-run', async () => {
    const seen: { act?: boolean }[] = [];
    const server = await listen((body) => {
      seen.push(body);
      return {
        held: false,
        placement: { available: true, backend: 'host' },
        actions: { allowed: true, used: seen.length },
        maxActions: 300,
      };
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const { child, rpc } = openDriver(address.port);
    try {
      await rpc(1, 'initialize', {});
      await rpc(2, 'tools/call', { name: 'screenshot', arguments: {} });
      const clicked = await rpc(3, 'tools/call', { name: 'click', arguments: { x: 1, y: 1 } });
      expect(clicked.isError).toBeUndefined();
      expect(JSON.stringify(clicked.content)).toContain('screen 12,22');
      expect(seen.some((call) => call.act === true)).toBe(true);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
