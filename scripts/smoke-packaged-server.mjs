#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Packaged-server smoke.
 *
 * Incident 0.1.24: an unbundled import killed packaged launch while /api/health
 * stayed green on the dev server. So this boots the *bundled* output, on a throwaway
 * data dir, and checks the things a broken bundle actually breaks.
 */

const PORT = 8999;
const OUT = 'dist-server';

if (!fs.existsSync(path.join(OUT, 'server', 'index.js'))) {
  console.error('No bundle found. Run `npm run build:server` first.');
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-smoke-'));
const child = spawn(process.execPath, [path.join(OUT, 'server', 'index.js')], {
  env: { ...process.env, HB_PORT: String(PORT), HB_WEBHOOK_PORT: String(PORT + 1), HB_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

const fail = (message) => {
  console.error(`SMOKE FAIL: ${message}`);
  console.error(output.slice(-2000));
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
};

const deadline = Date.now() + 20_000;
let health = null;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
    health = await res.json();
    break;
  } catch {
    if (child.exitCode !== null) fail(`the bundled server exited with ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (health?.app !== 'harnessbot') fail('the bundled server did not answer /api/health');

// The webhook receiver has to come up too, and stay isolated.
const hookHealth = await fetch(`http://127.0.0.1:${PORT + 1}/health`).then((r) => r.json());
if (hookHealth?.app !== 'harnessbot-webhooks') fail('the webhook receiver did not start');

const leak = await fetch(`http://127.0.0.1:${PORT + 1}/api/bots`);
if (leak.status !== 404) fail('the webhook port exposed the harness API');

// A real write path, because a bundle can boot and still fail on first SQLite use.
const bot = await fetch(`http://127.0.0.1:${PORT}/api/bots`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Smoke' }),
}).then((r) => r.json());
if (!bot?.id) fail('could not create a bot against the bundled server');

const config = await fetch(`http://127.0.0.1:${PORT}/api/config`).then((r) => r.text());
if (config.includes('"secrets"')) fail('the bundled server echoed secrets from /api/config');

child.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('Packaged server smoke OK: health, webhook isolation, write path, no secret echo.');
