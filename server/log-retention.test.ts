import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDecisions } from './approvals.ts';
import { appendNdjsonLimited, dataPath, readNdjsonTail } from './paths.ts';
import { store } from './store.ts';

describe('log retention', () => {
  it('rotates an ndjson log and still reads the previous generation', () => {
    const file = dataPath('events', 't_rotate.ndjson');
    appendNdjsonLimited(file, { n: 'x'.repeat(40) }, 20);
    appendNdjsonLimited(file, { n: 2 }, 20);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('"n":2');
    const rows = readNdjsonTail(file, 10) as { n: string | number }[];
    expect(rows.map((row) => row.n)).toEqual(['x'.repeat(40), 2]);
  });

  it('reads decisions from the rotated file and the current file', () => {
    const file = dataPath('decisions.ndjson');
    fs.mkdirSync(dataPath(), { recursive: true });
    fs.writeFileSync(`${file}.1`, `${JSON.stringify({ at: 1, tool: 'old' })}\n`);
    fs.writeFileSync(file, `${JSON.stringify({ at: 2, tool: 'new' })}\n`);
    expect(readDecisions(10).map((entry) => entry.tool)).toEqual(['old', 'new']);
  });

  it('restricts the message database mode on platforms that have one', () => {
    store.appendMessage('t_mode', { role: 'user', kind: 'text', text: 'x' });
    const db = dataPath('messages.db');
    expect(fs.existsSync(db)).toBe(true);
    if (process.platform === 'win32') return;
    for (const file of [db, `${db}-wal`, `${db}-shm`]) {
      if (!fs.existsSync(file)) continue;
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
