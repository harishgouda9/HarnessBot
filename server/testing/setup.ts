import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Tests never touch the real ~/.harnessbot (HB-TRD-001 consideration 13).
 *
 * This runs before the test module is imported, which matters: paths.ts resolves
 * DATA_DIR at import time, so setting the variable any later would be too late and
 * the suite would quietly start editing the developer's actual roster.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessbot-test-'));

process.env.HB_DATA_DIR = path.join(root, 'data');
// HOME too, so anything that reaches for the home directory lands in the sandbox.
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.HB_COMPANION_DIR = path.join(root, 'companion');
// Empty, not unset: the harness otherwise discovers `dist/` in the checkout and
// the API smoke suite would start serving the real UI.
process.env.HB_STATIC_DIR = '';

// A fixed port base per worker keeps parallel API tests from colliding.
process.env.HB_PORT = String(19000 + (Number(process.env.VITEST_WORKER_ID ?? 1) % 500) * 4);
process.env.HB_WEBHOOK_PORT = String(Number(process.env.HB_PORT) + 1);

fs.mkdirSync(process.env.HB_DATA_DIR, { recursive: true });

afterAll(async () => {
  // Windows will not unlink an open file, and the transcript DB is usually still
  // open. Close it first, then treat cleanup as best-effort: a leftover temp dir is
  // not worth failing a green suite over.
  try {
    const { closeDb } = await import('../message-db.ts');
    closeDb();
  } catch {
    /* the test file never touched the database */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort */
  }
});

