import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SkillRecord } from '../shared/types.ts';
import { isValidSkillName, MAX_SKILL_NAME, slugifySkillName } from '../shared/skill-name.ts';
import { hermesSkillFiles } from './hermes-bridge.ts';
import { clip, clipList, pickRelevant, PROMPT_LIMITS, type PromptLimits } from './prompt-budget.ts';
import { parameterise, renderParameters } from './skill-parameters.ts';
import { dataPath, ensureDir, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { redactSecretsInText } from './redact.ts';

/**
 * Agent Skills v1 (HB-PRD-001 F-SKL-01).
 *
 * A learned-skill proposal stays staged until the user confirms, and the confirmation
 * card is bound to a sha256 of the exact SKILL.md bytes. If the bytes change between
 * proposal and confirm — including because redaction rewrote them — the card becomes
 * deny-only rather than installing something the user never read.
 */

const MAX_BYTES = 256 * 1024;

/**
 * Two scopes. `global` is installed once and reaches every bot; a bot id installs for
 * that bot alone. They are the same storage with a different folder, which is why
 * every path below goes through scopeId() — the scope arrives from the client.
 */
export const GLOBAL_SCOPE = 'global';

/** Anything that becomes a directory name is validated, not trusted. */
export function scopeId(raw: string): string {
  const id = String(raw ?? '').trim();
  if (id === GLOBAL_SCOPE) return id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid skill scope');
  return id;
}

export const sha256 = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

function stateFile(botId: string): string {
  return dataPath('skill-state', scopeId(botId), 'skills.json');
}

function stagedFile(botId: string): string {
  return dataPath('skill-state', scopeId(botId), 'staged.json');
}

function skillDir(botId: string, name: string): string {
  return dataPath('workspaces', scopeId(botId), 'skills', validateName(name));
}

/**
 * A summary for a SKILL.md. YAML frontmatter wins when it is there (that is what
 * skills authored elsewhere carry); otherwise the first prose line, which is what the
 * bundled skills have always used.
 */
export function summarize(body: string): { name?: string; summary: string } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (front) {
    const lines = front[1]!.split(/\r?\n/);
    const field = (key: string): string | undefined => {
      const at = lines.findIndex((l) => new RegExp(`^${key}:`, 'i').test(l));
      if (at < 0) return undefined;
      const inline = lines[at]!.slice(lines[at]!.indexOf(':') + 1).trim();
      // `description: >` and `description: |-` continue on the indented lines below.
      // Reading only the marker is how a whole library ends up summarised as ">".
      if (!/^[|>][-+]?\d*$/.test(inline)) return inline.replace(/^["']|["']$/g, '') || undefined;
      const block: string[] = [];
      for (let i = at + 1; i < lines.length && (!lines[i]!.trim() || /^\s/.test(lines[i]!)); i += 1) {
        block.push(lines[i]!.trim());
      }
      return block.join(' ').trim() || undefined;
    };
    const description = field('description');
    if (description) return { name: field('name'), summary: description.slice(0, 200) };
  }
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
  return { summary: (line ?? '').slice(0, 200) };
}

export function validateName(name: string): string {
  const trimmed = String(name ?? '').trim().toLowerCase();
  if (!isValidSkillName(trimmed)) {
    throw new Error(`skill name must be kebab-case, max ${MAX_SKILL_NAME} characters`);
  }
  return trimmed;
}

export interface StagedSkill {
  name: string;
  summary: string;
  body: string;
  sha256: string;
  stagedAt: number;
}

/**
 * Stage a proposal. The digest is taken over the *redacted* body — the same bytes the
 * user will read and the same bytes that will be installed.
 */
export function stageSkill(botId: string, name: string, summary: string, body: string): StagedSkill {
  const safeName = validateName(name);
  const redacted = redactSecretsInText(body);
  if (Buffer.byteLength(redacted, 'utf8') > MAX_BYTES) throw new Error('SKILL.md exceeds 256 KiB');
  const staged: StagedSkill = {
    name: safeName,
    summary: redactSecretsInText(summary).slice(0, 500),
    body: redacted,
    sha256: sha256(redacted),
    stagedAt: Date.now(),
  };
  const all = readJsonSafe<StagedSkill[]>(stagedFile(botId), []).filter((s) => s.name !== safeName);
  all.push(staged);
  writeJsonAtomic(stagedFile(botId), all);
  return staged;
}

export function listStaged(botId: string): StagedSkill[] {
  return readJsonSafe<StagedSkill[]>(stagedFile(botId), []);
}

/**
 * Confirm a staged proposal. The digest must still match, or nothing is installed:
 * this is what makes the card deny-only when the bytes drifted.
 */
export function confirmSkill(botId: string, name: string, expectedSha: string): SkillRecord {
  const staged = listStaged(botId).find((s) => s.name === name);
  if (!staged) throw new Error('no staged skill by that name');
  if (staged.sha256 !== expectedSha || sha256(staged.body) !== expectedSha) {
    throw new Error('skill digest mismatch - this card can only be denied');
  }
  const dir = ensureDir(skillDir(botId, staged.name));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), staged.body, 'utf8');

  const record: SkillRecord = {
    name: staged.name,
    summary: staged.summary,
    sha256: staged.sha256,
    body: staged.body,
    installedAt: Date.now(),
    botId,
  };
  const installed = listSkills(botId).filter((s) => s.name !== record.name);
  installed.push(record);
  writeJsonAtomic(stateFile(botId), installed);
  writeJsonAtomic(
    stagedFile(botId),
    listStaged(botId).filter((s) => s.name !== name),
  );
  return record;
}

export function rejectSkill(botId: string, name: string): void {
  writeJsonAtomic(
    stagedFile(botId),
    listStaged(botId).filter((s) => s.name !== name),
  );
}

export function listSkills(botId: string): SkillRecord[] {
  return readJsonSafe<SkillRecord[]>(stateFile(botId), []);
}

export function removeSkill(botId: string, name: string): void {
  writeJsonAtomic(
    stateFile(botId),
    listSkills(botId).filter((s) => s.name !== name),
  );
  try {
    fs.rmSync(skillDir(botId, name), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/** Computer-use procedures that ship with the app. They are skills, not user recordings. */
export const BUILTIN_SKILLS = new Set(['computer-use', 'phone-harness']);

/** Skills that ship with the app, adoptable into a workspace. */
export function librarySkills(): SkillRecord[] {
  const root = path.resolve(process.cwd(), 'skills');
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'SKILL.md')));
  } catch {
    // No bundled library here; the host's may still have one.
  }

  const record = (name: string, body: string): SkillRecord => ({
    name,
    summary: summarize(body).summary,
    sha256: sha256(body),
    body,
    installedAt: 0,
    builtin: BUILTIN_SKILLS.has(name),
  });

  const shipped = names.map((name) => record(name, fs.readFileSync(path.join(root, name, 'SKILL.md'), 'utf8')));

  // The host Hermes' skills sit alongside the bundled ones rather than replacing
  // them: same two-phase install, same digest confirm. A name that exists in both
  // keeps the bundled one, because that is the body this build was tested against.
  const taken = new Set(shipped.map((s) => s.name));
  const hosted = hermesSkillFiles()
    .filter((s) => !taken.has(s.name))
    .map((s) => record(s.name, s.body));

  return [...shipped, ...hosted];
}

export function installFromLibrary(botId: string, name: string): SkillRecord {
  const found = librarySkills().find((s) => s.name === name);
  if (!found) throw new Error(`no library skill named ${name}`);
  const staged = stageSkill(botId, found.name, found.summary, found.body);
  return confirmSkill(botId, staged.name, staged.sha256);
}

/**
 * Installed skills, rendered for the system prompt: this bot's own plus everything
 * installed globally. A bot-scoped skill of the same name wins, so a bot can override
 * a workspace-wide skill without the global one having to be uninstalled.
 */
export function skillsForPrompt(
  botId: string,
  opts?: { query?: string; limits?: PromptLimits },
): string {
  const skills = effectiveSkills(botId);
  if (!skills.length) return '';
  // Every turn pays for this list. A host Hermes can contribute dozens of skills,
  // and a roster that installs all of them would spend more prompt on the index
  // than on the work; the cap keeps that bounded and says what it hid.
  const limits = opts?.limits ?? PROMPT_LIMITS;
  const { kept, hidden } = opts?.query
    ? pickRelevant(skills, opts.query, (s) => `${s.name} ${s.summary}`, limits.skillCount)
    : clipList(skills, limits.skillCount);
  const lines = kept.map((s) => `- ${s.name}: ${clip(s.summary, limits.skillSummary)}`);
  if (hidden) lines.push(`- (${hidden} more installed; ask to list them)`);
  return `Skills available to you:\n${lines.join('\n')}`;
}

/** Global skills plus this bot's, deduplicated by name with the bot's own winning. */
export function effectiveSkills(botId: string): SkillRecord[] {
  const own = listSkills(botId);
  const names = new Set(own.map((s) => s.name));
  return [...own, ...listSkills(GLOBAL_SCOPE).filter((s) => !names.has(s.name))];
}

// ---------------------------------------------------------------------------
// Outside sources
// ---------------------------------------------------------------------------

const MAX_FETCH_BYTES = 512 * 1024;

/**
 * GitHub blob URLs are what people actually copy out of the address bar, and fetching
 * one gives you an HTML page rather than a skill. Rewrite the shapes with an obvious
 * raw equivalent and pass everything else through untouched.
 */
export function rawUrlFor(input: string): string {
  const url = String(input ?? '').trim();
  if (!/^https:\/\//i.test(url)) throw new Error('only https sources are supported');
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i.exec(url);
  if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  return url;
}

/**
 * The skill name implied by a path: `skills/web-research/SKILL.md` is `web-research`,
 * because the folder is what names a skill everywhere these files come from.
 */
export function slugFromPath(input: string): string | undefined {
  const parts = String(input ?? '')
    .split(/[?#]/)[0]!
    .split('/')
    .filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const candidate = /^SKILL\.md$/i.test(last) ? (parts[parts.length - 2] ?? '') : last.replace(/\.md$/i, '');
  const slug = slugifySkillName(candidate);
  return slug || undefined;
}

/** Fetch text from an untrusted source, size-capped. Never executed, only staged. */
export async function fetchText(url: string): Promise<string> {
  const resolved = rawUrlFor(url);
  // Report the URL actually fetched: a 404 on a github.com link that was rewritten to
  // raw.githubusercontent is otherwise impossible to tell apart from a typo.
  const res = await fetch(resolved, { redirect: 'follow' });
  if (!res.ok) throw new Error(`could not fetch ${resolved}: ${res.status}`);
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_FETCH_BYTES) throw new Error('that file is too large to be a SKILL.md');
  return text;
}

/**
 * Stage a SKILL.md that came from outside — a pasted file, a URL, a repo. It is a
 * proposal like any other: the digest card still has to be confirmed, because bytes
 * off the internet are exactly what nobody should install unread.
 */
export async function stageFromUrl(botId: string, url: string, nameHint?: string): Promise<StagedSkill> {
  const body = await fetchText(url);
  const meta = summarize(body);
  return stageSkill(botId, nameHint || meta.name || slugFromPath(url) || 'imported-skill', meta.summary, body);
}

// ---------------------------------------------------------------------------
// Skill recorder
// ---------------------------------------------------------------------------

/**
 * Capture a procedure as a skill (HB-PRD-001 F-SKL-02, behind Experimental).
 *
 * The recorder only ever produces a *staged* proposal. Finishing a recording does
 * not install anything — it writes a draft the user still has to read and confirm,
 * because a recorded procedure is exactly the kind of thing that quietly encodes a
 * step nobody meant to keep.
 */

export interface RecorderStep {
  at: number;
  kind: 'action' | 'note' | 'check';
  text: string;
}

export interface RecorderSession {
  id: string;
  botId: string;
  name: string;
  startedAt: number;
  steps: RecorderStep[];
}

const recordings = new Map<string, RecorderSession>();
const RECORDINGS_FILE = dataPath('recordings.json');

function persistRecordings(): void {
  writeJsonAtomic(RECORDINGS_FILE, [...recordings.values()]);
}

for (const session of readJsonSafe<RecorderSession[]>(RECORDINGS_FILE, [])) {
  if (session?.id && session.botId && session.name) recordings.set(session.id, { ...session, steps: session.steps ?? [] });
}

export function startRecording(botId: string, name: string): RecorderSession {
  const session: RecorderSession = {
    id: `rec_${Date.now().toString(36)}`,
    botId,
    name: validateName(name),
    startedAt: Date.now(),
    steps: [],
  };
  recordings.set(session.id, session);
  persistRecordings();
  return session;
}

export function getRecording(id: string): RecorderSession | undefined {
  return recordings.get(id);
}

export function addStep(id: string, kind: RecorderStep['kind'], text: string): RecorderSession | null {
  const session = recordings.get(id);
  if (!session) return null;
  const clean = redactSecretsInText(String(text)).trim().slice(0, 1000);
  if (!clean) return session;
  session.steps.push({ at: Date.now(), kind, text: clean });
  persistRecordings();
  return session;
}

/** Add lines the bot already did, skipping duplicates. */
export function importSteps(id: string, lines: string[]): RecorderSession | null {
  const session = recordings.get(id);
  if (!session) return null;
  const have = new Set(session.steps.map((step) => step.text));
  for (const line of lines) {
    const clean = redactSecretsInText(String(line)).trim().slice(0, 1000);
    if (!clean || have.has(clean)) continue;
    have.add(clean);
    session.steps.push({ at: Date.now(), kind: 'action', text: clean });
  }
  persistRecordings();
  return session;
}

export function removeStep(id: string, index: number): RecorderSession | null {
  const session = recordings.get(id);
  if (!session) return null;
  session.steps.splice(index, 1);
  persistRecordings();
  return session;
}

export function listRecordings(botId?: string): RecorderSession[] {
  return [...recordings.values()].filter((s) => !botId || s.botId === botId);
}

export function cancelRecording(id: string): void {
  recordings.delete(id);
  persistRecordings();
}

/** Render the recording as SKILL.md and stage it. Staged, never installed. */
export function finishRecording(id: string, summary: string): StagedSkill | null {
  const session = recordings.get(id);
  if (!session) return null;

  const actions = session.steps.filter((s) => s.kind === 'action');
  const notes = session.steps.filter((s) => s.kind === 'note');
  const checks = session.steps.filter((s) => s.kind === 'check');

  // A recording is made against one customer on one day. Lifting the literals it
  // captured into placeholders is what makes it worth running a second time.
  const { steps: parameterised, parameters } = parameterise(actions.map((s) => s.text));

  const body = [
    `# ${title(session.name)}`,
    '',
    summary.trim() || 'A recorded procedure.',
    ...renderParameters(parameters),
    '',
    '## Steps',
    '',
    ...parameterised.map((text, i) => `${i + 1}. ${text}`),
    ...(checks.length ? ['', '## Check your work', '', ...checks.map((s) => `- ${s.text}`)] : []),
    ...(notes.length ? ['', '## Notes', '', ...notes.map((s) => `- ${s.text}`)] : []),
    '',
  ].join('\n');

  const staged = stageSkill(session.botId, session.name, summary, body);
  recordings.delete(id);
  persistRecordings();
  return staged;
}

const title = (kebab: string): string => kebab.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
