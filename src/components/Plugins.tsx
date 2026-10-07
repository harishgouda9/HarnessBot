import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { Avatar } from './Avatar.tsx';
import { Icon } from './Icons.tsx';
import { McpServersPanel } from './McpServers.tsx';
import { PageHeader } from './PageHeader.tsx';

/**
 * Connected apps and MCP servers in one place, because from a bot's point of view
 * they are the same question: what can this bot reach outside the machine?
 *
 * OAuth stays with Composio. HarnessBot holds a project key and a list of which
 * toolkits are connected — never an app password.
 */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

interface Toolkit {
  slug: string;
  name: string;
  logo?: string;
  categories?: string[];
}

interface Connected {
  id: string;
  slug: string;
  label: string;
  connectedAt: number;
  /** `pending` means the OAuth tab is open and nobody has finished it yet. */
  status?: 'pending' | 'active' | 'failed';
}

const STATUS_TONE: Record<string, string> = {
  pending: 'var(--color-warning)',
  failed: 'var(--color-danger)',
  active: 'var(--color-success)',
};

/**
 * A grid of identical grey letters is the same as no icons at all. When Composio sends
 * a logo we use it; otherwise the tile is a monogram tinted from the slug, so every app
 * still gets a stable, distinguishable mark instead of a blank square.
 */
const TILE_TINTS = ['#1084fe', '#2fa06a', '#e0742a', '#8a5cf6', '#12a5c4', '#e055a0', '#d1a017', '#11897f', '#e0685c', '#e0453f'];

function tintFor(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return TILE_TINTS[hash % TILE_TINTS.length]!;
}

function AppTile({ toolkit, size = 36 }: { toolkit: Toolkit; size?: number }) {
  const [broken, setBroken] = useState(false);
  const tint = tintFor(toolkit.slug);

  if (toolkit.logo && !broken) {
    return (
      <img
        src={toolkit.logo}
        alt=""
        width={size}
        height={size}
        // A dead logo URL must fall back to the monogram, not leave a hole.
        onError={() => setBroken(true)}
        className="shrink-0 rounded-lg object-contain"
        style={{ width: size, height: size, background: 'var(--color-raised)', padding: 4 }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-lg font-semibold"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${tint} 18%, var(--color-inset))`,
        color: tint,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {toolkit.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PluginsPanel() {
  const { state, dispatch, refreshConfig, refreshBots } = useStore();
  const [tab, setTab] = useState<'apps' | 'mcp'>('apps');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<Toolkit[]>([]);
  const [connected, setConnected] = useState<Connected[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  /** Kept apart from `error`: one is a failed connect, the other a page that never loaded. */
  const [loadError, setLoadError] = useState('');

  /**
   * Settled, not `all`. These are two independent questions — what exists, and what
   * you have connected — and one of them failing used to reject the whole load. The
   * caller then did `void load()`, so the rejection was unhandled, the marketplace
   * stayed empty, and the page looked broken without saying a word.
   */
  const load = async (): Promise<void> => {
    const [list, status] = await Promise.allSettled([
      api.get<Toolkit[]>(`/api/connectors/catalog?q=${encodeURIComponent(query)}`),
      api.get<{ configured: boolean; connected: Connected[] }>('/api/connectors'),
    ]);

    if (list.status === 'fulfilled') setCatalog(list.value);
    if (status.status === 'fulfilled') {
      setConnected(status.value.connected ?? []);
      setConfigured(status.value.configured);
    }

    const failed = [list, status].find((r) => r.status === 'rejected');
    setLoadError(failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '');
  };

  useEffect(() => {
    const timer = setTimeout(() => void load(), 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // OAuth finishes in another tab. Coming back to this window is the only signal we
  // get that it is worth asking Composio whether the account settled.
  useEffect(() => {
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const connectedSlugs = useMemo(
    () => new Set(connected.filter((c) => (c.status ?? 'active') === 'active').map((c) => c.slug)),
    [connected],
  );
  const bots = state.bots.filter((b) => !b.hidden);

  const connect = async (slug: string): Promise<void> => {
    setBusy(slug);
    setError('');
    try {
      const result = await api.post<{ redirectUrl?: string }>('/api/connectors/authorize', { slug });
      if (result.redirectUrl) window.open(result.redirectUrl, '_blank', 'noopener');
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <PageHeader title="Connected apps">
        <span className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--color-inset)' }}>
          {(['apps', 'mcp'] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              aria-pressed={tab === name}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]"
              style={{
                background: tab === name ? 'var(--color-raised)' : 'transparent',
                color: tab === name ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
              }}
            >
              <Icon name={name === 'apps' ? 'apps' : 'server'} size={13} />
              {name === 'apps' ? 'Marketplace' : 'MCP servers'}
            </button>
          ))}
        </span>
        {tab === 'apps' ? (
          <span className="relative flex items-center">
            <span className="pointer-events-none absolute left-2" style={{ color: 'var(--color-ink-secondary)' }}>
              <Icon name="search" size={13} />
            </span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps" aria-label="Search apps" className="rounded-lg py-1 pr-2 pl-7 text-[12px]" style={inputStyle} />
          </span>
        ) : null}
        <button type="button" onClick={() => dispatch({ type: 'view', view: 'chat' })} className="flex items-center gap-1 text-[12px]">
          <Icon name="chevronLeft" size={13} />
          Back
        </button>
      </PageHeader>

      {error || loadError ? (
        <div className="flex items-start gap-2 px-4 py-1.5 text-[12px]" style={{ color: 'var(--color-danger)' }}>
          <span className="min-w-0 flex-1 break-words">{error || `Could not load: ${loadError}`}</span>
          <button type="button" onClick={() => void load()} className="shrink-0 underline">
            Retry
          </button>
        </div>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto p-4">
        {tab === 'apps' ? (
          <>
            {!configured ? (
              <div className="card mb-4 p-3">
                <div className="text-[13px] font-medium" style={{ color: 'var(--color-warning)' }}>
                  No Composio key yet
                </div>
                <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  You can browse here, but connecting an account needs a Composio project key. OAuth
                  happens at Composio — HarnessBot never sees your Gmail password.
                </div>
              </div>
            ) : null}

            {connected.length ? (
              <section className="mb-6">
                <h2 className="text-[13px] font-semibold">Connected accounts</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {connected.map((account) => (
                    <div key={account.id} className="card flex items-center gap-2 px-3 py-2">
                      <AppTile toolkit={{ slug: account.slug, name: account.label }} size={22} />
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_TONE[account.status ?? 'active'] }} />
                      <span className="text-[13px]">{account.label}</span>
                      {(account.status ?? 'active') !== 'active' ? (
                        <span className="text-[11px]" style={{ color: STATUS_TONE[account.status!] }}>
                          {account.status === 'pending' ? 'finish sign-in in your browser' : 'sign-in failed'}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={async () => {
                          await api.del(`/api/connectors/${account.id}`);
                          await load();
                        }}
                        className="text-[11px]"
                        style={{ color: 'var(--color-danger)' }}
                      >
                        disconnect
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <h2 className="text-[13px] font-semibold">Marketplace</h2>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {catalog.map((toolkit) => {
                  const isConnected = connectedSlugs.has(toolkit.slug);
                  return (
                    <div
                      key={toolkit.slug}
                      className="card flex items-center gap-3 p-3"
                      style={isConnected ? { borderColor: 'var(--color-accent-border)' } : undefined}
                    >
                      <AppTile toolkit={toolkit} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{toolkit.name}</div>
                        <div className="flex items-center gap-1 truncate text-[11px]" style={{ color: isConnected ? 'var(--color-success)' : 'var(--color-ink-secondary)' }}>
                          {isConnected ? <Icon name="check" size={11} /> : null}
                          {isConnected ? 'Connected' : (toolkit.categories?.join(', ') ?? toolkit.slug)}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy === toolkit.slug}
                        onClick={() => void connect(toolkit.slug)}
                        aria-label={isConnected ? `Add another ${toolkit.name} account` : `Connect ${toolkit.name}`}
                        className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
                        style={
                          isConnected
                            ? { background: 'var(--color-raised)' }
                            : { background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }
                        }
                      >
                        {busy === toolkit.slug ? '…' : <Icon name="plus" size={12} />}
                        {busy === toolkit.slug ? '' : isConnected ? 'Add account' : 'Connect'}
                      </button>
                    </div>
                  );
                })}
              </div>
              {catalog.length === 0 ? (
                <div className="mt-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  Nothing matched that search.
                </div>
              ) : null}
            </section>

            <section className="mt-6">
              <h2 className="text-[13px] font-semibold">Who can use connected apps</h2>
              <p className="mt-0.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Each bot has its own switch. Members created by a team import start with it off, and
                turning it on is your decision, not the package's.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {bots.map((bot) => (
                  <label key={bot.id} className="card flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                    <input
                      type="checkbox"
                      checked={bot.composio !== false}
                      onChange={async (e) => {
                        await api.patch(`/api/bots/${bot.id}`, { composio: e.target.checked });
                        await refreshBots();
                      }}
                    />
                    <Avatar name={bot.name} color={bot.color} avatarShape={bot.avatarShape} size={20} />
                    {bot.name}
                  </label>
                ))}
              </div>
            </section>
          </>
        ) : (
          <McpServersPanel onChanged={refreshConfig} servers={state.config?.mcpServers ?? []} />
        )}
      </div>
    </div>
  );
}
