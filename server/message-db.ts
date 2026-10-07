import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import type { Message, ThreadId } from '../shared/types.ts';
import { dataPath } from './paths.ts';

/**
 * Transcripts live in SQLite (HB-TRD-001 NFR-PERF-1). A long computer-use thread
 * appends hundreds of chips; rewriting a megabyte JSON file per append was the bug
 * this replaces. INSERT per message, UPDATE per patch, never a whole-file rewrite.
 */

const DB_FILE = dataPath('messages.db');

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id        TEXT NOT NULL,
      at        INTEGER NOT NULL,
      role      TEXT NOT NULL,
      kind      TEXT NOT NULL,
      text      TEXT,
      json      TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, at);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id      TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
  `);
  // WAL sidecars are created by the schema statements above. Owner-only applies to them too.
  for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows has no POSIX mode; the file inherits the user profile ACL instead.
    }
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

const hydrated = new Set<ThreadId>();

/**
 * Legacy messages-<threadId>.json import into SQLite, once per thread.
 * Existing rows win: the JSON is a backup from before the move, and replaying it
 * would wipe reactions and edits made since. After a successful read the file is
 * renamed so the next launch does not import it again.
 */
function legacyTranscript(threadId: ThreadId): string | null {
  // Thread ids are generated, but a client can PATCH one. This name is a path.
  if (/[\\/]/.test(threadId) || threadId.includes('..')) return null;
  return dataPath(`messages-${threadId}.json`);
}

function importLegacy(threadId: ThreadId): void {
  const legacy = legacyTranscript(threadId);
  if (!legacy || !fs.existsSync(legacy)) return;
  let parsed: Message[];
  try {
    parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Message[];
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const insert = open().prepare(
    `INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, id) DO NOTHING`,
  );
  for (const message of parsed) {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') continue;
    insert.run(threadId, message.id, message.at ?? 0, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  }
  try {
    fs.renameSync(legacy, `${legacy}.imported`);
  } catch {
    // The insert ignores conflicts, so a later retry will not clobber SQLite.
  }
}

function hydrate(threadId: ThreadId): void {
  if (hydrated.has(threadId)) return;
  hydrated.add(threadId);
  importLegacy(threadId);
}

/** Search and other cross-thread reads must import legacy JSON before SQLite is empty. */
export function ensureHydrated(threadId: ThreadId): void {
  hydrate(threadId);
}

export function insertMessage(threadId: ThreadId, message: Message): void {
  open()
    .prepare(
      `INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, id) DO UPDATE SET at=excluded.at, role=excluded.role,
         kind=excluded.kind, text=excluded.text, json=excluded.json`,
    )
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
}

export function patchMessage(threadId: ThreadId, message: Message): void {
  insertMessage(threadId, message);
}

export function getMessage(threadId: ThreadId, id: string): Message | undefined {
  hydrate(threadId);
  const row = open().prepare('SELECT json FROM messages WHERE thread_id = ? AND id = ?').get(threadId, id) as
    | { json: string }
    | undefined;
  return row ? (JSON.parse(row.json) as Message) : undefined;
}

/**
 * Ordered by time, then by insertion. Two messages can share a millisecond — a user
 * send and the first tool chip routinely do — and `id` is random, so it was breaking
 * ties by sorting the transcript at random. rowid is the order they actually arrived,
 * and the upsert in insertMessage keeps it across patches.
 */
export function listMessages(threadId: ThreadId, limit?: number): Message[] {
  hydrate(threadId);
  const sql = limit
    ? 'SELECT json FROM (SELECT json, at, rowid AS seq FROM messages WHERE thread_id = ? ORDER BY at DESC, seq DESC LIMIT ?) ORDER BY at ASC, seq ASC'
    : 'SELECT json FROM messages WHERE thread_id = ? ORDER BY at ASC, rowid ASC';
  const rows = (limit ? open().prepare(sql).all(threadId, limit) : open().prepare(sql).all(threadId)) as {
    json: string;
  }[];
  return rows.map((r) => JSON.parse(r.json) as Message);
}

export function countMessages(threadId: ThreadId): number {
  hydrate(threadId);
  const row = open().prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(threadId) as { n: number };
  return row.n;
}

export function deleteThread(threadId: ThreadId): void {
  open().prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
  open().prepare('DELETE FROM thread_state WHERE thread_id = ?').run(threadId);
  hydrated.delete(threadId);
  const legacy = legacyTranscript(threadId);
  if (!legacy) return;
  for (const file of [legacy, `${legacy}.imported`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  }
}

export function getActiveLeaf(threadId: ThreadId): string | null {
  const row = open().prepare('SELECT active_leaf_id FROM thread_state WHERE thread_id = ?').get(threadId) as
    | { active_leaf_id: string | null }
    | undefined;
  return row?.active_leaf_id ?? null;
}

export function setActiveLeaf(threadId: ThreadId, leafId: string | null): void {
  open()
    .prepare(
      `INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id`,
    )
    .run(threadId, leafId);
}

export interface SearchHit {
  threadId: ThreadId;
  message: Message;
}

export interface ThreadTail {
  threadId: ThreadId;
  at: number;
  text: string | null;
}

/** Newest row of each thread. History uses this instead of loading every transcript. */
export function latestPerThread(limit = 300): ThreadTail[] {
  const rows = open()
    .prepare(
      `SELECT m.thread_id AS thread_id, m.at AS at, m.text AS text
       FROM messages m
       INNER JOIN (
         SELECT thread_id, MAX(rowid) AS seq
         FROM messages
         GROUP BY thread_id
       ) latest ON latest.thread_id = m.thread_id AND latest.seq = m.rowid
       ORDER BY m.at DESC
       LIMIT ?`,
    )
    .all(limit) as { thread_id: string; at: number; text: string | null }[];
  return rows.map((row) => ({ threadId: row.thread_id, at: row.at, text: row.text }));
}

export function searchMessages(query: string, limit = 100): SearchHit[] {
  const rows = open()
    .prepare(
      `SELECT thread_id, json FROM messages
       WHERE text IS NOT NULL AND text LIKE ? ESCAPE '\\'
       ORDER BY at DESC LIMIT ?`,
    )
    .all(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit) as { thread_id: string; json: string }[];
  return rows.map((r) => ({ threadId: r.thread_id, message: JSON.parse(r.json) as Message }));
}
