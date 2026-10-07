import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One version string for /api/health. The human edits package.json; this walks
 * up from the module until it finds that file. The packaged copy carries a
 * name-and-version stub at dist-server/package.json, written by the bundle
 * script, so the walk still lands on the same string after type-stripping.
 */
function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (parsed.name === 'harnessbot' && typeof parsed.version === 'string' && parsed.version) return parsed.version;
    } catch {
      // Not this directory. Keep walking toward the checkout or the app root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

export const VERSION = readVersion();
