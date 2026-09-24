#!/usr/bin/env node
import fs from 'node:fs';

/** Build output only. Never touches ~/.harnessbot — that is the user's data. */
for (const dir of ['dist', 'dist-server', 'release', 'node_modules/.vite']) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}`);
}
