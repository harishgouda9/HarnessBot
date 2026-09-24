#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';

/** `pnpm dev:all` — harness and Vite together, with the port check people actually need. */

const HB_PORT = Number(process.env.HB_PORT ?? process.env.OGB_PORT ?? 8799);
const WEBHOOK_PORT = Number(process.env.HB_WEBHOOK_PORT ?? HB_PORT + 1);
const UI_PORT = Number(process.env.HB_UI_PORT ?? 5199);

function inUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

const busy = [];
for (const [name, port] of [
  ['harness', HB_PORT],
  ['webhooks', WEBHOOK_PORT],
]) {
  if (await inUse(port)) busy.push(`${name} port ${port}`);
}

if (busy.length) {
  // Hard stop: two harnesses sharing one data dir corrupt each other's state.
  console.error(`Cannot start: ${busy.join(' and ')} already in use.`);
  console.error('Stop the other instance, or set HB_PORT / HB_WEBHOOK_PORT.');
  process.exit(1);
}

// Vite colliding on 5199 is only a warning: it picks the next free port itself.
if (await inUse(UI_PORT)) console.warn(`Note: ${UI_PORT} is busy, Vite will choose another port.`);

const children = new Map();
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) child.kill();
  process.exit(0);
}

function run(name, command, args) {
  const prefix = (line) => `${name.padEnd(7)} | ${line}`;
  const write = (stream, data) => {
    const lines = String(data).split('\n').filter(Boolean);
    if (lines.length) stream.write(`${lines.map(prefix).join('\n')}\n`);
  };
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HB_PORT: String(HB_PORT), HB_WEBHOOK_PORT: String(WEBHOOK_PORT) },
    shell: false,
  });
  child.stdout.on('data', (d) => write(process.stdout, d));
  child.stderr.on('data', (d) => write(process.stderr, d));
  child.on('exit', (code) => {
    // A restart kills the old child on purpose; only an unexpected exit is fatal.
    if (children.get(name) !== child) return;
    console.log(prefix(`exited with ${code}`));
    shutdown();
  });
  children.set(name, child);
}

/**
 * Vite hot-reloads the renderer; the harness used to be spawned once and left alone.
 * So every server edit produced a new UI talking to an old API — routes 404ing, fields
 * missing, a fix that visibly "did not work" because it was never loaded. The skew was
 * silent, which is the worst part of it. Watch the server sources and restart.
 */
function watchAndRestart() {
  let timer = null;
  const bounce = (file) => {
    if (shuttingDown || !/\.(ts|mjs|js|json)$/.test(file ?? '')) return;
    clearTimeout(timer);
    // One save fires several events, and editors write a temp file first.
    timer = setTimeout(() => {
      console.log(`harness | ${file} changed, restarting the harness`);
      children.get('harness')?.kill();
      run('harness', process.execPath, ['--experimental-strip-types', 'server/index.ts']);
    }, 250);
  };

  for (const dir of ['server', 'shared']) {
    try {
      fs.watch(dir, { recursive: true }, (_event, file) => bounce(file));
    } catch {
      // Recursive watch is not available everywhere. Losing auto-restart is a
      // papercut; refusing to start the dev server over it would not be.
      console.warn(`Note: cannot watch ${dir}/, restart manually after server edits.`);
    }
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

  // On Windows, spawning .cmd shims (npx.cmd) with shell:false throws EINVAL
  // (Node >= 18.20/20.12/21.7, CVE-2024-27980), so run the Vite JS entry
  // directly through the current Node binary instead.
  const viteEntry = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

run('harness', process.execPath, ['--experimental-strip-types', 'server/index.ts']);
run('vite', process.execPath, [viteEntry]);
watchAndRestart();

console.log(`harness  http://127.0.0.1:${HB_PORT}`);
console.log(`ui       http://127.0.0.1:${UI_PORT}`);
console.log('watching server/ and shared/ - the harness restarts on save');
