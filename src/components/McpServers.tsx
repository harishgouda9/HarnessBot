import { useState } from 'react';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { Icon } from './Icons.tsx';

/**
 * Custom MCP servers. One editor, used from Settings and from Connected apps, so
 * "add a server" is not a different form depending on which door you came through.
 */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

export interface McpServerRow {
  name: string;
  enabled: boolean;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return Object.keys(out).length ? out : undefined;
}

function slugName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function McpServersPanel({
  servers,
  onChanged,
  showBotToggles = true,
}: {
  servers: McpServerRow[];
  onChanged: () => Promise<void>;
  showBotToggles?: boolean;
}) {
  const { state, refreshBots } = useStore();
  const bots = state.bots.filter((b) => !b.hidden);
  const [draft, setDraft] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(servers.length === 0);

  const hermes = servers.filter((s) => s.name.startsWith('hermes/'));
  const custom = servers.filter((s) => !s.name.startsWith('hermes/'));

  const add = async (): Promise<void> => {
    const name = slugName(draft.name);
    if (!name) {
      setError('Name is required.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await api.post('/api/mcp-servers', {
        name,
        transport: draft.transport,
        command: draft.command.trim() || undefined,
        args: draft.args.trim() ? draft.args.trim().split(/\s+/) : undefined,
        url: draft.url.trim() || undefined,
        env: parseEnv(draft.env),
      });
      setDraft({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' });
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    Boolean(draft.name.trim()) &&
    (draft.transport === 'stdio' ? Boolean(draft.command.trim()) : Boolean(draft.url.trim()));

  return (
    <>
      <p className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Mounted without any pre-approval. Tools still go through the same permission cards, so
        adding a server grants it nothing on its own.
      </p>

      {hermes.length ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold tracking-wide uppercase" style={{ color: 'var(--color-ink-secondary)' }}>
            From Hermes
          </div>
          {hermes.map((server) => (
            <ServerRow key={server.name} server={server} fromHost onChanged={onChanged} />
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-1 text-[11px] font-semibold tracking-wide uppercase" style={{ color: 'var(--color-ink-secondary)' }}>
          Custom
        </div>
        {custom.length ? (
          custom.map((server) => <ServerRow key={server.name} server={server} onChanged={onChanged} />)
        ) : (
          <div className="mb-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            No custom servers yet. Add one below — stdio, HTTP, or SSE.
          </div>
        )}
      </div>

      {open ? (
        <div className="card mt-3 p-3">
          <div className="text-[13px] font-medium">Add a custom MCP server</div>
          {error ? (
            <div className="mt-1 text-[12px]" style={{ color: 'var(--color-danger)' }}>
              {error}
            </div>
          ) : (
            <p className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              A command on this machine, or a URL. The name is how bots will see it.
            </p>
          )}
          <label className="mt-2 block text-[12px] font-medium" htmlFor="mcp-name">
            Name
          </label>
          <input
            id="mcp-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="playwright"
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
            style={inputStyle}
          />
          {draft.name.trim() && slugName(draft.name) !== draft.name.trim() ? (
            <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              id: {slugName(draft.name)}
            </p>
          ) : null}

          <label className="mt-2 block text-[12px] font-medium" htmlFor="mcp-transport">
            Transport
          </label>
          <select
            id="mcp-transport"
            value={draft.transport}
            onChange={(e) => setDraft({ ...draft, transport: e.target.value })}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <option value="stdio">stdio — a command on this machine</option>
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
          </select>

          {draft.transport === 'stdio' ? (
            <>
              <label className="mt-2 block text-[12px] font-medium" htmlFor="mcp-command">
                Command
              </label>
              <input
                id="mcp-command"
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder="npx"
                className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
                style={inputStyle}
              />
              <label className="mt-2 block text-[12px] font-medium" htmlFor="mcp-args">
                Arguments
              </label>
              <input
                id="mcp-args"
                value={draft.args}
                onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                placeholder="-y @playwright/mcp"
                className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
                style={inputStyle}
              />
              <label className="mt-2 block text-[12px] font-medium" htmlFor="mcp-env">
                Environment (optional)
              </label>
              <textarea
                id="mcp-env"
                value={draft.env}
                onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                placeholder={'API_KEY=…\nONE_VAR_PER_LINE=1'}
                rows={2}
                className="mt-1 w-full resize-y rounded-lg px-2 py-1.5 font-mono text-[12px]"
                style={inputStyle}
              />
            </>
          ) : (
            <>
              <label className="mt-2 block text-[12px] font-medium" htmlFor="mcp-url">
                URL
              </label>
              <input
                id="mcp-url"
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://…"
                className="mt-1 w-full rounded-lg px-2 py-1.5 font-mono text-[12px]"
                style={inputStyle}
              />
            </>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-[13px]" style={{ background: 'var(--color-raised)' }}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void add()}
              className="rounded-lg px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            >
              {busy ? 'Adding…' : 'Add server'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px]"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
        >
          <Icon name="plus" size={13} />
          Add custom MCP server
        </button>
      )}

      {showBotToggles && bots.length ? (
        <section className="mt-5">
          <h3 className="text-[13px] font-semibold">Who can use custom MCP</h3>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Each bot has its own switch. Off means this list is not mounted for that bot.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {bots.map((bot) => (
              <label key={bot.id} className="card flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                <input
                  type="checkbox"
                  checked={bot.customMcp !== false}
                  onChange={async (e) => {
                    await api.patch(`/api/bots/${bot.id}`, { customMcp: e.target.checked });
                    await refreshBots();
                  }}
                />
                {bot.name}
              </label>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function ServerRow({
  server,
  fromHost,
  onChanged,
}: {
  server: McpServerRow;
  fromHost?: boolean;
  onChanged: () => Promise<void>;
}) {
  const detail = server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : server.url;
  return (
    <div className="card mb-2 flex items-center gap-2 p-3">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: server.enabled ? 'var(--color-success)' : 'var(--color-ink-secondary)' }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{server.name}</span>
          {fromHost ? (
            <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
              Hermes
            </span>
          ) : null}
        </div>
        <div className="truncate font-mono text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          {server.transport}
          {detail ? ` · ${detail}` : ''}
        </div>
      </div>
      <input
        type="checkbox"
        checked={server.enabled}
        aria-label={`Enable ${server.name}`}
        onChange={async (e) => {
          await api.patch(`/api/mcp-servers/${encodeURIComponent(server.name)}`, { enabled: e.target.checked });
          await onChanged();
        }}
      />
      {fromHost ? null : (
        <button
          type="button"
          onClick={async () => {
            await api.del(`/api/mcp-servers/${encodeURIComponent(server.name)}`);
            await onChanged();
          }}
          className="text-[11px]"
          style={{ color: 'var(--color-danger)' }}
          aria-label={`Remove ${server.name}`}
        >
          Remove
        </button>
      )}
    </div>
  );
}
