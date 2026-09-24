#!/usr/bin/env node
/**
 * Link this checkout into Hermes so Desktop can load the sidebar row / SESSIONS
 * tab, and so the CLI/dashboard plugin is the same folder.
 *
 *   ~/.hermes/plugins/harnessbot          → integrations/hermes
 *   ~/.hermes/desktop-plugins/harnessbot  → integrations/hermes/desktop
 *
 * The desktop door is the one that puts "HarnessBot" next to Kanban. The
 * plugins/ junction is the Python + dashboard half. On Windows both are
 * junctions; elsewhere they are symlinks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'integrations', 'hermes');
const DESKTOP = path.join(PLUGIN, 'desktop');

function hermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return path.join(local, 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function alreadyLinked(from, to) {
  try {
    return fs.realpathSync(to) === fs.realpathSync(from);
  } catch {
    return false;
  }
}

function link(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (alreadyLinked(from, to)) {
    console.log(`ok   ${to}`);
    return;
  }
  if (fs.existsSync(to)) {
    throw new Error(`${to} already exists and is not this checkout. Remove it, then retry.`);
  }
  if (process.platform === 'win32') fs.symlinkSync(from, to, 'junction');
  else fs.symlinkSync(from, to);
  console.log(`link ${to}`);
}

const home = hermesHome();
if (!fs.existsSync(path.join(DESKTOP, 'plugin.js'))) {
  throw new Error(`desktop plugin is not built at ${path.join(DESKTOP, 'plugin.js')}. Run node scripts/build-hermes-plugin.mjs first.`);
}

link(PLUGIN, path.join(home, 'plugins', 'harnessbot'));
link(DESKTOP, path.join(home, 'desktop-plugins', 'harnessbot'));

console.log('\nThen:');
console.log('  hermes plugins enable harnessbot');
console.log('  Desktop: command palette → Reload desktop plugins');
console.log('  If the sidebar row is still missing: Capabilities → Plugins → HarnessBot');
