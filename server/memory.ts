import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryEntry, MemoryKind, MemoryScope, MemorySource } from '../shared/types.ts';
import { dataPath, ensureDir } from './paths.ts';

/**
 * Structured memory (HB-PRD-001 F-MEM-01). JSONL per scope so an entry can be
 * appended without rewriting the file, and so a user can read it in a text editor —
 * memory the user cannot inspect and correct is memory they cannot trust.
 *
 * Three durable scopes, narrowest first: one bot's own, a section's, and the
 * account-wide `workspace` tier every bot on the machine reads. The widest tier is
 * what makes "tell it once" true across a roster rather than once per teammate.
 */

export type MemoryScopeName = MemoryScope;
export const MEMORY_SCOPES: MemoryScope[] = ['bot', 'section', 'workspace'];

/** The one id every workspace-scoped entry carries; the tier is a singleton. */
export const WORKSPACE_ID = 'workspace';

const KINDS: MemoryKind[] = ['fact', 'preference', 'correction', 'entity', 'decision', 'task_outcome', 'reference'];
const SOURCES: MemorySource[] = ['user', 'bot_verified', 'bot_inferred', 'imported'];
const TAG_RE = /^[\w][\w .-]{0,63}$/;

const MAX_TEXT = 2000;
const MAX_ENTITIES = 32;
const MAX_TOPICS = 16;

function fileFor(scope: MemoryScope, id: string): string {
  const safe = String(id).replace(/[^\w.-]/g, '_') || 'unknown';
  if (scope === 'workspace') return dataPath('memory', 'workspace.jsonl');
  return scope === 'bot' ? dataPath('bots', safe, 'memory.jsonl') : dataPath('sections', safe, 'memory.jsonl');
}

function readAll(file: string): MemoryEntry[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryEntry);
  } catch {
    return [];
  }
}

function rewrite(file: string, entries: MemoryEntry[]): void {
  ensureDir(file.slice(0, file.lastIndexOf('/') + 1) || dataPath());
  fs.mkdirSync(file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
}

export interface MemoryInput {
  scope: MemoryScope;
  botId?: string;
  sectionId?: string;
  kind: MemoryKind;
  text: string;
  entities?: string[];
  topics?: string[];
  confidence?: number;
  source: MemorySource;
  provenance?: Partial<MemoryEntry['provenance']>;
}

export function validate(input: MemoryInput): MemoryEntry {
  if (!KINDS.includes(input.kind)) throw new Error(`unknown memory kind: ${input.kind}`);
  if (!SOURCES.includes(input.source)) throw new Error(`unknown memory source: ${input.source}`);
  const text = String(input.text ?? '').trim();
  if (!text || text.length > MAX_TEXT) throw new Error(`text must be 1-${MAX_TEXT} characters`);
  if (!MEMORY_SCOPES.includes(input.scope)) throw new Error(`unknown memory scope: ${input.scope}`);
  if (input.scope === 'bot' && !input.botId) throw new Error('botId is required for bot scope');
  if (input.scope === 'section' && !input.sectionId) throw new Error('sectionId is required for section scope');
  if (input.sectionId && input.sectionId.length > 128) throw new Error('sectionId is too long');

  const tags = (list: string[] | undefined, max: number): string[] =>
    (list ?? [])
      .map((t) => String(t).trim())
      .filter((t) => TAG_RE.test(t))
      .slice(0, max);

  // An inferred memory starts below the trust line: the bot guessed, it did not verify.
  const raw = typeof input.confidence === 'number' ? input.confidence : input.source === 'bot_inferred' ? 0.5 : 0.9;
  const confidence = input.source === 'bot_inferred' ? Math.min(0.59, Math.max(0, raw)) : Math.min(1, Math.max(0, raw));

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    scope: input.scope,
    botId: input.scope === 'bot' ? input.botId : undefined,
    sectionId: input.scope === 'section' ? input.sectionId : undefined,
    kind: input.kind,
    text,
    entities: tags(input.entities, MAX_ENTITIES),
    topics: tags(input.topics, MAX_TOPICS),
    confidence,
    source: input.source,
    provenance: { createdBy: input.source, ...input.provenance },
    createdAt: now,
    updatedAt: now,
  };
}

export function addMemory(input: MemoryInput): MemoryEntry {
  const entry = validate(input);
  const file = fileFor(entry.scope, (entry.scope === 'bot' ? entry.botId : entry.sectionId) ?? 'unknown');
  fs.mkdirSync(file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function listMemory(scope: MemoryScope, id: string, query?: string): MemoryEntry[] {
  const all = readAll(fileFor(scope, id));
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter((e) => e.text.toLowerCase().includes(q) || e.topics.some((t) => t.toLowerCase().includes(q)));
}

export function updateMemory(scope: MemoryScope, id: string, entryId: string, patch: Partial<MemoryInput>): MemoryEntry | null {
  const file = fileFor(scope, id);
  const all = readAll(file);
  const index = all.findIndex((e) => e.id === entryId);
  if (index < 0) return null;
  const merged = { ...all[index]!, ...patch, updatedAt: new Date().toISOString() } as MemoryEntry;
  all[index] = merged;
  rewrite(file, all);
  return merged;
}

export function deleteMemory(scope: MemoryScope, id: string, entryId: string): boolean {
  const file = fileFor(scope, id);
  const all = readAll(file);
  const next = all.filter((e) => e.id !== entryId);
  if (next.length === all.length) return false;
  rewrite(file, next);
  return true;
}

/**
 * Memory a bot writes for *other* bots to read needs an explicit user grant. One bot
 * quietly editing what the whole roster believes is the failure worth preventing here,
 * and the account-wide tier makes that blast radius bigger, not smaller — so the same
 * grant gate covers it.
 */
const sharedGrants = new Set<string>();

export function grantSectionMemory(sectionId: string, granted: boolean): void {
  if (granted) sharedGrants.add(sectionId);
  else sharedGrants.delete(sectionId);
}

export function canWriteSection(sectionId: string): boolean {
  return sharedGrants.has(sectionId);
}

/** Freeform per-bot MEMORY.md, budgeted so it cannot crowd out the actual prompt. */
const MEMORY_MD_LINES = 200;
const MEMORY_MD_BYTES = 24 * 1024;

export function readMemoryMd(botId: string): string {
  try {
    const raw = fs.readFileSync(dataPath('workspaces', botId, 'MEMORY.md'), 'utf8');
    return raw.split('\n').slice(0, MEMORY_MD_LINES).join('\n').slice(0, MEMORY_MD_BYTES);
  } catch {
    return '';
  }
}

/**
 * What actually goes into a system prompt: all three durable tiers, high-confidence
 * first, capped. A bot's own memory outranks its section's, which outranks the
 * workspace's, so a local correction wins over a general belief.
 */
export function memoryForPrompt(botId: string, section?: string, limit = 40): string {
  const rank: Record<MemoryScope, number> = { bot: 0, section: 1, workspace: 2 };
  const entries = [
    ...listMemory('bot', botId),
    ...(section ? listMemory('section', section) : []),
    ...listMemory('workspace', WORKSPACE_ID),
  ]
    .sort(
      (a, b) =>
        rank[a.scope] - rank[b.scope] ||
        b.confidence - a.confidence ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, limit);
  const md = readMemoryMd(botId);
  const lines = entries.map((e) => `- (${e.kind}) ${e.text}`);
  if (!lines.length && !md) return '';
  return [md, lines.length ? `Known facts:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Tier 4: shared artifacts
// ---------------------------------------------------------------------------

/**
 * One directory every bot on this machine can read and write.
 *
 * The point is handoffs. A research bot writes a CSV and a reporting bot reads it by
 * path, with no copy through anyone's context window — which is both cheaper and the
 * only way a large result survives a turn boundary intact.
 *
 * It is deliberately inside the data directory, never the user's home or a project
 * folder: shared and unbounded are a bad pair.
 */
export const sharedDir = (): string => ensureDir(dataPath('workspace'));

export interface Artifact {
  name: string;
  bytes: number;
  updatedAt: number;
}

export function listArtifacts(limit = 200): Artifact[] {
  let names: string[];
  try {
    names = fs.readdirSync(sharedDir());
  } catch {
    return [];
  }
  const out: Artifact[] = [];
  for (const name of names.slice(0, limit)) {
    try {
      const stat = fs.statSync(path.join(sharedDir(), name));
      if (stat.isFile()) out.push({ name, bytes: stat.size, updatedAt: stat.mtimeMs });
    } catch {
      // Raced with a delete. A missing file is not worth failing the listing over.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Resolve a name inside the shared directory, refusing anything that escapes it. */
export function artifactPath(name: string): string {
  const base = sharedDir();
  // `name` reaches this from a bot's tool call, so containment is checked, not assumed.
  const resolved = path.resolve(base, String(name ?? ''));
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(prefix)) throw new Error('artifact path escapes the shared workspace');
  if (resolved === base) throw new Error('artifact name is required');
  return resolved;
}

export function readArtifact(name: string): string {
  return fs.readFileSync(artifactPath(name), 'utf8');
}

export function writeArtifact(name: string, body: string): Artifact {
  const file = artifactPath(name);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, body, 'utf8');
  return { name, bytes: Buffer.byteLength(body, 'utf8'), updatedAt: Date.now() };
}

export function deleteArtifact(name: string): boolean {
  try {
    fs.rmSync(artifactPath(name), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tier 1 maintenance: compaction and externalisation
// ---------------------------------------------------------------------------

/**
 * A single transcript line big enough to matter is spilled to the shared workspace and
 * replaced by a pointer.
 *
 * A scrape or a shell dump can be tens of thousands of tokens, and pasting it back
 * into every subsequent turn is how a long task quietly becomes unaffordable — and
 * then breaks, when the window fills. The file keeps the whole thing; the prompt keeps
 * the first lines and the path, which is what the bot needs to decide whether to open
 * it.
 */
export const EXTERNALISE_OVER = 4000;

export function externalise(text: string, hint = 'output'): { text: string; artifact?: string } {
  if (Buffer.byteLength(text, 'utf8') <= EXTERNALISE_OVER) return { text };

  const safeHint = String(hint).replace(/[^\w.-]/g, '-').slice(0, 40) || 'output';
  const name = `${safeHint}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.txt`;
  try {
    writeArtifact(name, text);
  } catch {
    // If the spill fails, truncating is still better than blowing the window.
    return { text: `${text.slice(0, EXTERNALISE_OVER)}\n…[truncated, ${text.length} characters]` };
  }

  const head = text.slice(0, 800);
  return {
    text: `${head}\n…[${text.length} characters total, written to the shared workspace as ${name}. Read it from there rather than asking for it again.]`,
    artifact: name,
  };
}

export interface TranscriptLine {
  role: 'user' | 'bot';
  text: string;
  name?: string;
}

/**
 * Recency-weighted context: keep the last `keep` turns verbatim and replace everything
 * older with one declarative digest.
 *
 * The window used to be a hard slice — turns past the limit simply vanished, taking
 * the original goal with them, which is exactly the context a long task most needs.
 * A digest is not a summary a model wrote; it is what can be stated without guessing:
 * how much was dropped, who was talking, and the request that started it.
 */
export function compactTranscript(lines: TranscriptLine[], keep = 40): TranscriptLine[] {
  if (lines.length <= keep) return lines;

  const dropped = lines.slice(0, lines.length - keep);
  const recent = lines.slice(-keep);
  const opening = dropped.find((l) => l.role === 'user')?.text.trim().replace(/\s+/g, ' ').slice(0, 300);
  const speakers = [...new Set(dropped.map((l) => l.name).filter(Boolean))];

  const digest = [
    `[Earlier context: ${dropped.length} turn${dropped.length === 1 ? '' : 's'} before this point have been compacted.`,
    opening ? ` The conversation opened with: "${opening}".` : '',
    speakers.length ? ` Participants so far: ${speakers.join(', ')}.` : '',
    ' Ask if you need a detail from before this point rather than assuming it was never said.]',
  ].join('');

  return [{ role: 'user', text: digest }, ...recent];
}

