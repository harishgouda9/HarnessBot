import { useCallback, useEffect, useState } from 'react';
import { activityBeats } from '../../shared/activity.ts';
import type { ActivityBeat } from '../../shared/types.ts';
import { AVATAR_SHAPES, AVATAR_SHAPE_LABELS, BOT_COLORS, type BotRecord, type ComputerPlacement, type HarnessbotColor, type MemoryEntry } from '../../shared/types.ts';
import { api, uploadAttachment } from '../api.ts';
import { approvalPost, phoneGateAfterApprove, phoneGateAfterAsk, type PhoneGate } from '../phone-gate.ts';
import { useStreaming, useTrace } from '../stream-store.ts';
import { snapshotFor, useStore } from '../store.tsx';
import { Avatar, botColor } from './Avatar.tsx';
import { Icon } from './Icons.tsx';
import { BotJobs } from './Jobs.tsx';
import { EngineRow } from './Overlays.tsx';

/**
 * The right rail: hands, internals, and per-bot settings. Mutually exclusive with each
 * other, because three simultaneous side panels is an IDE, not a messenger.
 */

const Row = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block px-3 py-2">
    <span className="block text-[12px] font-medium">{label}</span>
    {hint ? (
      <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {hint}
      </span>
    ) : null}
    <span className="mt-1 block">{children}</span>
  </label>
);

const input = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Commands, exit codes, and files for the open task. Paths and sizes only. */
function ActivityStrip({ threadId }: { threadId: string }) {
  const { state } = useStore();
  const [remote, setRemote] = useState<ActivityBeat[] | null>(null);
  const local = activityBeats(state.threads[threadId]?.messages ?? []);
  const mark = (state.threads[threadId]?.messages.length ?? 0) + (state.threads[threadId]?.messages.at(-1)?.at ?? 0);

  useEffect(() => {
    let gone = false;
    void api
      .get<ActivityBeat[]>(`/api/threads/${threadId}/activity`)
      .then((beats) => {
        if (!gone) setRemote(beats);
      })
      .catch(() => {
        if (!gone) setRemote(null);
      });
    return () => {
      gone = true;
    };
  }, [threadId, mark]);

  const shown = (remote ?? local).slice(-12).reverse();
  return (
    <div className="mx-3 mt-3">
      <div className="text-[12px] font-medium">This task</div>
      <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Commands, exit codes, and files. A file shows its path and size. The decision log is the record that lasts.
      </p>
      {shown.length === 0 ? (
        <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          No commands or files in this task yet.
        </div>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {shown.map((beat, index) => (
            <li key={`${beat.at}:${index}`} className="rounded-lg px-2 py-1 text-[11px]" style={{ background: 'var(--color-inset)' }}>
              <span className="font-mono">{beat.tool}</span>
              {beat.exitCode !== undefined ? (
                <span style={{ color: beat.exitCode === 0 ? 'var(--color-success)' : 'var(--color-danger)' }}> · exit {beat.exitCode}</span>
              ) : null}
              {beat.path ? <span className="mt-0.5 block truncate">{beat.path}{beat.bytes !== undefined ? ` · ${formatBytes(beat.bytes)}` : ''}</span> : null}
              {beat.command ? <span className="mt-0.5 block truncate">{beat.command}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

interface PlacementInfo {
  placement: { placement: string; backend?: string; available: boolean; reason?: string };
  hostControl: { supported: boolean; enabled: boolean; session: string; reason?: string };
  held: boolean;
}

interface HostSummary {
  platform: string;
  session: string;
  maxActions: number;
  dockerAvailable: boolean;
  hostScreenServer?: string | null;
  hermes?: boolean;
}

/** Placement is a choice with consequences, so each option states its own. */
export const PLACEMENTS: { value: ComputerPlacement | ''; title: string; body: string }[] = [
  { value: '', title: 'Auto', body: 'Reuse a backend that is already set up. Never reaches for this desktop on its own.' },
  { value: 'cloud', title: 'Cloud desktop', body: 'An isolated Linux desktop at Box, or your own VPS. Nothing touches this machine.' },
  { value: 'vm', title: 'Local VM', body: 'A container on this machine via Docker or Podman. Isolated, with a durable workspace folder.' },
  { value: 'local', title: 'This computer', body: 'Your real screen, keyboard and mouse. Requires an explicit opt-in per bot.' },
  { value: 'off', title: 'Off', body: 'No desktop at all. The bot can still use the shell in its folder, apps, and MCP tools.' },
];

export function ComputerPanel({ bot, onClose }: { bot: BotRecord; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const snapshot = snapshotFor(state, bot);
  const [info, setInfo] = useState<PlacementInfo | null>(null);
  const [host, setHost] = useState<HostSummary | null>(null);
  const [tab, setTab] = useState<'computer' | 'phone' | 'browser'>('computer');
  const [token, setToken] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const frame = state.screens[bot.id];
  // Hermes does not click by itself. The panel still places a desktop, and the harness
  // mounts that desktop into the Hermes session.
  const canComputer = snapshot?.capabilities.computerMcp === true || snapshot?.driver === 'hermes';

  const refresh = async (): Promise<void> => {
    const [placement, summary] = await Promise.all([
      api.get<PlacementInfo>(`/api/bots/${bot.id}/computer`),
      api.get<HostSummary>('/api/local-computer'),
    ]);
    setInfo(placement);
    setHost(summary);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.computer, bot.cloudBackend]);

  useEffect(() => {
    if (!live) return;
    const tick =
      bot.computer === 'vm'
        ? (): Promise<void> => api.post(`/api/bots/${bot.id}/local-vm/screenshot`).then(() => undefined)
        : bot.computer === 'local'
          ? (): Promise<void> => api.post(`/api/bots/${bot.id}/computer/preview`).then(() => undefined)
          : null;
    if (!tick) return;
    const run = (): void => void tick().catch(() => setLive(false));
    run();
    const timer = window.setInterval(run, 2000);
    return () => window.clearInterval(timer);
  }, [live, bot.id, bot.computer]);

  return (
    <aside className="anim-panel flex w-[360px] shrink-0 flex-col border-l hairline" style={{ background: 'var(--color-panel)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2 hairline">
        <span className="flex-1 text-[13px] font-semibold">Computer</span>
        <button type="button" onClick={onClose} className="text-[12px]">
          Close
        </button>
      </header>

      <div className="flex gap-1 px-3 pt-2">
        {(['computer', 'browser', 'phone'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className="rounded-lg px-2 py-1 text-[12px] capitalize"
            style={{ background: tab === name ? 'var(--color-raised)' : 'transparent' }}
          >
            {name === 'phone' ? 'Android USB' : name}
          </button>
        ))}
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto pb-4">
        {!canComputer ? (
          <div className="m-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            {/* Never offer a control the engine cannot honour. */}
            {snapshot?.displayName ?? 'This engine'} does not support computer use, so there is nothing to place here.
            Switch the bot to an engine that does, and this panel fills in.
          </div>
        ) : tab === 'computer' ? (
          <>
            <ActivityStrip threadId={bot.threadId} />
            {host?.hermes ? (
              <div className="mx-3 mt-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)' }}>
                <div className="font-medium">Hermes has no computer-use. This bot still can.</div>
                <p className="mt-1" style={{ color: 'var(--color-ink-secondary)' }}>
                  Pick <span className="font-medium">This computer</span> and opt in to let {bot.name} drive this
                  machine, or enable a Hermes browser/computer MCP under Settings → MCP servers.
                  {host.hostScreenServer ? ` ${host.hostScreenServer} is on and Auto will reuse it.` : ''}
                </p>
              </div>
            ) : null}
            <div className="px-3 pt-2 text-[12px] font-medium">Where its hands are</div>
            <div className="mt-1 flex flex-col gap-1 px-3">
              {PLACEMENTS.map((option) => {
                const active = (bot.computer ?? '') === option.value;
                return (
                  <button
                    key={option.value || 'auto'}
                    type="button"
                    onClick={() => void api.patch(`/api/bots/${bot.id}`, { computer: option.value || undefined })}
                    className="rounded-lg p-2 text-left"
                    style={{
                      background: active ? 'var(--color-raised)' : 'var(--color-inset)',
                      border: `1px solid ${active ? 'var(--color-accent-border)' : 'transparent'}`,
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ border: `2px solid ${active ? 'var(--color-accent)' : 'var(--color-ink-secondary)'}`, background: active ? 'var(--color-accent)' : 'transparent' }}
                      />
                      <span className="text-[13px] font-medium">{option.title}</span>
                    </span>
                    <span className="mt-0.5 block pl-5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      {option.body}
                    </span>
                  </button>
                );
              })}
            </div>

            {bot.computer === 'cloud' ? (
              <Row label="Cloud backend" hint="A VPS container filesystem is disposable — move anything you want to keep out first.">
                <select
                  value={bot.cloudBackend ?? 'box'}
                  onChange={(e) => void api.patch(`/api/bots/${bot.id}`, { cloudBackend: e.target.value })}
                  className="w-full rounded-lg px-2 py-1.5 text-[13px]"
                  style={input}
                >
                  <option value="box">Box</option>
                  <option value="vps">Self-hosted VPS</option>
                </select>
              </Row>
            ) : null}

            {bot.computer === 'local' ? (
              <div className="mx-3 mt-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)', border: '1px solid var(--color-danger)' }}>
                <div className="font-semibold" style={{ color: 'var(--color-danger)' }}>
                  This is your real keyboard and mouse.
                </div>
                <div className="mt-1" style={{ color: 'var(--color-ink-secondary)' }}>
                  A mistake here clicks things in your actual apps, in your actual logged-in sessions.
                  There is no undo and no sandbox. {info?.hostControl.reason}
                </div>
                {info?.hostControl.supported ? (
                  <label className="mt-2 flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={info.hostControl.enabled}
                      onChange={async (e) => {
                        await api.post(`/api/bots/${bot.id}/computer/opt-in`, { enabled: e.target.checked });
                        await refresh();
                      }}
                    />
                    <span>Let {bot.name} control this computer</span>
                  </label>
                ) : (
                  <div className="mt-2 font-medium" style={{ color: 'var(--color-warning)' }}>
                    Disabled on this session type. Preview stays available; control does not.
                  </div>
                )}
              </div>
            ) : null}

            <div className="mx-3 mt-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)' }}>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium">Resolved</span>
                <span
                  className="rounded px-1.5 text-[11px]"
                  style={{ color: info?.placement.available ? 'var(--color-success)' : 'var(--color-warning)' }}
                >
                  {info?.placement.available ? 'ready' : 'not ready'}
                </span>
              </div>
              <div className="mt-1" style={{ color: 'var(--color-ink-secondary)' }}>
                {info ? `${info.placement.placement}${info.placement.backend ? ` · ${info.placement.backend}` : ''}` : 'checking…'}
              </div>
              {info?.placement.reason ? (
                <div className="mt-1" style={{ color: 'var(--color-warning)' }}>
                  {info.placement.reason}
                </div>
              ) : null}
              {host ? (
                <div className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {host.platform} · {host.session} session · action ceiling{' '}
                  {host.maxActions === 0 ? 'disabled' : `${host.maxActions} per session`}
                </div>
              ) : null}
            </div>

            <div className="mx-3 mt-3">
              {frame ? (
                <img
                  src={`data:${frame.mime};base64,${frame.png}`}
                  alt="Desktop preview"
                  className="w-full rounded-lg"
                  style={{ border: '1px solid var(--color-hairline)' }}
                />
              ) : (
                <div className="grid aspect-video place-items-center rounded-lg text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                  No frames yet
                </div>
              )}
              <div className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Preview only. Watching is not permission to click.
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 px-3">
              {bot.computer === 'vm' ? (
                <button
                  type="button"
                  onClick={() => setLive(!live)}
                  className="rounded-lg px-3 py-1.5 text-[13px]"
                  style={{ background: live ? 'var(--color-accent)' : 'var(--color-raised)', color: live ? 'var(--color-accent-ink)' : 'var(--color-ink)' }}
                >
                  {live ? 'Stop preview' : 'Live preview'}
                </button>
              ) : null}

              {/* Taking over is a deliberate click, labelled as what it does. */}
              <button
                type="button"
                onClick={() => {
                  if (bot.computer === 'local') {
                    setLive((on) => !on);
                    return;
                  }
                  dispatch({ type: 'view', view: bot.computer === 'vm' ? 'vm' : 'browser' });
                }}
                className="rounded-lg px-3 py-1.5 text-[13px]"
                style={{ background: 'var(--color-raised)' }}
              >
                {bot.computer === 'local' && live ? 'Stop preview' : 'Open desktop'}
              </button>

              {info?.held ? (
                <button
                  type="button"
                  onClick={async () => {
                    await api.post(`/api/bots/${bot.id}/computer/control/release`, { token });
                    setToken(null);
                    await refresh();
                  }}
                  className="rounded-lg px-3 py-1.5 text-[13px]"
                  style={{ background: 'var(--color-warning)', color: '#1a1200' }}
                >
                  Give control back
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    const result = await api.post<{ token: string }>(`/api/bots/${bot.id}/computer/control/take`);
                    setToken(result.token);
                    await refresh();
                  }}
                  className="rounded-lg px-3 py-1.5 text-[13px]"
                  style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
                >
                  Take the wheel
                </button>
              )}
            </div>

            {info?.held ? (
              <div className="mx-3 mt-2 rounded-lg p-2 text-[11px]" style={{ background: 'var(--color-inset)', color: 'var(--color-warning)' }}>
                You are driving. {bot.name}'s hands are paused until you hand control back from this
                panel — closing the window will not do it.
              </div>
            ) : null}
          </>
        ) : tab === 'browser' ? (
          <>
            {!snapshot?.capabilities.browserMcp ? (
              <div className="m-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                This engine cannot drive the built-in browser.
              </div>
            ) : (
              <>
                <Row label="Browser profile" hint="Bots sharing a profile share its cookies and logins. `guest` is a reserved throwaway.">
                  <select
                    value={bot.browserProfile ?? 'default'}
                    onChange={(e) => void api.patch(`/api/bots/${bot.id}`, { browserProfile: e.target.value })}
                    className="w-full rounded-lg px-2 py-1.5 text-[13px]"
                    style={input}
                  >
                    {(state.config?.browserProfiles ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Row>
                <Toggle checked={bot.browser !== false} onChange={(v) => void api.patch(`/api/bots/${bot.id}`, { browser: v })} label="Allow the built-in browser" />
                <div className="px-3 pt-2">
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'view', view: 'browser' })}
                    className="rounded-lg px-3 py-1.5 text-[13px]"
                    style={{ background: 'var(--color-raised)' }}
                  >
                    Expand workspace
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <PhoneDevices canMount={snapshot?.capabilities.phoneMcp === true} />
        )}
      </div>
    </aside>
  );
}

interface PersistedEvent {
  type: string;
  createdAt?: number;
  summary?: string;
  text?: string;
  toolName?: string;
  message?: string;
}

export interface PhoneList {
  available: boolean;
  reason?: string;
  devices: { serial: string; state: string; screenshot: { mime: string; png: string; at: number } | null }[];
}

function PhoneDevices({ canMount }: { canMount: boolean }) {
  const [list, setList] = useState<PhoneList | null>(null);
  const [gate, setGate] = useState<PhoneGate | null>(null);

  const refresh = (): void => {
    void api.get<PhoneList>('/api/phone').then(setList).catch(() => setList({ available: false, reason: 'Could not ask the harness about phones.', devices: [] }));
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="m-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
      <div className="font-medium" style={{ color: 'var(--color-ink)' }}>
        Physical Android
      </div>
      {!canMount ? (
        <p className="mt-1">This engine does not declare phone support, so the tools will not be mounted.</p>
      ) : null}
      {list && !list.available ? (
        <p className="mt-2" style={{ color: 'var(--color-warning)' }}>
          {list.reason}
        </p>
      ) : null}
      {list?.available && list.devices.length === 0 ? (
        <p className="mt-2">No phone is connected. Plug one in and accept USB debugging.</p>
      ) : null}
      {list?.devices.map((device) => (
        <div key={device.serial} className="mt-3">
          <div className="font-medium" style={{ color: 'var(--color-ink)' }}>
            {device.serial}
          </div>
          <div>{device.state}</div>
          {device.screenshot ? (
            <img src={`data:${device.screenshot.mime};base64,${device.screenshot.png}`} alt={`Screenshot of ${device.serial}`} className="mt-2 w-full rounded-lg" />
          ) : (
            <div className="mt-2">No screenshot yet.</div>
          )}
          {device.state === 'device' ? (
            <button
              type="button"
              className="mt-2 rounded-lg px-2 py-1"
              style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
              onClick={() => void api.post<PhoneList['devices'][number]>(`/api/phone/${encodeURIComponent(device.serial)}/screenshot`).then(refresh)}
            >
              Take screenshot
            </button>
          ) : null}
        </div>
      ))}
      <div className="mt-3 font-medium" style={{ color: 'var(--color-ink)' }}>
        Send, pay, or delete
      </div>
      <p className="mt-1">These do not run until you approve them. The harness does not invent an approval.</p>
      <div className="mt-2 flex gap-1">
        {(['send', 'pay', 'delete'] as const).map((action) => (
          <button
            key={action}
            type="button"
            className="rounded-lg px-2 py-1 capitalize"
            style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
            onClick={() => {
              void api.post<{ allowed: boolean; reason?: string }>('/api/phone/actions', { action, approved: false }).then((result) => {
                setGate(phoneGateAfterAsk(action, result));
              });
            }}
          >
            {action}
          </button>
        ))}
      </div>
      {gate ? (
        <div className="mt-2">
          <p>{gate.note}</p>
          <button
            type="button"
            className="mt-1 rounded-lg px-2 py-1"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
            onClick={() => {
              const pending = gate;
              void api.post<{ allowed: boolean; reason?: string }>('/api/phone/actions', approvalPost(pending)).then((result) => {
                setGate(phoneGateAfterApprove(pending, result));
              });
            }}
          >
            Approve this action
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function InspectorPanel({ bot, onClose }: { bot: BotRecord; onClose: () => void }) {
  const trace = useTrace(bot.threadId);
  const streaming = useStreaming(bot.threadId);
  const task = (bot.tasks ?? []).find((t) => t.threadId === bot.threadId);
  const [history, setHistory] = useState<PersistedEvent[] | null>(null);

  // The live trace starts empty after a reload, but the events are on disk. Offer them
  // rather than claiming nothing happened.
  useEffect(() => setHistory(null), [bot.threadId]);

  return (
    <aside className="anim-panel flex w-[360px] shrink-0 flex-col border-l hairline" style={{ background: 'var(--color-panel)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2 hairline">
        <span className="flex-1 text-[13px] font-semibold">Inspector</span>
        <button type="button" onClick={onClose} className="text-[12px]">
          Close
        </button>
      </header>

      <div className="border-b px-3 py-2 text-[12px] hairline" style={{ color: 'var(--color-ink-secondary)' }}>
        {task?.usage ? (
          <>
            {task.usage.input} in · {task.usage.output} out
            {task.usage.cachedInput ? ` · ${task.usage.cachedInput} cached` : ''}
            {task.usage.costUsd ? ` · $${task.usage.costUsd.toFixed(4)}` : ''} · {task.usage.turns} turn
            {task.usage.turns === 1 ? '' : 's'}
          </>
        ) : (
          'No usage banked yet.'
        )}
      </div>

      {streaming ? (
        <div className="border-b px-3 py-2 hairline">
          <div className="text-[11px] font-medium" style={{ color: 'var(--color-ink-secondary)' }}>
            Streaming
          </div>
          <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[11px] whitespace-pre-wrap">{streaming}</div>
        </div>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto">
        {trace.map((item, i) => (
          <div key={i} className="border-b px-3 py-1.5 text-[11px] hairline">
            <span className="font-mono" style={{ color: 'var(--color-accent)' }}>
              {item.type}
            </span>
            {item.detail ? <span className="ml-2 break-words opacity-80">{String(item.detail).slice(0, 200)}</span> : null}
          </div>
        ))}
        {trace.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Lower-level activity for this task shows up here as it happens.
          </div>
        ) : null}

        {history === null ? (
          <div className="px-3 py-2">
            <button
              type="button"
              onClick={() => void api.get<PersistedEvent[]>(`/api/threads/${bot.threadId}/events`).then(setHistory)}
              className="w-full rounded-lg px-3 py-1.5 text-[12px]"
              style={{ background: 'var(--color-inset)' }}
            >
              Load earlier events from disk
            </button>
          </div>
        ) : (
          <>
            <div className="border-t px-3 py-1.5 text-[11px] font-medium hairline" style={{ color: 'var(--color-ink-secondary)' }}>
              {history.length ? `${history.length} recorded event(s)` : 'Nothing recorded on disk for this task.'}
            </div>
            {history
              .slice()
              .reverse()
              .map((event, i) => (
                <div key={i} className="border-b px-3 py-1.5 text-[11px] hairline" style={{ opacity: 0.75 }}>
                  <span className="font-mono">{event.type}</span>
                  <span className="ml-2 break-words">
                    {String(event.summary ?? event.text ?? event.toolName ?? event.message ?? '').slice(0, 200)}
                  </span>
                </div>
              ))}
          </>
        )}
      </div>
    </aside>
  );
}

const MEMORY_KINDS = ['fact', 'preference', 'correction', 'entity', 'decision', 'task_outcome', 'reference'] as const;

/**
 * Structured memory, readable and correctable. Memory a user cannot inspect and fix
 * is memory they cannot trust — so every entry shows its kind, source and confidence,
 * and anything a bot inferred can be edited or deleted here.
 */
export function MemoryPanel({ bot, onClose }: { bot: BotRecord; onClose: () => void }) {
  const [scope, setScope] = useState<'bot' | 'section' | 'workspace'>('bot');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState({ kind: 'fact' as MemoryEntry['kind'], text: '' });
  const [granted, setGranted] = useState(false);
  const [error, setError] = useState('');

  // The workspace tier is a singleton, so its id is fixed rather than looked up.
  const scopeId = scope === 'bot' ? bot.id : scope === 'workspace' ? 'workspace' : (bot.section ?? '');

  const load = useCallback(async (): Promise<void> => {
    if (!scopeId) {
      setEntries([]);
      return;
    }
    const search = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '';
    setEntries(await api.get<MemoryEntry[]>(`/api/memory?scope=${scope}&id=${encodeURIComponent(scopeId)}${search}`));
  }, [scope, scopeId, query]);

  useEffect(() => {
    void load().catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [load]);

  const add = async (): Promise<void> => {
    setError('');
    try {
      await api.post('/api/memory', {
        scope,
        botId: scope === 'bot' ? bot.id : undefined,
        sectionId: scope === 'section' ? scopeId : undefined,
        // A tier every bot reads is the point of the workspace scope, so say so.
        entities: [],
        kind: draft.kind,
        text: draft.text.trim(),
        // Typed here by hand, so it is the user's own, at full confidence.
        source: 'user',
        confidence: 1,
      });
      setDraft({ ...draft, text: '' });
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <aside className="anim-panel flex w-[360px] shrink-0 flex-col border-l hairline" style={{ background: 'var(--color-panel)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2 hairline">
        <span className="flex-1 text-[13px] font-semibold">Memory</span>
        <button type="button" onClick={onClose} className="text-[12px]">
          Close
        </button>
      </header>

      {/*
       * Three durable tiers, narrowest first. The widths are the whole point: what one
       * bot believes, what a section shares, and what the entire account knows — so the
       * tabs read left to right in that order and each says who else can see it.
       */}
      <div className="flex gap-1 px-3 pt-2">
        {(['bot', 'section', 'workspace'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setScope(name)}
            aria-pressed={scope === name}
            title={
              name === 'bot'
                ? `Only ${bot.name} reads this`
                : name === 'section'
                  ? 'Everyone in this section reads it'
                  : 'Every bot in the workspace reads it'
            }
            className="rounded-lg px-2 py-1 text-[12px]"
            style={{
              background: scope === name ? 'var(--color-raised)' : 'transparent',
              color: scope === name ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
            }}
          >
            {name === 'bot' ? bot.name : name === 'section' ? (bot.section ?? 'Section') : 'Every bot'}
          </button>
        ))}
      </div>

      <div className="px-3 pt-1.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {scope === 'bot'
          ? `Only ${bot.name} reads this.`
          : scope === 'section'
            ? 'Shared with every bot in this section.'
            : 'Shared with every bot in the workspace, including ones you create later.'}
      </div>

      {scope === 'section' && !bot.section ? (
        <div className="m-3 rounded-lg p-3 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
          {bot.name} is not filed into a section yet. Set one under Bot settings and shared memory
          appears here.
        </div>
      ) : (
        <>
          {scope !== 'bot' ? (
            <label className="mx-3 mt-2 flex items-start gap-2 rounded-lg p-2 text-[12px]" style={{ background: 'var(--color-inset)' }}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={granted}
                onChange={async (e) => {
                  setGranted(e.target.checked);
                  await api.post('/api/memory/section-grant', { sectionId: scopeId, granted: e.target.checked });
                }}
              />
              <span>
                Let bots write to {scope === 'workspace' ? 'the workspace memory' : "this section's shared memory"}.
                <span className="block" style={{ color: 'var(--color-ink-secondary)' }}>
                  {scope === 'workspace' ? 'Every bot in the workspace' : `Everyone in ${scopeId}`} reads it. The grant
                  lasts until the harness restarts; what you type yourself is always allowed.
                </span>
              </span>
            </label>
          ) : null}

          <div className="px-3 pt-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory"
              className="w-full rounded-lg px-2 py-1.5 text-[13px]"
              style={input}
            />
          </div>

          <div className="scroll-thin flex-1 overflow-y-auto px-3 py-2">
            {entries.length === 0 ? (
              <div className="py-6 text-center text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {query ? 'Nothing matched.' : 'Nothing remembered yet.'}
              </div>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="card mb-2 p-2">
                  <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--color-ink-secondary)' }}>
                    <span className="rounded px-1" style={{ background: 'var(--color-inset)' }}>
                      {entry.kind}
                    </span>
                    <span>{entry.source.replace('_', ' ')}</span>
                    {entry.confidence < 1 ? <span>· {Math.round(entry.confidence * 100)}%</span> : null}
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={async () => {
                        await api.del(`/api/memory/${entry.id}?scope=${scope}&id=${encodeURIComponent(scopeId)}`);
                        await load();
                      }}
                      style={{ color: 'var(--color-danger)' }}
                    >
                      forget
                    </button>
                  </div>
                  <textarea
                    defaultValue={entry.text}
                    rows={2}
                    onBlur={async (e) => {
                      const text = e.target.value.trim();
                      if (!text || text === entry.text) return;
                      await api.patch(`/api/memory/${entry.id}`, { scope, id: scopeId, text });
                      await load();
                    }}
                    className="mt-1 w-full resize-none rounded-md px-1.5 py-1 text-[13px]"
                    style={{ background: 'transparent', color: 'var(--color-ink)' }}
                  />
                  {entry.topics.length ? (
                    <div className="flex flex-wrap gap-1">
                      {entry.topics.map((topic) => (
                        <span key={topic} className="rounded px-1 text-[10px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                          {topic}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="border-t px-3 py-2 hairline">
            {error ? (
              <div className="mb-1 text-[11px]" style={{ color: 'var(--color-danger)' }}>
                {error}
              </div>
            ) : null}
            <div className="flex gap-1">
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryEntry['kind'] })}
                className="rounded-lg px-1.5 py-1 text-[12px]"
                style={input}
              >
                {MEMORY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <input
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && draft.text.trim() && void add()}
                placeholder="Something it should remember"
                className="min-w-0 flex-1 rounded-lg px-2 py-1 text-[13px]"
                style={input}
              />
              <button
                type="button"
                disabled={!draft.text.trim()}
                onClick={() => void add()}
                className="rounded-lg px-2.5 text-[12px] disabled:opacity-40"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
              >
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * The bot's face. It was the one thing about a bot you could see everywhere and edit
 * nowhere — colour and picture were set at creation and then frozen.
 */
function BotProfile({ bot, onSave }: { bot: BotRecord; onSave: (patch: Partial<BotRecord>) => void }) {
  const { refreshBots } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (patch: Partial<BotRecord>): Promise<void> => {
    onSave(patch);
    await refreshBots();
  };

  const pickImage = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const uploaded = await uploadAttachment(file);
      await save({ avatarUrl: uploaded.url });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-b px-3 py-3 hairline">
      <div className="flex items-center gap-3">
        <Avatar name={bot.name} color={bot.color} activity={bot.activity} expression={bot.mascotExpression} avatarUrl={bot.avatarUrl} avatarShape={bot.avatarShape} size={54} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{bot.name}</div>
          <div className="truncate text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {bot.title || 'No title yet'}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <label
              className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px]"
              style={{ background: 'var(--color-raised)', opacity: busy ? 0.5 : 1 }}
            >
              <Icon name="user" size={12} />
              {busy ? 'Uploading…' : bot.avatarUrl ? 'Replace picture' : 'Upload picture'}
              <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => void pickImage(e.target.files?.[0])} />
            </label>
            {bot.avatarUrl ? (
              <button
                type="button"
                /* Empty string, not undefined: JSON drops undefined and the patch
                   would be a no-op, so the picture would never actually clear. */
                onClick={() => void save({ avatarUrl: '' })}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px]"
                style={{ background: 'var(--color-raised)', color: 'var(--color-ink-secondary)' }}
              >
                <Icon name="trash" size={12} />
                Use the mascot
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      <span className="mt-3 block text-[12px] font-medium">Shape</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Bot shape">
        {AVATAR_SHAPES.map((shape) => {
          const chosen = (bot.avatarShape ?? 'rounded') === shape;
          const label = AVATAR_SHAPE_LABELS[shape];
          return (
            <button
              key={shape}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={chosen}
              onClick={() => void save({ avatarShape: shape })}
              className="grid h-9 w-9 place-items-center rounded-lg"
              style={{
                background: 'var(--color-raised)',
                boxShadow: chosen ? '0 0 0 2px var(--color-panel), 0 0 0 4px var(--color-focus)' : undefined,
              }}
            >
              <Avatar name={label} color={bot.color} avatarShape={shape} size={26} decorative />
            </button>
          );
        })}
      </div>

      <span className="mt-3 block text-[12px] font-medium">Colour</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {BOT_COLORS.map((colour: HarnessbotColor) => {
          const chosen = bot.color === colour;
          return (
            <button
              key={colour}
              type="button"
              onClick={() => void save({ color: colour })}
              title={colour}
              aria-label={colour}
              aria-pressed={chosen}
              className="grid h-7 w-7 place-items-center rounded-lg"
              style={{
                background: botColor(colour),
                // A ring, not a border: a border would resize the swatch on selection.
                boxShadow: chosen ? '0 0 0 2px var(--color-panel), 0 0 0 4px var(--color-focus)' : undefined,
              }}
            >
              {/* Never colour alone — the chosen swatch also carries a tick. */}
              {chosen ? (
                <span style={{ color: '#fff' }}>
                  <Icon name="check" size={13} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function BotSettingsPanel({ bot, onClose }: { bot: BotRecord; onClose: () => void }) {
  const { state } = useStore();
  const snapshot = snapshotFor(state, bot);
  const [grants, setGrants] = useState<{ tools: string[]; localComputer: string[] }>({ tools: [], localComputer: [] });
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [appSource, setAppSource] = useState<string | null>(null);
  const canEditApp = snapshot?.driver === 'claude' || snapshot?.driver === 'grok' || snapshot?.driver === 'hermes';

  useEffect(() => {
    void api.get<typeof grants>(`/api/bots/${bot.id}/always-allow`).then(setGrants);
  }, [bot.id, bot.alwaysAllow, bot.alwaysAllowLocalComputer]);

  useEffect(() => {
    void api.get<{ voices: typeof voices }>('/api/tts/voices').then((r) => setVoices(r.voices));
  }, []);

  useEffect(() => {
    if (!canEditApp) return;
    void api.get<{ available: boolean; path: string | null }>('/api/app-source').then((found) => {
      setAppSource(found.available ? found.path : null);
    });
  }, [canEditApp]);

  const save = (patch: Partial<BotRecord>): void => void api.patch(`/api/bots/${bot.id}`, patch);

  return (
    <aside className="anim-panel flex w-[360px] shrink-0 flex-col border-l hairline" style={{ background: 'var(--color-panel)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2 hairline">
        <Avatar name={bot.name} color={bot.color} activity={bot.activity} expression={bot.mascotExpression} avatarUrl={bot.avatarUrl} avatarShape={bot.avatarShape} size={22} />
        <span className="flex-1 text-[13px] font-semibold">{bot.name}</span>
        <button type="button" onClick={onClose} title="Close" aria-label="Close bot settings" className="grid h-6 w-6 place-items-center rounded-lg" style={{ color: 'var(--color-ink-secondary)' }}>
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto pb-4">
        <BotProfile bot={bot} onSave={save} />
        <Row label="Name">
          <input defaultValue={bot.name} onBlur={(e) => save({ name: e.target.value })} maxLength={100} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={input} />
        </Row>
        <Row label="Title">
          <input defaultValue={bot.title} onBlur={(e) => save({ title: e.target.value })} maxLength={200} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={input} />
        </Row>
        <Row label="Purpose" hint="This becomes the bot's system prompt.">
          <textarea
            defaultValue={bot.description}
            onBlur={(e) => save({ description: e.target.value })}
            maxLength={4000}
            rows={4}
            className="w-full rounded-lg px-2 py-1.5 text-[13px]"
            style={input}
          />
        </Row>
        <Row label="Working folder" hint="New tasks inherit it. Each task pins its own on the first turn.">
          <input defaultValue={bot.cwd ?? ''} onBlur={(e) => save({ cwd: e.target.value || undefined })} className="w-full rounded-lg px-2 py-1.5 font-mono text-[13px]" style={input} />
        </Row>
        {canEditApp && appSource ? (
          <Row
            label="Edit HarnessBot"
            hint="Sets this bot's folder to the app source, so Claude, Grok, or Hermes can fix bugs here. The next message starts a new session in that folder. It does not touch your data directory."
          >
            <Toggle
              checked={bot.cwd === appSource}
              onChange={(enabled) => void api.post(`/api/bots/${bot.id}/work-on-app`, { enabled })}
              label={bot.cwd === appSource ? 'This bot can change the app' : 'Off'}
            />
          </Row>
        ) : null}
        <BotJobs bot={bot} />
        <Row label="Section">
          <input defaultValue={bot.section ?? ''} onBlur={(e) => save({ section: e.target.value || undefined })} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={input} />
        </Row>

        {/*
         * A bot is not married to the engine it was created on. The raw provider rail
         * used to live inline here, which meant the panel showed every engine on the
         * machine to answer a question about one bot — and had no way to reach "use my
         * own key" at all.
         */}
        <Row
          label="Lean"
          hint="Sends a tighter prompt — fewer skills, a shorter transcript, a digest of older turns. Follows the workspace unless you pin it."
        >
          <select
            value={bot.lean === true ? 'on' : bot.lean === false ? 'off' : 'follow'}
            onChange={(e) => {
              const v = e.target.value;
              void api.patch(`/api/bots/${bot.id}`, { lean: v === 'on' ? true : v === 'off' ? false : null });
            }}
            className="w-full rounded-lg px-2 py-1.5 text-[13px]"
            style={input}
          >
            <option value="follow">Follow workspace ({state.config?.lean?.enabled !== false ? 'on' : 'off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Row>

        <div className="px-3 py-2">
          <span className="block text-[12px] font-medium">Engine</span>
          <span className="mt-0.5 mb-1.5 block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Switching keeps the transcript. The next turn starts a fresh provider session on the new
            engine.
          </span>
          <EngineRow bot={bot} />
        </div>

        <Row label="Voice" hint="Overrides the app default, so a room does not sound like one person.">
          <select value={bot.voice ?? ''} onChange={(e) => save({ voice: e.target.value || undefined })} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={input}>
            <option value="">App default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Reports to" hint="The org spine. One manager per bot; the chart draws it.">
          <select value={bot.reportsTo ?? ''} onChange={(e) => save({ reportsTo: e.target.value || undefined })} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={input}>
            <option value="">Nobody</option>
            {state.bots
              .filter((b) => b.id !== bot.id && !b.hidden)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </Row>

        {/*
         * Chief of Staff is a role, not a preference, and it was a checkbox in a column
         * of checkboxes — nothing said this one changes how work is routed to the whole
         * section. Appointing someone should look like an appointment.
         */}
        <ChiefOfStaffCard bot={bot} save={save} />

        <div className="mt-2 border-t pt-1 hairline" />
        <Toggle checked={bot.autoApprove === true} onChange={(v) => save({ autoApprove: v })} label="Auto-approve tool use" />
        <div className="px-3 pb-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Questions still stop for you, destructive-looking commands are still held, and this never
          covers your real computer.
        </div>
        <Row label="Auto-review" hint="Model review of undecided attended cards.">
          <select value={bot.autoReview ?? 'off'} onChange={(e) => save({ autoReview: e.target.value as BotRecord['autoReview'] })} className="w-full rounded-lg px-2 py-1.5 text-[13px]" style={input}>
            <option value="off">Off</option>
            <option value="shadow">Shadow</option>
            <option value="enforce">Enforce</option>
          </select>
        </Row>

        <div className="px-3 pt-2 text-[12px] font-medium">Remembered grants</div>
        {grants.tools.length + grants.localComputer.length === 0 ? (
          <div className="px-3 pb-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Nothing remembered. Every tool asks.
          </div>
        ) : (
          [...grants.tools.map((k) => [k, 'tool'] as const), ...grants.localComputer.map((k) => [k, 'this computer'] as const)].map(([key, scope]) => (
            <div key={`${scope}:${key}`} className="flex items-center gap-2 px-3 py-1 text-[12px]">
              <code className="flex-1 font-mono">{key}</code>
              <span style={{ color: scope === 'this computer' ? 'var(--color-warning)' : 'var(--color-ink-secondary)' }}>{scope}</span>
              <button type="button" onClick={() => void api.del(`/api/bots/${bot.id}/always-allow/${encodeURIComponent(key)}`)}>
                forget
              </button>
            </div>
          ))
        )}

        <div className="mt-2 border-t pt-1 hairline" />
        {/* Each switch is hidden when the engine cannot mount that tool at all. */}
        {snapshot?.capabilities.composioMcp ? (
          <Toggle checked={bot.composio !== false} onChange={(v) => save({ composio: v })} label="Connected apps" />
        ) : null}
        {snapshot?.capabilities.agentsMcp ? (
          <Toggle checked={bot.peerTools !== false} onChange={(v) => save({ peerTools: v })} label="Talk to other bots" />
        ) : null}
        {snapshot?.capabilities.customMcp ? (
          <Toggle checked={bot.customMcp !== false} onChange={(v) => save({ customMcp: v })} label="Custom MCP servers" />
        ) : null}
        <Row label="Spend cap (USD)" hint="Warns as usage approaches the cap and stops the next turn until you confirm.">
          <input
            type="number"
            min={0}
            step="0.5"
            value={bot.spendCapUsd ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              void api.patch(`/api/bots/${bot.id}`, { spendCapUsd: raw === '' ? null : Number(raw) });
            }}
            className="w-full rounded-lg px-2 py-1.5 text-[13px]"
            style={input}
          />
        </Row>
        <Toggle checked={bot.notifications !== false} onChange={(v) => save({ notifications: v })} label="Notifications" />
        <Toggle checked={bot.speakReplies === true} onChange={(v) => save({ speakReplies: v })} label="Speak replies (uses ElevenLabs credit)" />

        <BotSkills bot={bot} />
      </div>
    </aside>
  );
}

/**
 * Appointing a Chief of Staff.
 *
 * One per section, and promoting someone demotes whoever holds it — so the panel says
 * who that is before you click, rather than after.
 */
function ChiefOfStaffCard({ bot, save }: { bot: BotRecord; save: (patch: Partial<BotRecord>) => void }) {
  const { state } = useStore();
  const section = bot.section ?? '';
  const holder = state.bots.find((b) => b.id !== bot.id && b.chiefOfStaff && (b.section ?? '') === section);
  const isChief = bot.chiefOfStaff === true;

  return (
    <div className="px-3 py-2">
      <div
        className="rounded-xl p-3"
        style={{
          background: isChief ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-panel))' : 'var(--color-inset)',
          border: `1px solid ${isChief ? 'var(--color-accent-border)' : 'transparent'}`,
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg"
            style={{
              background: isChief ? 'var(--color-accent)' : 'var(--color-raised)',
              color: isChief ? 'var(--color-accent-ink)' : 'var(--color-ink-secondary)',
            }}
          >
            <Icon name="user" size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">Chief of Staff</div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {isChief
                ? `${bot.name} routes work for ${section ? `the ${section} section` : 'the unsectioned area'} and coordinates its peers.`
                : holder
                  ? `${holder.name} currently holds it for ${section ? `the ${section} section` : 'the unsectioned area'}. Appointing ${bot.name} demotes them.`
                  : `Nobody holds it for ${section ? `the ${section} section` : 'the unsectioned area'} yet.`}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => save({ chiefOfStaff: !isChief } as Partial<BotRecord>)}
          className="mt-2.5 w-full rounded-lg px-3 py-1.5 text-[12px] font-medium"
          style={
            isChief
              ? { background: 'var(--color-raised)', color: 'var(--color-ink)' }
              : { background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }
          }
        >
          {isChief ? 'Step down' : `Appoint ${bot.name}`}
        </button>

        {isChief ? (
          <label className="mt-2 flex items-center gap-2 text-[12px]">
            <span className="flex-1">Review rounds</span>
            <input
              type="number"
              min={0}
              max={3}
              defaultValue={bot.reviewRounds ?? 0}
              onBlur={(e) => save({ reviewRounds: Number(e.target.value) })}
              className="w-16 rounded-lg px-2 py-1 text-[13px]"
              style={input}
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}

interface BotSkillsData {
  installed: { name: string; summary: string }[];
  global: { name: string; summary: string }[];
  staged: { name: string }[];
  plugins: { id: string; name: string; scope: string; skills: string[] }[];
}

/**
 * What this bot can actually do, in the place you go to ask that question.
 *
 * Skills were only ever visible on their own page, so a bot's profile could not answer
 * "what does it know how to do?" — the one thing a profile is for. Installed here,
 * inherited from the workspace there, and a way in to add more.
 */
function BotSkills({ bot }: { bot: BotRecord }) {
  const { dispatch } = useStore();
  const [data, setData] = useState<BotSkillsData>({ installed: [], global: [], staged: [], plugins: [] });

  const load = async (): Promise<void> => {
    try {
      const next = await api.get<Partial<BotSkillsData>>(`/api/skills?scope=${encodeURIComponent(bot.id)}`);
      setData({
        installed: next.installed ?? [],
        global: next.global ?? [],
        staged: next.staged ?? [],
        plugins: next.plugins ?? [],
      });
    } catch {
      // A harness that cannot answer should leave the section empty, not blank the panel.
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const inherited = data.global.filter((g) => !data.installed.some((s) => s.name === g.name));
  const plugins = data.plugins.filter((p) => p.scope === bot.id || p.scope === 'global');

  const chip = (label: string, tone: 'own' | 'inherited') => (
    <span
      key={`${tone}:${label}`}
      className="rounded-md px-1.5 py-0.5 text-[11px]"
      style={
        tone === 'own'
          ? { background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)', color: 'var(--color-accent)' }
          : { background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }
      }
    >
      {label}
    </span>
  );

  return (
    <>
      <div className="mt-2 border-t pt-1 hairline" />
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="flex-1 text-[12px] font-medium">Skills and plugins</span>
        <button
          type="button"
          onClick={() => dispatch({ type: 'view', view: 'skills' })}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px]"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
        >
          <Icon name="plus" size={11} />
          Add
        </button>
      </div>

      {data.staged.length ? (
        <div className="px-3 pt-1.5 text-[11px]" style={{ color: 'var(--color-warning)' }}>
          {data.staged.length} proposal{data.staged.length === 1 ? '' : 's'} waiting for you to read and confirm.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 px-3 pt-1.5">
        {data.installed.map((s) => chip(s.name, 'own'))}
        {inherited.map((s) => chip(s.name, 'inherited'))}
        {data.installed.length + inherited.length === 0 ? (
          <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            None yet. Add gives {bot.name} one, or installs it for every bot.
          </span>
        ) : null}
      </div>

      {inherited.length ? (
        <div className="px-3 pt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Grey ones come from the workspace and reach every bot.
        </div>
      ) : null}

      {plugins.length ? (
        <div className="px-3 pt-2">
          <div className="text-[11px] font-medium">Plugins</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {plugins.map((p) => (
              <span key={p.id} className="rounded-md px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                {p.name} · {p.skills.length}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
