import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { setLocale } from './i18n.ts';
import { jumpToThread, noEngines, selectedBot, selectedGroup, useStore } from './store.tsx';
import { ChatView, GroupView } from './components/Chat.tsx';
import { ChatDrawer } from './components/ChatDrawer.tsx';
import { BotSettingsPanel, ComputerPanel, InspectorPanel, MemoryPanel } from './components/Panels.tsx';
import { HistoryPage } from './components/History.tsx';
import { RoutineCalendarPage } from './components/Pages.tsx';
import { WorkflowsPage } from './components/Workflows.tsx';
import { SkillRecorderPage, SkillsPage } from './components/Skills.tsx';
import { PluginsPanel } from './components/Plugins.tsx';
import { TeamMapPage } from './components/TeamMap.tsx';
import { BrowserWorkspace, LocalVmWorkspace } from './components/Workspaces.tsx';
import { CallView, CommandPalette, NewBotDialog, NoEngines, NotificationCentre, Onboarding } from './components/Overlays.tsx';
import { SettingsModal } from './components/Settings.tsx';
import { BusyStrip } from './components/BusyStrip.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { UsageChip } from './components/UsageChip.tsx';
import { Icon } from './components/Icons.tsx';

type Panel = 'computer' | 'inspector' | 'memory' | 'settings' | null;

/** The status bar names the integration, not a generic "harness". */
function harnessLabel(
  connected: boolean,
  loaded: boolean,
  instances: { displayName: string; state: string }[],
  hostHermes: boolean,
): string {
  if (!connected) return 'Harness offline';
  if (hostHermes) return 'Hermes connected';
  if (!loaded) return 'Harness connected';
  const live = instances.filter((instance) => instance.state === 'available').map((instance) => instance.displayName);
  if (live.length === 0) return 'No engine connected';
  if (live.length === 1) return `${live[0]} connected`;
  const shown = live.slice(0, 3).join(', ');
  return live.length > 3 ? `${shown} +${live.length - 3} connected` : `${shown} connected`;
}

/** Below this the sidebar becomes a drawer rather than eating the whole window. */
const MOBILE_BREAKPOINT = 768;

export function App() {
  const store = useStore();
  const { state, dispatch } = store;
  const seenNotice = useRef<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [appSettings, setAppSettings] = useState(false);
  const [newBot, setNewBot] = useState(false);
  const [palette, setPalette] = useState(false);
  const [call, setCall] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hostHermes, setHostHermes] = useState(false);

  useEffect(() => {
    if (!state.connected) return;
    void api
      .get<{ connected: boolean }>('/api/hermes')
      .then((status) => setHostHermes(status.connected))
      .catch(() => setHostHermes(false));
  }, [state.connected]);

  const bot = selectedBot(state);
  const group = selectedGroup(state);
  const workspaceBot = state.bots.find((b) => b.id === (state.drawerBotId ?? state.selected?.id)) ?? bot;

  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Skin, theme, and locale are applied before anything else paints.
  useEffect(() => {
    const config = state.config;
    if (!config) return;
    setLocale(config.language);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = config.theme === 'dark' || (config.theme === 'system' && prefersDark);
    // The theme toggle maps to the first skin of that half unless one is chosen.
    const skin = config.skin || (dark ? 'midnight' : 'white');
    document.documentElement.dataset.skin = skin;
    document.documentElement.style.colorScheme = ['midnight', 'foundry'].includes(skin) ? 'dark' : 'light';
  }, [state.config]);

  // Unread badge from bots and rooms together.
  useEffect(() => {
    const unread = state.bots.filter((b) => b.unread && !b.hidden).length + state.groups.filter((g) => g.unread).length;
    document.title = unread ? `(${unread}) HarnessBot` : 'HarnessBot';
    void window.hb?.setBadge?.(unread);
  }, [state.bots, state.groups]);

  // A harness notice becomes a native notification. The click handler opens that bot and task.
  useEffect(() => {
    const notice = state.notifications[0];
    if (!notice || notice.id === seenNotice.current) return;
    seenNotice.current = notice.id;
    void window.hb?.notify?.({
      botId: notice.botId,
      botName: notice.botName,
      threadId: notice.threadId,
      taskTitle: notice.taskTitle || 'Task',
      kind: notice.kind,
      preview: notice.preview,
    });
  }, [state.notifications]);

  useEffect(() => {
    return window.hb?.onOpenThread?.((target) => {
      void jumpToThread(store, target.threadId, target.botId);
    });
  }, [store]);

  // Select something as soon as there is something to select.
  useEffect(() => {
    if (state.selected || !state.bots.length) return;
    const first = state.bots.find((b) => !b.hidden);
    if (first) dispatch({ type: 'select', selected: { kind: 'bot', id: first.id } });
  }, [state.bots, state.selected, dispatch]);

  useEffect(() => {
    const visible = state.bots.filter((b) => !b.hidden);
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === 'Escape') {
          setPanel(null);
          setPalette(false);
          setDrawerOpen(false);
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        setNewBot(true);
      } else if (key === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (/^[1-9]$/.test(e.key)) {
        const target = visible[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: 'select', selected: { kind: 'bot', id: target.id } });
        }
      } else if (e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        const index = visible.findIndex((b) => b.id === state.selected?.id);
        const next = visible[(index + (e.key === ']' ? 1 : -1) + visible.length) % visible.length];
        if (next) dispatch({ type: 'select', selected: { kind: 'bot', id: next.id } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.bots, state.selected, dispatch]);

  if (!state.connected) {
    return (
      <div className="grid h-full place-items-center" style={{ background: 'var(--color-app)' }}>
        <div className="max-w-sm text-center">
          <div className="text-[15px] font-semibold">Connecting to the harness…</div>
          <div className="mt-1 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
            The app talks to a local server on 127.0.0.1:8799. If this stays up, the harness is not
            running — start it with <code className="font-mono">pnpm dev:all</code>.
          </div>
        </div>
      </div>
    );
  }

  if (state.config && !state.config.onboardedAt) {
    return <Onboarding onDone={() => void 0} />;
  }

  const openView = (view: 'calendar' | 'skills' | 'team' | 'plugins' | 'recorder' | 'history' | 'workflows'): void => {
    dispatch({ type: 'view', view });
    setDrawerOpen(false);
  };

  const sidebar = (
    <Sidebar onNewBot={() => setNewBot(true)} onOpenSettings={() => setAppSettings(true)} onOpenView={openView} />
  );

  // The calendar wants the full width, so it hides the roster while it is open.
  const hideSidebar = state.view === 'calendar';

  const centre = (() => {
    switch (state.view) {
      case 'calendar':
        return <RoutineCalendarPage />;
      case 'history':
        return <HistoryPage />;
      case 'workflows':
        return <WorkflowsPage />;
      case 'skills':
        return <SkillsPage />;
      case 'recorder':
        return <SkillRecorderPage />;
      case 'team':
        return <TeamMapPage />;
      case 'plugins':
        return <PluginsPanel />;
      case 'vm':
        return workspaceBot ? <LocalVmWorkspace bot={workspaceBot} /> : null;
      case 'browser':
        return workspaceBot ? <BrowserWorkspace bot={workspaceBot} /> : null;
      default:
        if (noEngines(state)) return <NoEngines onOpenSettings={() => setAppSettings(true)} />;
        if (bot) return <ChatView bot={bot} onOpenPanel={setPanel} />;
        if (group) return <GroupView group={group} />;
        return (
          <div className="grid flex-1 place-items-center" style={{ background: 'var(--color-app)' }}>
            <div className="max-w-sm text-center">
              <div className="text-[15px] font-semibold">No bots yet</div>
              <div className="mt-1 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Create one, or import a team package from Markdown.
              </div>
              <button
                type="button"
                onClick={() => setNewBot(true)}
                className="mt-3 rounded-lg px-4 py-2 text-[13px]"
                style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
              >
                New bot
              </button>
            </div>
          </div>
        );
    }
  })();

  // The right rail belongs to the chat view; a workspace page already owns that space.
  const railBot = state.view === 'chat' ? bot : undefined;

  const barButton = (icon: Parameters<typeof Icon>[0]['name'], label: string, onClick: () => void): React.ReactNode => (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex items-center gap-1.5 rounded-lg px-2 py-1"
      style={{ color: 'var(--color-ink-secondary)' }}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );

  const connectedAs = harnessLabel(state.connected, state.instancesLoaded, state.instances, hostHermes);

  return (
    <div className="flex h-full flex-col">
      {/*
       * The status bar sits at the top, not the bottom. Whether the harness is up is
       * the first thing that matters when a reply never comes, and a strip under the
       * composer is the last place anyone looks.
       */}
      <header
        className="flex items-center gap-3 border-b px-3 py-1 text-[11px] hairline"
        style={{ background: 'var(--color-panel)', color: 'var(--color-ink-secondary)' }}
      >
        {narrow ? (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            title="Open the roster"
            aria-label="Open the roster"
            className="grid h-6 w-6 place-items-center rounded-lg"
            style={{ background: 'var(--color-raised)' }}
          >
            <Icon name="menu" size={14} />
          </button>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5" role="status">
          <span style={{ color: state.connected ? 'var(--color-success)' : 'var(--color-warning)' }}>
            <Icon name="plug" size={13} />
          </span>
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: state.connected ? 'var(--color-success)' : 'var(--color-warning)' }}
          />
          <span className="truncate" title={connectedAs}>
            {connectedAs}
          </span>
        </span>
        <NotificationCentre />
        <span className="flex-1" />
        <UsageChip />
        {bot ? barButton('phone', 'Call', () => setCall(bot.id)) : null}
        {barButton('search', 'Search', () => setPalette(true))}
        {barButton('gear', 'Settings', () => setAppSettings(true))}
      </header>
      <BusyStrip />

      <div className="relative flex min-h-0 flex-1">
        {narrow ? (
          <>
            {drawerOpen ? (
              <>
                <div className="fixed inset-0 z-30" style={{ background: '#0009' }} onClick={() => setDrawerOpen(false)} />
                <div className="anim-drawer fixed inset-y-0 left-0 z-40 flex">{sidebar}</div>
              </>
            ) : null}
          </>
        ) : hideSidebar ? null : (
          sidebar
        )}

        {centre}

        {railBot && panel === 'computer' ? <ComputerPanel bot={railBot} onClose={() => setPanel(null)} /> : null}
        {railBot && panel === 'inspector' ? <InspectorPanel bot={railBot} onClose={() => setPanel(null)} /> : null}
        {railBot && panel === 'memory' ? <MemoryPanel bot={railBot} onClose={() => setPanel(null)} /> : null}
        {railBot && panel === 'settings' ? <BotSettingsPanel bot={railBot} onClose={() => setPanel(null)} /> : null}

        {/*
         * Team-map Chat stays on the map. The conversation slides over the right
         * edge; it does not replace the chart with the full chat page. Opening a
         * bot from the roster still uses the full chat view.
         */}
        {state.view === 'team' && state.drawerBotId ? (
          <>
            <div
              className="absolute inset-0 z-30"
              style={{ background: '#0004' }}
              onClick={() => dispatch({ type: 'drawer', botId: null })}
            />
            <div
              className="anim-drawer absolute inset-y-0 right-0 z-40 flex max-w-full"
              style={{ boxShadow: '-12px 0 32px #0000002e' }}
            >
              <ChatDrawer />
            </div>
          </>
        ) : state.view !== 'chat' && state.drawerBotId ? (
          narrow ? (
            <>
              <div className="fixed inset-0 z-30" style={{ background: '#0009' }} onClick={() => dispatch({ type: 'drawer', botId: null })} />
              <div className="anim-drawer fixed inset-y-0 right-0 z-40 flex max-w-full" style={{ width: 'min(100%, 420px)' }}>
                <ChatDrawer />
              </div>
            </>
          ) : (
            <ChatDrawer />
          )
        ) : null}
      </div>

      {newBot ? <NewBotDialog onClose={() => setNewBot(false)} /> : null}
      {appSettings ? <SettingsModal onClose={() => setAppSettings(false)} /> : null}
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      {call ? <CallView botId={call} onClose={() => setCall(null)} /> : null}
    </div>
  );
}

declare global {
  interface Window {
    hb?: {
      platform?: string;
      setBadge?: (count: number) => void;
      notify?: (notice: { botId: string; botName: string; threadId: string; taskTitle: string; kind: string; preview: string }) => Promise<{ shown: boolean; reason?: string }>;
      onOpenThread?: (cb: (target: { botId: string; threadId: string }) => void) => () => void;
      getPresence?: () => Promise<{ tray: boolean; openAtLogin: boolean; platform: string }>;
      setPresence?: (patch: { tray?: boolean; openAtLogin?: boolean }) => Promise<{ tray: boolean; openAtLogin: boolean; platform: string }>;
    };
  }
}
