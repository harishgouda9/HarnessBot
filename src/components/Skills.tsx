import { useEffect, useState } from 'react';
import { isValidSkillName, MAX_SKILL_NAME, slugifySkillName } from '../../shared/skill-name.ts';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { Avatar } from './Avatar.tsx';
import { Icon } from './Icons.tsx';
import { PageHeader } from './PageHeader.tsx';

/**
 * Skills: a library to adopt from, an installed list, and proposals waiting to be
 * confirmed. The digest is shown on every proposal, because the thing the user is
 * approving is a specific set of bytes, not a name.
 */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

interface SkillSummary {
  name: string;
  summary: string;
  sha256?: string;
  builtin?: boolean;
}

const SKILLS_SCOPE_KEY = 'hb.skills.scope';

interface SkillsData {
  library: SkillSummary[];
  installed: SkillSummary[];
  /** Staged bodies always ride along: they are the bytes the digest card is about. */
  staged: (SkillSummary & { sha256: string; body: string })[];
  /** Always sent: a bot's page has to show what it inherits from the workspace. */
  global: SkillSummary[];
  plugins: InstalledPlugin[];
}

function BotPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { state } = useStore();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg px-2 py-1 text-[12px]" style={inputStyle} aria-label="Bot">
      {state.bots
        .filter((b) => !b.hidden)
        .map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
    </select>
  );
}

const GLOBAL = 'global';

/**
 * Scope, not "bot". A skill installed globally reaches every bot in the workspace; a
 * skill installed on a bot reaches only that one and quietly wins over a global skill
 * of the same name. The picker is the first thing on the page because everything
 * below it means something different depending on which one is selected.
 */
function ScopePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { state } = useStore();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg px-2 py-1 text-[12px]" style={inputStyle} aria-label="Skill scope">
      <option value={GLOBAL}>Every bot (global)</option>
      <optgroup label="One bot only">
        {state.bots
          .filter((b) => !b.hidden)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
      </optgroup>
    </select>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {hint ? (
        <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {hint}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function SkillsPage() {
  const { state, dispatch } = useStore();
  const [scope, setScope] = useState<string>(() => {
    try {
      return sessionStorage.getItem(SKILLS_SCOPE_KEY) || GLOBAL;
    } catch {
      return GLOBAL;
    }
  });
  const [tab, setTab] = useState<'skills' | 'plugins'>('skills');
  const [data, setData] = useState<SkillsData>({ library: [], installed: [], staged: [], global: [], plugins: [] });
  const [preview, setPreview] = useState<{ name: string; body: string } | null>(null);
  const [error, setError] = useState('');
  const load = async (): Promise<void> => {
    setError('');
    try {
      const next = await api.get<Partial<SkillsData>>(`/api/skills?scope=${encodeURIComponent(scope)}`);
      // Every list defaulted. A harness running older code answers without `plugins`
      // or `global`, and reading `.length` off undefined took the whole page down —
      // a blank screen instead of a page that simply shows one section empty.
      setData({
        library: next.library ?? [],
        installed: next.installed ?? [],
        staged: next.staged ?? [],
        global: next.global ?? [],
        plugins: next.plugins ?? [],
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const isGlobal = scope === GLOBAL;
  const bot = state.bots.find((b) => b.id === scope);
  const scopeName = isGlobal ? 'every bot' : (bot?.name ?? 'this bot');

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  // Skills a bot gets from the workspace, minus anything it has overridden itself.
  const inherited = isGlobal ? [] : data.global.filter((g) => !data.installed.some((s) => s.name === g.name));

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <PageHeader title="Skills">
        <span className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--color-inset)' }}>
          {(['skills', 'plugins'] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              aria-pressed={tab === name}
              className="rounded-md px-2.5 py-1 text-[12px] capitalize"
              style={{
                background: tab === name ? 'var(--color-raised)' : 'transparent',
                color: tab === name ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
              }}
            >
              {name}
            </button>
          ))}
        </span>
        <ScopePicker value={scope} onChange={setScope} />
        {/* Always reachable. The page itself explains the switch when it is off —
            hiding the entrance is what made the feature look broken. */}
        <button
          type="button"
          onClick={() => dispatch({ type: 'view', view: 'recorder' })}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px]"
          style={{ background: 'var(--color-raised)' }}
        >
          <Icon name="record" size={13} />
          Teach a skill
        </button>
        <button type="button" onClick={() => dispatch({ type: 'view', view: 'chat' })} className="text-[12px]">
          Back
        </button>
      </PageHeader>

      {error ? (
        <div className="px-4 py-1.5 text-[12px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {!isGlobal && !bot ? (
          <div className="mt-16 text-center text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
            That bot is gone. Pick another scope, or install globally so every bot gets it.
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2 rounded-xl p-3" style={{ background: 'var(--color-panel)' }}>
              {isGlobal ? (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: 'var(--color-inset)', color: 'var(--color-accent)' }}>
                  <Icon name="apps" size={16} />
                </span>
              ) : (
                <Avatar name={bot!.name} color={bot!.color} avatarShape={bot!.avatarShape} size={28} />
              )}
              <div className="text-[13px]">
                {isGlobal ? (
                  <>
                    Installing here makes a skill available to <span className="font-semibold">every bot</span>, including
                    ones you create later.
                  </>
                ) : (
                  <>
                    Showing skills installed for <span className="font-semibold">{bot!.name}</span> only.
                  </>
                )}
              </div>
            </div>

            {tab === 'plugins' ? (
              <PluginsTab
                scope={scope}
                scopeName={scopeName}
                plugins={data.plugins}
                builtin={data.library.filter((skill) => skill.builtin)}
                onChanged={load}
              />
            ) : (
              <>
                {data.staged.length ? (
                  <section>
                    <h2 className="text-[13px] font-semibold">Waiting for you</h2>
                    <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      Nothing is installed until you confirm. If the bytes changed since the proposal, the
                      digest will not match and the card can only be discarded.
                    </p>
                    {data.staged.map((skill) => (
                      <div key={skill.name} className="card mt-2 p-3">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium">{skill.name}</div>
                            <div className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                              {skill.summary || 'No summary'}
                            </div>
                            <div className="mt-1 font-mono text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                              sha256 {skill.sha256.slice(0, 24)}…
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void act(() => api.post('/api/skills/reject', { scope, name: skill.name }))}
                            className="rounded-lg px-3 py-1 text-[12px]"
                            style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
                          >
                            Discard
                          </button>
                          {/* Read before install: the digest binds the card to bytes, and
                              bytes nobody opened are the ones worth opening. */}
                          <button
                            type="button"
                            onClick={() => setPreview({ name: skill.name, body: skill.body })}
                            className="rounded-lg px-3 py-1 text-[12px]"
                            style={{ background: 'var(--color-raised)' }}
                          >
                            Read
                          </button>
                          <button
                            type="button"
                            onClick={() => void act(() => api.post('/api/skills/confirm', { scope, name: skill.name, sha256: skill.sha256 }))}
                            className="rounded-lg px-3 py-1 text-[12px]"
                            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
                          >
                            Install
                          </button>
                        </div>
                      </div>
                    ))}
                  </section>
                ) : null}

                <Section title={isGlobal ? 'Installed for every bot' : `Installed for ${scopeName}`}>
                  {data.installed.length === 0 ? (
                    <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      None yet. Adopt one from the library, add a SKILL.md, or install a plugin.
                    </div>
                  ) : (
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {data.installed.map((skill) => (
                        <div key={skill.name} className="card flex items-start gap-2 p-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium">{skill.name}</div>
                            <div className="mt-0.5 line-clamp-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                              {skill.summary}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void act(() => api.del(`/api/skills/${skill.name}?scope=${encodeURIComponent(scope)}`))}
                            className="text-[12px]"
                            style={{ color: 'var(--color-danger)' }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                {inherited.length ? (
                  <Section
                    title="Inherited from every bot"
                    hint={`${bot?.name ?? 'This bot'} already has these because they are installed globally. Installing one here with the same name overrides it.`}
                  >
                    <div className="mt-2 flex flex-wrap gap-2">
                      {inherited.map((skill) => (
                        <span key={skill.name} className="card px-2.5 py-1.5 text-[12px]" title={skill.summary}>
                          {skill.name}
                        </span>
                      ))}
                    </div>
                  </Section>
                ) : null}

                <AddSkillCard scope={scope} scopeName={scopeName} onStaged={load} />

                <LibrarySection
                  title="Built-in"
                  hint="Pre-built skills. Computer use and the phone skill ship with HarnessBot — install one to give this scope the procedure. They are not recordings."
                  skills={data.library.filter((skill) => skill.builtin)}
                  installed={data.installed}
                  scope={scope}
                  badge="Pre-built"
                  onRead={(name, body) => setPreview({ name, body })}
                  onInstall={(name) => void act(() => api.post('/api/skills/install', { scope, name }))}
                />
                <LibrarySection
                  title="Library"
                  hint={`Other skills that ship with HarnessBot. Adopting one copies it into ${scopeName}.`}
                  skills={data.library.filter((skill) => !skill.builtin)}
                  installed={data.installed}
                  scope={scope}
                  onRead={(name, body) => setPreview({ name, body })}
                  onInstall={(name) => void act(() => api.post('/api/skills/install', { scope, name }))}
                />
              </>
            )}
          </>
        )}
      </div>

      {preview ? (
        <div className="fixed inset-0 z-40 grid place-items-center p-4" style={{ background: '#0009' }} onClick={() => setPreview(null)}>
          <div className="card anim-pop flex h-[min(640px,88vh)] w-[min(720px,96vw)] flex-col p-4" style={{ background: 'var(--color-panel)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[14px] font-semibold">{preview.name}</span>
              <button type="button" onClick={() => setPreview(null)} className="text-[12px]">
                Close
              </button>
            </div>
            <pre className="scroll-thin mt-3 flex-1 overflow-auto rounded-lg p-3 font-mono text-[12px] whitespace-pre-wrap" style={{ background: 'var(--color-inset)' }}>
              {preview.body}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Add a SKILL.md by hand: paste it, drop the file in, or point at a URL. All three
 * land in the same place — a staged proposal above, with its digest — because a file
 * off a disk and a file off the internet deserve the same read-before-install.
 */
function LibrarySection({
  title,
  hint,
  skills,
  installed,
  scope,
  badge,
  onRead,
  onInstall,
}: {
  title: string;
  hint: string;
  skills: SkillSummary[];
  installed: SkillSummary[];
  scope: string;
  badge?: string;
  onRead: (name: string, body: string) => void;
  onInstall: (name: string) => void;
}) {
  if (!skills.length) return null;
  return (
    <Section title={title} hint={hint}>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {skills.map((skill) => {
          const has = installed.some((item) => item.name === skill.name);
          return (
            <div key={skill.name} className="card p-3">
              <div className="flex items-center gap-2">
                <div className="text-[13px] font-medium">{skill.name}</div>
                {badge ? (
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: 'var(--color-inset)', color: 'var(--color-accent)' }}>
                    {badge}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {skill.summary}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const full = await api.get<{ library: (SkillSummary & { body?: string })[] }>(
                      `/api/skills?scope=${encodeURIComponent(scope)}&full=1`,
                    );
                    onRead(skill.name, full.library.find((item) => item.name === skill.name)?.body ?? skill.summary);
                  }}
                  className="rounded-lg px-2.5 py-1 text-[12px]"
                  style={{ background: 'var(--color-raised)' }}
                >
                  Read
                </button>
                <button
                  type="button"
                  disabled={has}
                  onClick={() => onInstall(skill.name)}
                  className="rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
                  style={{ background: has ? 'var(--color-raised)' : 'var(--color-accent)', color: has ? 'var(--color-ink)' : 'var(--color-accent-ink)' }}
                >
                  {has ? 'Installed' : 'Install'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function AddSkillCard({ scope, scopeName, onStaged }: { scope: string; scopeName: string; onStaged: () => Promise<void> }) {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const nameOk = !name || isValidSkillName(name);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const staged = await (mode === 'url'
        ? api.post<{ name: string }>('/api/skills/fetch', { scope, url: url.trim(), name: name || undefined })
        : api.post<{ name: string }>('/api/skills/add', { scope, name: name || undefined, body }));
      setDone(`“${staged.name}” is staged above. Read it, then install.`);
      setName('');
      setBody('');
      setUrl('');
      await onStaged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Add a SKILL.md" hint={`Paste one, pick a file, or fetch it from GitHub. It stages for ${scopeName} — nothing installs until you confirm the digest.`}>
      <div className="card mt-2 max-w-2xl p-3">
        <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--color-inset)', width: 'fit-content' }}>
          {(['file', 'url'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className="rounded-md px-2.5 py-1 text-[12px]"
              style={{ background: mode === m ? 'var(--color-raised)' : 'transparent', color: mode === m ? 'var(--color-ink)' : 'var(--color-ink-secondary)' }}
            >
              {m === 'file' ? 'Paste or upload' : 'From a URL'}
            </button>
          ))}
        </div>

        <input
          value={name}
          onChange={(e) => setName(slugifySkillName(e.target.value))}
          placeholder="Name (optional — taken from the file when it says one)"
          aria-invalid={!nameOk}
          className="mt-2 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
          style={inputStyle}
        />

        {mode === 'file' ? (
          <>
            <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px]" style={{ background: 'var(--color-raised)' }}>
              <Icon name="plus" size={12} />
              Choose a SKILL.md
              <input
                type="file"
                accept=".md,text/markdown,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBody(await file.text());
                  // The folder is gone by the time a browser hands us a file, so the
                  // filename is the only name hint left.
                  if (!name) setName(slugifySkillName(file.name.replace(/\.md$/i, '')));
                }}
              />
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder={'# My Skill\n\nWhat it is for, then the steps.'}
              className="mt-2 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
              style={inputStyle}
            />
          </>
        ) : (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/blob/main/skills/foo/SKILL.md"
            className="mt-2 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
            style={inputStyle}
          />
        )}

        {error ? (
          <div className="mt-2 text-[12px]" style={{ color: 'var(--color-danger)' }}>
            {error}
          </div>
        ) : null}
        {done ? (
          <div className="mt-2 text-[12px]" style={{ color: 'var(--color-success)' }}>
            {done}
          </div>
        ) : null}

        <button
          type="button"
          disabled={busy || !nameOk || (mode === 'url' ? !url.trim() : !body.trim())}
          onClick={() => void submit()}
          className="mt-3 rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
        >
          {busy ? 'Staging…' : 'Stage for review'}
        </button>
      </div>
    </Section>
  );
}

interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  source: string;
  scope: string;
  skills: string[];
  mcpServers: string[];
  installedAt: number;
}

interface PluginPlan {
  name: string;
  description: string;
  source: string;
  repo?: { owner: string; repo: string; ref: string; subPath: string };
  skills: { name: string; summary: string; path: string; sha256: string }[];
  mcpServers: { name: string; transport: string; command?: string; url?: string }[];
  warnings: string[];
}

/**
 * Plugins are two phase for the same reason team packages are: a repository off the
 * internet is untrusted input. Parsing shows everything the package would install —
 * every skill, every digest, every MCP server — and only the plan on screen is applied.
 */
function PluginsTab({
  scope,
  scopeName,
  plugins,
  builtin,
  onChanged,
}: {
  scope: string;
  scopeName: string;
  plugins: InstalledPlugin[];
  builtin: SkillSummary[];
  onChanged: () => Promise<void>;
}) {
  const [source, setSource] = useState('');
  const [plan, setPlan] = useState<PluginPlan | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);

  const guard = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      {builtin.length ? (
        <Section
          title="Built-in computer skills"
          hint={`These ship with HarnessBot. They are skills, not a plugin you have to fetch. Install them into ${scopeName} from here or from the Skills tab.`}
        >
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {builtin.map((skill) => (
              <div key={skill.name} className="card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{skill.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: 'var(--color-inset)', color: 'var(--color-accent)' }}>
                    Pre-built
                  </span>
                </div>
                <div className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {skill.summary}
                </div>
                <button
                  type="button"
                  onClick={() => void guard('install', async () => {
                    await api.post('/api/skills/install', { scope, name: skill.name });
                    await onChanged();
                  })}
                  className="mt-2 rounded-lg px-2.5 py-1 text-[12px]"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
                >
                  {busy === 'install' ? 'Installing…' : 'Install'}
                </button>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      <section>
        <h2 className="text-[13px] font-semibold">Install a plugin</h2>
        <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          A GitHub repo, <span className="font-mono">owner/repo</span>, or a link straight to one SKILL.md.
          Every skill it contains installs into {scopeName}; any MCP servers it declares arrive switched off.
        </p>

        <div className="mt-2 flex max-w-2xl gap-2">
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && source.trim()) void guard('parse', async () => setPlan(await api.post<PluginPlan>('/api/plugins/parse', { source: source.trim() })));
            }}
            placeholder="anthropics/skills  ·  https://github.com/owner/repo/tree/main/plugins/seo"
            className="min-w-0 flex-1 rounded-lg px-2 py-1.5 font-mono text-[12px]"
            style={inputStyle}
          />
          <button
            type="button"
            disabled={!source.trim() || busy !== ''}
            onClick={() => void guard('parse', async () => setPlan(await api.post<PluginPlan>('/api/plugins/parse', { source: source.trim() })))}
            className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            {busy === 'parse' ? 'Reading…' : 'Review'}
          </button>
        </div>

        {error ? (
          <div className="mt-2 text-[12px]" style={{ color: 'var(--color-danger)' }}>
            {error}
          </div>
        ) : null}

        {plan ? (
          <div className="card mt-3 max-w-2xl p-3">
            <div className="text-[14px] font-semibold">{plan.name}</div>
            <div className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {plan.description || plan.source}
              {plan.repo ? ` · ${plan.repo.ref}${plan.repo.subPath ? `/${plan.repo.subPath}` : ''}` : ''}
            </div>

            {plan.warnings.map((warning) => (
              <div key={warning} className="mt-2 text-[12px]" style={{ color: 'var(--color-warning)' }}>
                {warning}
              </div>
            ))}

            <div className="mt-3 text-[12px] font-medium">
              {plan.skills.length} skill{plan.skills.length === 1 ? '' : 's'}
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {plan.skills.map((skill) => (
                <div key={skill.path} className="rounded-lg px-2 py-1.5" style={{ background: 'var(--color-inset)' }}>
                  <div className="text-[12px] font-medium">{skill.name}</div>
                  <div className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                    {skill.summary || skill.path}
                  </div>
                  <div className="font-mono text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                    sha256 {skill.sha256.slice(0, 24)}…
                  </div>
                </div>
              ))}
            </div>

            {plan.mcpServers.length ? (
              <>
                <div className="mt-3 text-[12px] font-medium">
                  {plan.mcpServers.length} MCP server{plan.mcpServers.length === 1 ? '' : 's'} — added switched off
                </div>
                <div className="mt-1 flex flex-col gap-1">
                  {plan.mcpServers.map((server) => (
                    <div key={server.name} className="rounded-lg px-2 py-1.5 font-mono text-[11px]" style={{ background: 'var(--color-inset)' }}>
                      {server.name} · {server.transport === 'stdio' ? server.command : server.url}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setPlan(null)} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy !== '' || (plan.skills.length === 0 && plan.mcpServers.length === 0)}
                onClick={() =>
                  void guard('install', async () => {
                    const result = await api.post<{ notes: string[] }>('/api/plugins/install', { scope, plan });
                    setNotes(result.notes);
                    setPlan(null);
                    setSource('');
                    await onChanged();
                  })
                }
                className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
              >
                {busy === 'install' ? 'Installing…' : `Install into ${scopeName}`}
              </button>
            </div>
          </div>
        ) : null}

        {notes.map((note) => (
          <div key={note} className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {note}
          </div>
        ))}
      </section>

      <Section title="Installed plugins">
        {plugins.length === 0 ? (
          <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            None yet.
          </div>
        ) : (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {plugins.map((plugin) => (
              <div key={plugin.id} className="card p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{plugin.name}</div>
                    <div className="truncate font-mono text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      {plugin.source}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        await api.del(`/api/plugins/${plugin.id}`);
                        await onChanged();
                      })()
                    }
                    className="text-[12px]"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-1.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {plugin.scope === GLOBAL ? 'every bot' : 'one bot'} · {plugin.skills.length} skill
                  {plugin.skills.length === 1 ? '' : 's'}
                  {plugin.mcpServers.length ? ` · ${plugin.mcpServers.length} MCP` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

interface Recording {
  id: string;
  botId: string;
  name: string;
  startedAt: number;
  steps: { at: number; kind: 'action' | 'note' | 'check'; text: string }[];
}

/**
 * The recorder. It writes a draft, never an installed skill — finishing hands the
 * proposal to the Skills page, where the digest still has to be confirmed.
 */
export function SkillRecorderPage() {
  const { state, dispatch } = useStore();
  const [botId, setBotId] = useState(state.bots.find((b) => !b.hidden)?.id ?? '');
  const [name, setName] = useState('new-skill');
  const [session, setSession] = useState<Recording | null>(null);
  const [kind, setKind] = useState<'action' | 'note' | 'check'>('action');
  const [text, setText] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!botId) setBotId(state.bots.find((b) => !b.hidden)?.id ?? '');
  }, [state.bots, botId]);

  const nameOk = isValidSkillName(name);
  const canStart = nameOk && Boolean(botId);

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const addStep = (): void => {
    if (!session || !text.trim()) return;
    void guard(async () => {
      setSession(await api.post<Recording>(`/api/recordings/${session.id}/steps`, { kind, text }));
      setText('');
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <PageHeader title="Teach a skill">
        <button type="button" onClick={() => dispatch({ type: 'view', view: 'skills' })} className="text-[12px]">
          Back
        </button>
      </PageHeader>

      {error ? (
        <div className="px-4 py-1.5 text-[12px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {!session ? (
          <div className="mx-auto max-w-md">
            <h2 className="text-[14px] font-semibold">Start a recording</h2>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              Start a recording for one bot. HarnessBot copies that bot’s recent tool steps in, and
              you can add your own. Finish turns it into a draft on the Skills page — read it, then
              install it. Nothing is installed by recording alone.
            </p>
            <label className="mt-4 block text-[12px] font-medium">Bot</label>
            <div className="mt-1">
              <BotPicker value={botId} onChange={setBotId} />
            </div>
            <label htmlFor="skill-name" className="mt-3 block text-[12px] font-medium">
              Skill name
            </label>
            <input
              id="skill-name"
              value={name}
              /* Typed freely, corrected on the way in: the server only takes kebab-case
                 and a button that fails the POST is worse than one that never could. */
              onChange={(e) => setName(slugifySkillName(e.target.value))}
              placeholder="deploy-staging"
              aria-describedby="skill-name-hint"
              aria-invalid={name.length > 0 && !nameOk}
              className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[13px]"
              style={inputStyle}
            />
            <p id="skill-name-hint" className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: nameOk ? 'var(--color-success)' : 'var(--color-ink-secondary)' }}>
              {nameOk ? <Icon name="check" size={12} /> : null}
              {nameOk ? `“${name}” is a valid name.` : `kebab-case, max ${MAX_SKILL_NAME} characters. Spaces and capitals are converted as you type.`}
            </p>
            <button
              type="button"
              disabled={!canStart}
              onClick={() =>
                void guard(async () => {
                  setSession(await api.post<Recording>('/api/recordings', { botId, name }));
                })
              }
              className="mt-4 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              <Icon name="record" size={14} />
              Start recording
            </button>
            {/* A disabled button that will not say why is the bug people report as "it does not work". */}
            {canStart ? null : (
              <p className="mt-1.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {!botId ? 'Pick a bot to teach first.' : 'Type a name to start.'}
              </p>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="status-pulse h-2 w-2 rounded-full" style={{ background: 'var(--color-danger)' }} />
              <span className="text-[14px] font-semibold">{session.name}</span>
              <span className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {session.steps.length} step{session.steps.length === 1 ? '' : 's'}
              </span>
            </div>

            <ol className="mt-3 flex flex-col gap-1.5">
              {session.steps.map((step, index) => (
                <li key={index} className="flex items-start gap-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--color-inset)' }}>
                  <span
                    className="mt-0.5 rounded px-1.5 text-[10px]"
                    style={{
                      background: 'var(--color-raised)',
                      color: step.kind === 'check' ? 'var(--color-success)' : step.kind === 'note' ? 'var(--color-warning)' : 'var(--color-ink-secondary)',
                    }}
                  >
                    {step.kind}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px]">{step.text}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void guard(async () => setSession(await api.del<Recording>(`/api/recordings/${session.id}/steps/${index}`)))
                    }
                    className="text-[11px]"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ol>

            <div className="mt-3 flex gap-2">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
                <option value="action">Action</option>
                <option value="check">Check</option>
                <option value="note">Note</option>
              </select>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addStep();
                }}
                placeholder="Describe the step, then press Enter"
                className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[13px]"
                style={inputStyle}
              />
              <button
                type="button"
                disabled={!text.trim()}
                onClick={addStep}
                className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
                style={{ background: 'var(--color-raised)' }}
              >
                Add step
              </button>
            </div>
            <button
              type="button"
              onClick={() => void guard(async () => setSession(await api.post<Recording>(`/api/recordings/${session.id}/import`, {})))}
              className="mt-2 text-[12px] underline"
              style={{ color: 'var(--color-ink-secondary)' }}
            >
              Pull this bot’s recent tool steps
            </button>
            {session.steps.length === 0 ? (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                No steps yet. Run the task in chat first and pull them in, or type the procedure here.
              </p>
            ) : null}

            <label className="mt-5 block text-[12px] font-medium">Summary</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={2}
              placeholder="One line on what this skill is for."
              className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
              style={inputStyle}
            />

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void guard(async () => {
                    await api.del(`/api/recordings/${session.id}`);
                    setSession(null);
                  })
                }
                className="rounded-lg px-3 py-1.5 text-[13px]"
                style={{ background: 'var(--color-raised)' }}
              >
                Discard recording
              </button>
              <button
                type="button"
                disabled={session.steps.length === 0}
                onClick={() =>
                  void guard(async () => {
                    await api.post(`/api/recordings/${session.id}/finish`, { summary });
                    try {
                      sessionStorage.setItem(SKILLS_SCOPE_KEY, session.botId);
                    } catch {
                      /* private window */
                    }
                    setSession(null);
                    setName('new-skill');
                    setSummary('');
                    dispatch({ type: 'view', view: 'skills' });
                  })
                }
                className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
              >
                Finish and review draft
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
