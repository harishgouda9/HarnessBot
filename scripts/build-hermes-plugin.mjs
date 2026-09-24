#!/usr/bin/env node
/**
 * Build the Hermes plugin: the harness bundle and the UI, staged into
 * `integrations/hermes/` so the whole plugin is one self-contained directory that
 * can be symlinked into `~/.hermes/plugins/`.
 *
 * Two UI builds, because the two Hermes shells are not the same origin:
 *
 *   dashboard  static -> /dashboard-plugins/harnessbot/ui
 *              api    -> /api/plugins/harnessbot/hb
 *              The dashboard's plugin-asset route is unauthenticated by design
 *              because no <iframe src> can send a header.
 *
 *   desktop    static -> /   (served by the harness at 127.0.0.1:<port>)
 *              api    -> /api  (same origin)
 *              Hermes Desktop has no /dashboard-plugins/ route, so the full
 *              product is served by the harness the plugin already supervises.
 *
 * Bases are slash-free: MSYS shells rewrite any value starting with '/' into
 * a Windows path, which silently produces a build pointing at the shell's root.
 */

import { spawnSync } from 'node:child_process';
import { build as buildDesktopPlugin } from './build-desktop-plugin.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'integrations', 'hermes');
const HARNESS_OUT = path.join(PLUGIN, 'harness');
const DASHBOARD_UI = path.join(PLUGIN, 'dashboard', 'ui');
const STANDALONE_UI = path.join(HARNESS_OUT, 'ui');

export const STATIC_BASE = 'dashboard-plugins/harnessbot/ui';
export const API_BASE = 'api/plugins/harnessbot/hb';

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.signal}`);
  }
}

async function main() {
  console.log('1/5  harness bundle');
  run(process.execPath, ['scripts/bundle-server.mjs']);

  // The bundle is dependency-free JS, so staging it is a copy, not an install.
  try {
    fs.rmSync(HARNESS_OUT, { recursive: true, force: true });
  } catch (err) {
    // A running harness holds its own files open. On Windows that is EBUSY and on
    // Linux it is a silent overwrite of a binary someone is executing, so say the
    // actionable thing rather than surfacing an errno.
    if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY') {
      throw new Error(
        `${path.relative(ROOT, HARNESS_OUT)} is in use — the harness is running.\n` +
          '  Stop it first:  hermes harnessbot stop',
      );
    }
    throw err;
  }
  fs.cpSync(path.join(ROOT, 'dist-server'), HARNESS_OUT, { recursive: true });

  // The harness runs with the staged directory as its cwd and reads its bundled
  // skill library from `./skills`. Electron ships that folder as a resource; here
  // it has to travel with the bundle or the library arrives empty.
  fs.cpSync(path.join(ROOT, 'skills'), path.join(HARNESS_OUT, 'skills'), { recursive: true });
  console.log(`     -> ${path.relative(ROOT, HARNESS_OUT)}`);

  console.log('2/5  dashboard UI (prefixed assets + API)');
  run('npx', ['vite', 'build', '--outDir', DASHBOARD_UI, '--emptyOutDir'], {
    HB_BASE: STATIC_BASE,
    HB_API_BASE: API_BASE,
  });

  console.log('3/5  standalone UI (served by the harness, used by Desktop)');
  run('npx', ['vite', 'build', '--outDir', STANDALONE_UI, '--emptyOutDir'], {
    // Force empty: a leftover HB_BASE in the parent env would silently produce
    // the dashboard-prefixed build at the standalone path.
    HB_BASE: '',
    HB_API_BASE: '',
  });

  console.log('4/5  native desktop plugin');
  await buildDesktopPlugin();

  console.log('5/5  checking what was produced');
  const entry = path.join(HARNESS_OUT, 'server', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`harness entry point missing: ${entry}`);

  const dashboardIndex = fs.readFileSync(path.join(DASHBOARD_UI, 'index.html'), 'utf8');
  if (!dashboardIndex.includes(`/${STATIC_BASE}/assets/`)) {
    throw new Error('dashboard UI assets do not carry the static base — HB_BASE did not reach vite');
  }

  const dashboardBundles = fs.readdirSync(path.join(DASHBOARD_UI, 'assets')).filter((f) => f.endsWith('.js'));
  const dashboardBaked = dashboardBundles.some((f) =>
    fs.readFileSync(path.join(DASHBOARD_UI, 'assets', f), 'utf8').includes(`"${API_BASE}"`),
  );
  if (!dashboardBaked) throw new Error('dashboard UI does not carry the API base — HB_API_BASE did not reach vite');

  const standaloneIndex = path.join(STANDALONE_UI, 'index.html');
  if (!fs.existsSync(standaloneIndex)) throw new Error(`standalone UI missing: ${standaloneIndex}`);
  const standaloneHtml = fs.readFileSync(standaloneIndex, 'utf8');
  if (standaloneHtml.includes('dashboard-plugins')) {
    throw new Error('standalone UI was built with the dashboard asset prefix');
  }
  if (!standaloneHtml.includes('/assets/')) {
    throw new Error('standalone UI assets are not rooted at /');
  }

  console.log('\nok. Install it with:');
  console.log(`  node scripts/install-hermes-plugin.mjs`);
  console.log('  hermes plugins enable harnessbot');
  console.log('  then in Desktop: Reload desktop plugins (⌘K / Ctrl+K)');
}

await main();
