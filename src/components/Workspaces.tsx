import { useEffect, useRef, useState } from 'react';
import type { BotRecord } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { Avatar } from './Avatar.tsx';

/**
 * Expanded computer workspaces: take over a Local VM desktop or the built-in browser
 * in the centre column instead of squinting at the side panel preview.
 *
 * Preview and control stay visibly different here. Watching frames arrive is not
 * permission to click, and the page says so rather than implying it.
 */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

interface VmState {
  runtime: 'docker' | 'podman' | null;
  available: boolean;
  reason?: string;
  image: string;
  mode: 'shared' | 'per-bot';
  maxInstances: number;
  containers: { name: string; status: string; running: boolean; image: string; botId?: string; viewerUrl?: string }[];
  width: number;
  height: number;
}

function WorkspaceHeader({
  title,
  subtitle,
  bot,
  children,
}: {
  title: string;
  subtitle?: string;
  bot: BotRecord;
  children?: React.ReactNode;
}) {
  const { dispatch } = useStore();
  return (
    <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2 hairline" style={{ background: 'var(--color-panel)' }}>
      <Avatar name={bot.name} color={bot.color} activity={bot.activity} size={26} />
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold">{title}</div>
        {subtitle ? (
          <div className="truncate text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {subtitle}
          </div>
        ) : null}
      </div>
      <span className="flex-1" />
      {children}
      <button type="button" onClick={() => dispatch({ type: 'drawer', botId: bot.id })} className="rounded-lg px-2 py-1 text-[12px]" style={{ background: 'var(--color-raised)' }}>
        Chat
      </button>
      <button type="button" onClick={() => dispatch({ type: 'view', view: 'chat' })} className="text-[12px]">
        Back
      </button>
    </header>
  );
}

export function LocalVmWorkspace({ bot }: { bot: BotRecord }) {
  const { state } = useStore();
  const [vm, setVm] = useState<VmState | null>(null);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState('');
  const [live, setLive] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const frame = state.screens[bot.id];

  const refresh = async (): Promise<void> => setVm(await api.get<VmState>('/api/local-vm'));

  useEffect(() => {
    void refresh();
  }, []);

  // Polling for frames is the honest model here: the container has no push channel,
  // and a 1.5s cadence is enough to watch without pinning a CPU core.
  useEffect(() => {
    if (!live) return;
    const tick = (): void => {
      void api.post(`/api/bots/${bot.id}/local-vm/screenshot`).catch(() => setLive(false));
    };
    tick();
    timer.current = window.setInterval(tick, 1500);
    return () => window.clearInterval(timer.current);
  }, [live, bot.id]);

  const act = async (action: 'start' | 'stop' | 'remove' | 'screenshot'): Promise<void> => {
    setBusy(action);
    try {
      const result = await api.post<{ ok: boolean; reason?: string }>(`/api/bots/${bot.id}/local-vm/${action}`);
      if (!result.ok && result.reason) setLog(result.reason);
      else setLog('');
      await refresh();
    } finally {
      setBusy('');
    }
  };

  /*
   * Match on the label the container was started with. The old check was
   * `name.includes(mode === 'per-bot' ? '' : 'shared')`, and `.includes('')` is always
   * true — so in per-bot mode every bot showed the first container's state.
   */
  const container = vm?.containers.find((c) => (vm.mode === 'per-bot' ? c.botId === bot.id : c.name.endsWith('shared')));
  const running = container?.running === true;

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <WorkspaceHeader
        title="Local VM"
        subtitle={vm ? `${vm.runtime ?? 'no runtime'} · ${vm.mode} · ${vm.width}×${vm.height} · max ${vm.maxInstances}` : 'checking…'}
        bot={bot}
      >
        <button
          type="button"
          disabled={!vm?.available || busy !== ''}
          onClick={() => void act(running ? 'stop' : 'start')}
          className="rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
          style={{ background: running ? 'var(--color-raised)' : 'var(--color-accent)', color: running ? 'var(--color-ink)' : 'var(--color-accent-ink)' }}
        >
          {busy === 'start' || busy === 'stop' ? '…' : running ? 'Stop' : 'Start desktop'}
        </button>
        {/* The polled preview is a picture. The viewer is the desktop — same container,
            over its own loopback noVNC port. */}
        {running && container?.viewerUrl ? (
          <a
            href={container.viewerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-2.5 py-1 text-[12px]"
            style={{ background: 'var(--color-raised)' }}
          >
            Open desktop
          </a>
        ) : null}
        <button
          type="button"
          disabled={!running}
          onClick={() => setLive(!live)}
          className="rounded-lg px-2.5 py-1 text-[12px] disabled:opacity-40"
          style={{ background: live ? 'var(--color-accent)' : 'var(--color-raised)', color: live ? 'var(--color-accent-ink)' : 'var(--color-ink)' }}
        >
          {live ? 'Stop preview' : 'Live preview'}
        </button>
      </WorkspaceHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center p-4">
          {!vm?.available ? (
            <div className="max-w-md text-center">
              <div className="text-[15px] font-semibold">No container runtime</div>
              <div className="mt-1 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {vm?.reason ?? 'Checking for Docker or Podman…'}
              </div>
            </div>
          ) : frame ? (
            <figure className="flex max-h-full max-w-full flex-col items-center">
              <img
                src={`data:${frame.mime};base64,${frame.png}`}
                alt="Local VM desktop"
                className="max-h-[calc(100vh-220px)] max-w-full rounded-xl"
                style={{ border: '1px solid var(--color-hairline)' }}
              />
              <figcaption className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Preview only — {new Date(frame.at).toLocaleTimeString()}. Watching is not permission to click.
              </figcaption>
            </figure>
          ) : (
            <div
              className="grid aspect-video w-full max-w-3xl place-items-center rounded-xl text-[13px]"
              style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}
            >
              {running ? 'Start the live preview to see the desktop.' : 'The desktop is not running.'}
            </div>
          )}
        </div>

        <aside className="w-[280px] shrink-0 overflow-y-auto border-l p-3 hairline scroll-thin" style={{ background: 'var(--color-panel)' }}>
          <div className="text-[13px] font-semibold">Containers</div>
          {vm?.containers.length ? (
            vm.containers.map((c) => (
              <div key={c.name} className="mt-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--color-inset)' }}>
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.running ? 'var(--color-success)' : 'var(--color-ink-secondary)' }} />
                  <span className="truncate text-[12px] font-medium">{c.name}</span>
                </div>
                <div className="truncate text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {c.status}
                </div>
              </div>
            ))
          ) : (
            <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              None yet.
            </div>
          )}

          <div className="mt-4 text-[13px] font-semibold">Image</div>
          <div className="mt-1 font-mono text-[11px] break-all" style={{ color: 'var(--color-ink-secondary)' }}>
            {vm?.image}
          </div>
          <button
            type="button"
            disabled={!vm?.available || busy !== ''}
            onClick={async () => {
              setBusy('pull');
              const result = await api.post<{ ok: boolean; output: string }>('/api/local-vm/pull');
              setLog(result.output);
              setBusy('');
              await refresh();
            }}
            className="mt-2 w-full rounded-lg px-2 py-1.5 text-[12px] disabled:opacity-40"
            style={{ background: 'var(--color-raised)' }}
          >
            {busy === 'pull' ? 'Pulling…' : 'Pull image'}
          </button>

          <div className="mt-4 rounded-lg p-2 text-[11px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            The workspace folder is mounted durably. The container itself is disposable — anything
            you leave outside <code className="font-mono">/home/harness/workspace</code> goes when it does.
          </div>

          <button
            type="button"
            disabled={!vm?.available || busy !== ''}
            onClick={() => void act('remove')}
            className="mt-3 w-full rounded-lg px-2 py-1.5 text-[12px] disabled:opacity-40"
            style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
          >
            Remove container
          </button>

          {log ? (
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg p-2 font-mono text-[10px] whitespace-pre-wrap" style={{ background: 'var(--color-inset)' }}>
              {log}
            </pre>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

export function BrowserWorkspace({ bot }: { bot: BotRecord }) {
  const { state } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const [profileId, setProfileId] = useState(bot.browserProfile ?? 'default');
  const [info, setInfo] = useState<{ available: boolean; reason?: string } | null>(null);
  const [address, setAddress] = useState('');

  const tab = state.browserTabs[`${bot.id}:${profileId}`];

  useEffect(() => {
    void api.get<{ available: boolean; reason?: string }>(`/api/bots/${bot.id}/browser?profile=${profileId}`).then(setInfo);
  }, [bot.id, profileId]);

  useEffect(() => {
    if (tab?.url) setAddress(tab.url);
  }, [tab?.url]);

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <WorkspaceHeader title="Browser" subtitle={tab?.title || 'No page open'} bot={bot}>
        <select
          value={profileId}
          onChange={async (e) => {
            setProfileId(e.target.value);
            await api.patch(`/api/bots/${bot.id}`, { browserProfile: e.target.value });
          }}
          className="rounded-lg px-2 py-1 text-[12px]"
          style={inputStyle}
          aria-label="Browser profile"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </WorkspaceHeader>

      <div className="flex items-center gap-2 border-b px-3 py-1.5 hairline" style={{ background: 'var(--color-panel)' }}>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !address.trim()) return;
            const url = /^https?:\/\//.test(address) ? address : `https://${address}`;
            await api.post(`/api/bots/${bot.id}/browser/tab`, { profileId, url, title: url, loading: true });
          }}
          placeholder="Type a URL and press Enter"
          className="min-w-0 flex-1 rounded-lg px-2 py-1 font-mono text-[12px]"
          style={inputStyle}
        />
        {tab?.loading ? (
          <span className="status-pulse text-[11px]" style={{ color: 'var(--color-accent)' }}>
            loading
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="grid min-w-0 flex-1 place-items-center p-4">
          <div className="max-w-lg text-center">
            {info?.available ? (
              <>
                <div className="text-[15px] font-semibold">{tab?.title || 'Nothing open yet'}</div>
                <div className="mt-1 font-mono text-[12px] break-all" style={{ color: 'var(--color-ink-secondary)' }}>
                  {tab?.url || 'Type a URL above, or let the bot navigate.'}
                </div>
                <div className="mt-4 rounded-xl p-4 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                  The page itself renders in the desktop shell's own view, layered over this area — the
                  renderer never gets to script it, which is the point.
                </div>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold">Browser unavailable</div>
                <div className="mt-1 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {info?.reason ?? 'Checking…'}
                </div>
              </>
            )}
          </div>
        </div>

        <aside className="w-[280px] shrink-0 border-l p-3 hairline" style={{ background: 'var(--color-panel)' }}>
          <div className="text-[13px] font-semibold">Profile</div>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Bots sharing a profile share its cookies and logins. Give a bot its own profile when it
            should not see another one's session. <code className="font-mono">guest</code> is reserved
            as a throwaway.
          </p>

          <label className="mt-4 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={bot.browser !== false}
              onChange={(e) => void api.patch(`/api/bots/${bot.id}`, { browser: e.target.checked })}
            />
            Let this bot use the browser
          </label>

          {tab ? (
            <button
              type="button"
              onClick={() => void api.del(`/api/bots/${bot.id}/browser/tab?profile=${profileId}`)}
              className="mt-4 w-full rounded-lg px-2 py-1.5 text-[12px]"
              style={{ background: 'var(--color-raised)' }}
            >
              Close tab
            </button>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
