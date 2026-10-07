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

/** One previous generation. Long computer-use turns must not grow a log without bound. */
export const NDJSON_ROTATE_BYTES = 8 * 1024 * 1024;

export function appendNdjsonLimited(file: string, value: unknown, maxBytes = NDJSON_ROTATE_BYTES): void {
  ensureDir(path.dirname(file));
  try {
    if (fs.statSync(file).size >= maxBytes) {
      const previous = `${file}.1`;
      fs.rmSync(previous, { force: true });
      fs.renameSync(file, previous);
    }
  } catch {
    // The first append creates the file.
  }
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

const THREAD_LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

/** Event and native logs are named by thread id. Anything else is not a file name. */
export function threadLogPath(kind: 'events' | 'native', threadId: string): string | null {
  if (!THREAD_LOG_NAME.test(threadId) || threadId.includes('..')) return null;
  return dataPath(kind, `${threadId}.ndjson`);
}

export function removeThreadLogs(threadId: string): void {
  for (const kind of ['events', 'native'] as const) {
    const file = threadLogPath(kind, threadId);
    if (!file) return;
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.1`, { force: true });
  }
}

/** Current file plus the one rotated generation, oldest first. */
export function readNdjsonTail(file: string, limit: number): unknown[] {
  const lines: string[] = [];
  for (const candidate of [`${file}.1`, file]) {
    try {
      const text = fs.readFileSync(candidate, 'utf8').trim();
      if (text) lines.push(...text.split('\n'));
    } catch {
      // The rotated generation or the current file may not exist yet.
    }
  }
  const out: unknown[] = [];
  const cap = Number.isFinite(limit) && limit > 0 ? limit : lines.length;
  for (const line of lines.slice(-cap)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line at the rotation boundary is skipped.
    }
  }
  return out;
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
