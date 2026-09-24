import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Legacy data dirs, newest-first. Boot migrates the first one that exists. */
const LEGACY_DIRS = ['.openharnessbotbot', '.opengrokbot'];

function resolveDataDir(): string {
  const override = process.env.HB_DATA_DIR || process.env.OMB_DATA_DIR;
  if (override) return path.resolve(override);
  const home = homedir();
  const target = path.join(home, '.harnessbot');
  if (!fs.existsSync(target)) {
    for (const legacy of LEGACY_DIRS) {
      const from = path.join(home, legacy);
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, target);
          break;
        } catch {
          // A failed migration must not stop the app: fall through to a fresh dir.
        }
      }
    }
  }
  return target;
}

export const DATA_DIR = resolveDataDir();

export function dataPath(...parts: string[]): string {
  return path.join(DATA_DIR, ...parts);
}

/**
 * The HarnessBot checkout, if this process was started from one.
 * A packaged app has no writable source tree, so this returns null there.
 */
export function findAppSource(starts: string[]): string | null {
  const seen = new Set<string>();
  for (const start of starts) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      try {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(path.join(dir, 'server', 'index.ts')) && fs.existsSync(pkgPath)) {
          const name = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string }).name;
          if (name === 'harnessbot') return dir;
        }
      } catch {
        // Unreadable package.json: keep walking.
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ensureDir(DATA_DIR);

/**
 * Atomic write. Temp file in the same directory, then rename, so a crash mid-write
 * leaves the previous good file rather than a truncated one.
 */
export function writeFileAtomic(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read JSON, quarantining unreadable files as *.corrupt instead of crashing the fleet.
 * Losing one bot roster to a bad write should not stop the other bots from answering.
 */
export function readJsonSafe<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      fs.renameSync(file, `${file}.${Date.now()}.corrupt`);
    } catch {
      /* best effort */
    }
    return fallback;
  }
}

export function appendNdjson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
