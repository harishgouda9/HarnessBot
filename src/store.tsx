import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { BotRecord, GroupRecord, Message, Routine, RoutineRun } from '../shared/types.ts';
import { api, streamEvents, type EventStream } from './api.ts';

/**
 * One store, one reducer, one SSE stream.
 *
 * Every piece of server state the UI shows arrives through the SSE fold below. There
 * is deliberately no second write path: an optimistic local mutation that the server
 * later contradicts is how transcripts start disagreeing with the harness.
 */

export interface InstanceSnapshot {
  instanceId: string;
  driver: string;
  /** The executable, which is not the driver kind: `cursor` runs `cursor-agent`. */
  bin?: string;
  displayName: string;
  accentColor?: string;
  state: 'available' | 'unavailable';
  reason?: string;
  models: { id: string; label: string; default?: boolean; extra?: boolean }[];
  capabilities: {
    images: boolean;
    steer: boolean;
    queueing: boolean;
    effortLevels: string[];
    sessionModelSwitch: boolean;
    computerMcp: boolean;
    composioMcp: boolean;
    agentsMcp: boolean;
    phoneMcp: boolean;
    browserMcp: boolean;
    customMcp: boolean;
  };
}

export interface PublicConfig {
  /** `environmentKeys`, never `environment`: the renderer sees which vars are set, not their values. */
  instances: Record<
    string,
    {
      driver: string;
      displayName?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      environmentKeys?: string[];
      extraModels?: { id: string; label?: string }[];
    }
  >;
  mcpServers: { name: string; enabled: boolean; transport: string; command?: string; url?: string; args?: string[]; env?: Record<string, string> }[];
  vps: { sshAlias?: string };
  room: { turnTimeoutMinutes: number };
  localVm: { mode: 'shared' | 'per-bot'; maxInstances: number };
  defaultComputer?: 'cloud' | 'vm' | 'local' | 'off';
  lean?: { enabled: boolean; preferSmallModel: boolean };
  browserProfiles: { id: string; name: string }[];
  language: string;
  skin: string;
  voice: string;
  theme: 'light' | 'dark' | 'system';
  updates: 'Automatic' | 'Manual';
  showToolCalls: boolean;
  experimental: { skillRecorder: boolean; embeddedBrowser: boolean };
  onboardedAt?: number;
  /** Booleans only. The renderer never sees a key value. */
  configured: Record<string, boolean>;
}

export interface OrgNode {
  id: string;
  name: string;
  title: string;
  color: string;
  section: string;
  chiefOfStaff: boolean;
  reportsTo?: string;
  activity?: string;
  unread?: boolean;
  avatarUrl?: string;
  mascotExpression?: string | null;
  pos?: { x: number; y: number };
}

export interface OrgLink {
  id: string;
  from: string;
  to: string;
  kind: 'dotted' | 'peer' | 'flow' | 'workflow';
  label?: string;
  step?: number;
}

export interface OrgChart {
  id: string;
  name: string;
  botIds: string[];
  positions?: Record<string, { x: number; y: number }>;
  createdAt: number;
}

export interface OrgGraph {
  nodes: OrgNode[];
  links: OrgLink[];
  charts: OrgChart[];
}

export interface Notification {
  id: string;
  botId: string;
  botName: string;
  threadId: string;
  kind: 'needs-approval' | 'needs-hands' | 'finished' | 'failed';
  preview: string;
  at: number;
}

export interface RuntimeTrace {
  at: number;
  threadId: string;
  type: string;
  detail: string;
}

export interface State {
  connected: boolean;
  bots: BotRecord[];
  groups: GroupRecord[];
  /** Empty means "not asked yet" — it must not be read as "no engines". */
  instances: InstanceSnapshot[];
  instancesLoaded: boolean;
  config: PublicConfig | null;
  threads: Record<string, { messages: Message[]; activeLeafId: string | null; loaded: boolean }>;
  /**
   * Messages that arrived while a snapshot for that thread was in flight.
   * The GET can be older than the SSE that followed it; dropping those is how a
   * reply disappears until the thread is opened again.
   */
  inflight: Record<string, Message[]>;
  fetchGen: Record<string, number>;
  routines: Routine[];
  runs: RoutineRun[];
  notifications: Notification[];
  /** Streaming deltas, per thread. Shown in the inspector, never painted into a bubble. */
  streaming: Record<string, string>;
  trace: RuntimeTrace[];
  selected: { kind: 'bot' | 'group'; id: string } | null;
  view: 'chat' | 'calendar' | 'skills' | 'team' | 'plugins' | 'recorder' | 'vm' | 'browser';
  /**
   * The chat drawer. It keeps a bot conversation open on the right while a workspace
   * page owns the centre, so opening the org chart does not mean losing your place.
   */
  drawerBotId: string | null;
  /** Live desktop frames, newest per bot. Never persisted — preview is not history. */
  screens: Record<string, { png: string; mime: string; at: number }>;
  orgGraph: OrgGraph | null;
  browserTabs: Record<string, { botId: string; profileId: string; url: string; title: string; loading: boolean }>;
  sidebar: { width: number; density: 'compact' | 'avatars'; workspaceOpen: boolean };
  /**
   * A message to scroll to and flash. Search, the palette, and find-in-chat all end
   * in the same place — a hit you cannot jump to is a hit you have to find twice.
   */
  focusMessageId: string | null;
}

/**
 * Sidebar width and density are per-machine furniture, not workspace state, so they
 * live in localStorage rather than travelling to the harness and back.
 */
const SIDEBAR_KEY = 'hb.sidebar';
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 460;
export const SIDEBAR_COMPACT = 272;
export const SIDEBAR_AVATARS = 56;

function loadSidebarPrefs(): State['sidebar'] {
  const fallback = { width: SIDEBAR_COMPACT, density: 'compact' as const, workspaceOpen: true };
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<State['sidebar']> & { density?: string };
    // Roomy (comfortable) is gone — it was a wider list with subtitles. Treat it as compact.
    const density: State['sidebar']['density'] = parsed.density === 'avatars' ? 'avatars' : 'compact';
    return {
      width: density === 'avatars' ? SIDEBAR_AVATARS : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number(parsed.width) || fallback.width)),
      density,
      workspaceOpen: typeof parsed.workspaceOpen === 'boolean' ? parsed.workspaceOpen : density !== 'avatars',
    };
  } catch {
    // Private window, cleared storage, or a browser blocking site data.
    return fallback;
  }
}

function saveSidebarPrefs(sidebar: State['sidebar']): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebar));
  } catch {
    /* not worth surfacing */
  }
}

export const initialState: State = {
  connected: false,
  bots: [],
  groups: [],
  instances: [],
  instancesLoaded: false,
  config: null,
  threads: {},
  inflight: {},
  fetchGen: {},
  routines: [],
  runs: [],
  notifications: [],
  streaming: {},
  trace: [],
  selected: null,
  view: 'chat',
  drawerBotId: null,
  screens: {},
  orgGraph: null,
  browserTabs: {},
  sidebar: loadSidebarPrefs(),
  focusMessageId: null,
};

type Action =
  | { type: 'connected'; value: boolean }
  | { type: 'bots'; bots: BotRecord[] }
  | { type: 'bot'; bot: BotRecord }
  | { type: 'bot.deleted'; id: string }
  | { type: 'groups'; groups: GroupRecord[] }
  | { type: 'group'; group: GroupRecord }
  | { type: 'group.deleted'; id: string }
  | { type: 'instances'; instances: InstanceSnapshot[] }
  | { type: 'config'; config: PublicConfig }
  | { type: 'thread.fetch'; threadId: string; gen: number }
  | { type: 'thread'; threadId: string; messages: Message[]; activeLeafId: string | null; gen?: number }
  | { type: 'thread.activeLeaf'; threadId: string; activeLeafId: string | null }
  | { type: 'message'; threadId: string; message: Message }
  | { type: 'message.patch'; threadId: string; message: Message }
  | { type: 'thread.deleted'; threadId: string }
  | { type: 'routines'; routines: Routine[] }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine.deleted'; id: string }
  | { type: 'runs'; runs: RoutineRun[] }
  | { type: 'notify'; notification: Notification }
  | { type: 'notifications'; notifications: Notification[] }
  | { type: 'stream'; threadId: string; delta: string }
  | { type: 'stream.clear'; threadId: string }
  | { type: 'trace'; trace: RuntimeTrace }
  | { type: 'select'; selected: State['selected'] }
  | { type: 'view'; view: State['view'] }
  | { type: 'drawer'; botId: string | null }
  | { type: 'screen'; botId: string; png: string; mime: string; at: number }
  | { type: 'org-graph'; graph: OrgGraph }
  | { type: 'browser'; tab: { botId: string; profileId: string; url: string; title: string; loading: boolean } }
  | { type: 'sidebar'; sidebar: Partial<State['sidebar']> }
  | { type: 'focus'; messageId: string | null };

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const index = list.findIndex((x) => x.id === item.id);
  if (index < 0) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
};

function rememberInflight(state: State, threadId: string, message: Message): State['inflight'] {
  const pending = state.inflight[threadId];
  if (!pending || pending.some((m) => m.id === message.id)) return state.inflight;
  return { ...state.inflight, [threadId]: [...pending, message] };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: action.value };
    case 'bots':
      return { ...state, bots: action.bots };
    case 'bot':
      return { ...state, bots: upsert(state.bots, action.bot) };
    case 'bot.deleted':
      return {
        ...state,
        bots: state.bots.filter((b) => b.id !== action.id),
        selected: state.selected?.id === action.id ? null : state.selected,
      };
    case 'groups':
      return { ...state, groups: action.groups };
    case 'group':
      return { ...state, groups: upsert(state.groups, action.group) };
    case 'group.deleted':
      return {
        ...state,
        groups: state.groups.filter((g) => g.id !== action.id),
        selected: state.selected?.id === action.id ? null : state.selected,
      };
    case 'instances':
      return { ...state, instances: action.instances, instancesLoaded: true };
    case 'config':
      return { ...state, config: action.config };
    case 'thread.fetch':
      return {
        ...state,
        fetchGen: { ...state.fetchGen, [action.threadId]: action.gen },
        inflight: { ...state.inflight, [action.threadId]: state.inflight[action.threadId] ?? [] },
      };
    case 'thread': {
      // A newer fetch started, or this snapshot was already applied. Do not clobber it.
      if (action.gen !== undefined && state.fetchGen[action.threadId] !== action.gen) return state;
      const seen = new Set(action.messages.map((m) => m.id));
      const extras = (state.inflight[action.threadId] ?? []).filter((m) => !seen.has(m.id));
      const inflight = { ...state.inflight };
      const fetchGen = { ...state.fetchGen };
      delete inflight[action.threadId];
      delete fetchGen[action.threadId];
      return {
        ...state,
        inflight,
        fetchGen,
        threads: {
          ...state.threads,
          [action.threadId]: {
            messages: extras.length ? [...action.messages, ...extras] : action.messages,
            activeLeafId: extras.length ? extras[extras.length - 1]!.id : action.activeLeafId,
            loaded: true,
          },
        },
      };
    }
    case 'thread.activeLeaf': {
      const thread = state.threads[action.threadId];
      if (!thread) return state;
      return { ...state, threads: { ...state.threads, [action.threadId]: { ...thread, activeLeafId: action.activeLeafId } } };
    }
    case 'message': {
      const inflight = rememberInflight(state, action.threadId, action.message);
      const thread = state.threads[action.threadId];
      // Not loaded yet: kept on `inflight` until the snapshot lands. A message that
      // arrives after the GET read and before this dispatch used to vanish.
      if (!thread?.loaded) return inflight === state.inflight ? state : { ...state, inflight };
      if (thread.messages.some((m) => m.id === action.message.id)) {
        return inflight === state.inflight ? state : { ...state, inflight };
      }
      return {
        ...state,
        inflight,
        threads: {
          ...state.threads,
          [action.threadId]: { ...thread, messages: [...thread.messages, action.message] },
        },
      };
    }
    case 'message.patch': {
      const pending = state.inflight[action.threadId];
      const inflight = pending
        ? { ...state.inflight, [action.threadId]: pending.map((m) => (m.id === action.message.id ? action.message : m)) }
        : state.inflight;
      const thread = state.threads[action.threadId];
      if (!thread?.loaded) return inflight === state.inflight ? state : { ...state, inflight };
      return {
        ...state,
        inflight,
        threads: {
          ...state.threads,
          [action.threadId]: {
            ...thread,
            messages: thread.messages.map((m) => (m.id === action.message.id ? action.message : m)),
          },
        },
      };
    }
    case 'thread.deleted': {
      const threads = { ...state.threads };
      const inflight = { ...state.inflight };
      const fetchGen = { ...state.fetchGen };
      delete threads[action.threadId];
      delete inflight[action.threadId];
      delete fetchGen[action.threadId];
      return { ...state, threads, inflight, fetchGen };
    }
    case 'routines':
      return { ...state, routines: action.routines };
    case 'routine':
      return { ...state, routines: upsert(state.routines, action.routine) };
    case 'routine.deleted':
      return { ...state, routines: state.routines.filter((r) => r.id !== action.id) };
    case 'runs':
      return { ...state, runs: action.runs };
    case 'notify':
      return { ...state, notifications: [action.notification, ...state.notifications].slice(0, 50) };
    case 'notifications':
      return { ...state, notifications: action.notifications.slice(0, 50) };
    case 'stream':
      return { ...state, streaming: { ...state.streaming, [action.threadId]: (state.streaming[action.threadId] ?? '') + action.delta } };
    case 'stream.clear': {
      const streaming = { ...state.streaming };
      delete streaming[action.threadId];
      return { ...state, streaming };
    }
    case 'trace':
      return { ...state, trace: [action.trace, ...state.trace].slice(0, 300) };
    case 'select':
      return { ...state, selected: action.selected, view: 'chat', drawerBotId: null, focusMessageId: null };
    case 'focus':
      return { ...state, focusMessageId: action.messageId };
    case 'view':
      return { ...state, view: action.view };
    case 'drawer':
      return { ...state, drawerBotId: action.botId };
    case 'screen':
      return {
        ...state,
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime, at: action.at } },
      };
    case 'org-graph':
      return { ...state, orgGraph: action.graph };
    case 'browser':
      return {
        ...state,
        browserTabs: { ...state.browserTabs, [`${action.tab.botId}:${action.tab.profileId}`]: action.tab },
      };
    case 'sidebar': {
      const sidebar = { ...state.sidebar, ...action.sidebar };
      saveSidebarPrefs(sidebar);
      return { ...state, sidebar };
    }
    default:
      return state;
  }
}

interface StoreValue {
  state: State;
  dispatch: React.Dispatch<Action>;
  loadThread: (threadId: string, force?: boolean) => Promise<void>;
  refreshBots: () => Promise<void>;
  refreshInstances: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  refreshRoutines: () => Promise<void>;
  refreshOrgGraph: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const loading = useRef(new Set<string>());
  const fetchGen = useRef(new Map<string, number>());

  const loadThread = async (threadId: string, force = false): Promise<void> => {
    if (!threadId) return;
    if (!force && (state.threads[threadId]?.loaded || loading.current.has(threadId))) return;
    loading.current.add(threadId);
    const gen = (fetchGen.current.get(threadId) ?? 0) + 1;
    fetchGen.current.set(threadId, gen);
    dispatch({ type: 'thread.fetch', threadId, gen });
    try {
      const data = await api.get<{ messages: Message[]; activeLeafId: string | null }>(
        `/api/threads/${threadId}/messages`,
      );
      if (fetchGen.current.get(threadId) !== gen) return;
      dispatch({ type: 'thread', threadId, gen, messages: data.messages, activeLeafId: data.activeLeafId });
    } catch {
      // The harness was unreachable. Leave the thread unloaded so the next open retries.
    } finally {
      if (fetchGen.current.get(threadId) === gen) loading.current.delete(threadId);
    }
  };

  const refreshBots = async (): Promise<void> => {
    const [bots, groups] = await Promise.all([api.get<BotRecord[]>('/api/bots'), api.get<GroupRecord[]>('/api/groups')]);
    dispatch({ type: 'bots', bots });
    dispatch({ type: 'groups', groups });
  };

  const refreshInstances = async (): Promise<void> => {
    dispatch({ type: 'instances', instances: await api.get<InstanceSnapshot[]>('/api/instances') });
  };

  const refreshConfig = async (): Promise<void> => {
    dispatch({ type: 'config', config: await api.get<PublicConfig>('/api/config') });
  };

  const refreshOrgGraph = async (): Promise<void> => {
    dispatch({ type: 'org-graph', graph: await api.get<OrgGraph>('/api/org-graph') });
  };

  const refreshRoutines = async (): Promise<void> => {
    const [routines, runs] = await Promise.all([
      api.get<Routine[]>('/api/routines'),
      api.get<RoutineRun[]>('/api/calendar-calls'),
    ]);
    dispatch({ type: 'routines', routines });
    dispatch({ type: 'runs', runs });
  };

  // Initial hydrate. `connected` only flips once the harness has actually answered.
  useEffect(() => {
    void (async () => {
      try {
        await api.get('/api/health');
        dispatch({ type: 'connected', value: true });
        await Promise.all([
          refreshBots(),
          refreshInstances(),
          refreshConfig(),
          refreshRoutines(),
          // Backfill: SSE only carries what happens from now on, and a reload should
          // not lose the fact that a bot is still waiting on you.
          api
            .get<Notification[]>('/api/notifications')
            .then((notifications) => dispatch({ type: 'notifications', notifications }))
            .catch(() => undefined),
        ]);
      } catch {
        dispatch({ type: 'connected', value: false });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The single SSE fold. Reconnects on drop; sends are idempotent so a reconnect
  // never duplicates work.
  useEffect(() => {
    let source: EventStream | null = null;
    let retry: number | undefined;
    let closed = false;

    const on = (name: string, fn: (data: any) => void): void => source?.addEventListener(name, (e) => fn(JSON.parse(e.data)));

    const connect = (): void => {
      source = streamEvents('/api/events');

      source.addEventListener('open', () => dispatch({ type: 'connected', value: true }));
      on('hello', () => dispatch({ type: 'connected', value: true }));
      on('bot', (bot) => (bot.deleted ? dispatch({ type: 'bot.deleted', id: bot.id }) : dispatch({ type: 'bot', bot })));
      on('bot.deleted', (d) => dispatch({ type: 'bot.deleted', id: d.id }));
      on('group', (group) => group && dispatch({ type: 'group', group }));
      on('group.deleted', (d) => dispatch({ type: 'group.deleted', id: d.id }));
      on('message', (d) => dispatch({ type: 'message', threadId: d.threadId, message: d.message }));
      on('message.patch', (d) => dispatch({ type: 'message.patch', threadId: d.threadId, message: d.message }));
      on('thread', (d) => dispatch({ type: 'thread.activeLeaf', threadId: d.threadId, activeLeafId: d.activeLeafId }));
      on('thread.deleted', (d) => dispatch({ type: 'thread.deleted', threadId: d.threadId }));
      on('config', (config) => dispatch({ type: 'config', config }));
      on('notify', (notification) => dispatch({ type: 'notify', notification }));
      on('routine', (routine) => dispatch({ type: 'routine', routine }));
      on('routine.deleted', (d) => dispatch({ type: 'routine.deleted', id: d.id }));
      on('routine.run', () => void refreshRoutines());
      on('org-graph', (graph) => dispatch({ type: 'org-graph', graph }));
      on('browser', (tab) => dispatch({ type: 'browser', tab }));
      // Live frames. They land in state and are replaced, never appended to history.
      on('screen', (d) => dispatch({ type: 'screen', botId: d.botId, png: d.png, mime: d.mime, at: d.at }));

      on('runtime', (event) => {
        if (event.type === 'content.delta' && event.itemKind === 'assistant_text') {
          dispatch({ type: 'stream', threadId: event.threadId, delta: event.delta });
        }
        if (event.type === 'turn.completed' || event.type === 'turn.started') {
          dispatch({ type: 'stream.clear', threadId: event.threadId });
        }
        dispatch({
          type: 'trace',
          trace: {
            at: event.createdAt,
            threadId: event.threadId,
            type: event.type,
            detail: event.summary ?? event.text ?? event.toolName ?? event.message ?? event.delta ?? '',
          },
        });
      });

      source.addEventListener('error', () => {
        dispatch({ type: 'connected', value: false });
        source?.close();
        if (closed) return;
        retry = window.setTimeout(connect, 1500);
      });
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, loadThread, refreshBots, refreshInstances, refreshConfig, refreshRoutines, refreshOrgGraph }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside StoreProvider');
  return value;
}

/**
 * No engines is a specific state, not "the list happens to be empty". Showing the
 * setup screen before /api/instances has answered makes a working app look broken.
 */
export function noEngines(state: State): boolean {
  // An empty registry is still "no engines" — it just means nothing was even detected,
  // which is exactly when the setup screen is most useful.
  return state.connected && state.instancesLoaded && !state.instances.some((i) => i.state === 'available');
}

export function selectedBot(state: State): BotRecord | undefined {
  return state.selected?.kind === 'bot' ? state.bots.find((b) => b.id === state.selected!.id) : undefined;
}

export function selectedGroup(state: State): GroupRecord | undefined {
  return state.selected?.kind === 'group' ? state.groups.find((g) => g.id === state.selected!.id) : undefined;
}

/**
 * Which conversation owns a thread. A search hit is useless if clicking it does
 * nothing, and the thread may belong to a task that is not the bot's active one —
 * in which case the caller has to switch the task as well as the selection.
 */
export function ownerOfThread(
  state: State,
  threadId: string,
): { kind: 'bot' | 'group'; id: string; switchTask: boolean } | null {
  for (const bot of state.bots) {
    if (bot.threadId === threadId) return { kind: 'bot', id: bot.id, switchTask: false };
    if (bot.tasks?.some((task) => task.threadId === threadId)) return { kind: 'bot', id: bot.id, switchTask: true };
  }
  for (const group of state.groups) {
    if (group.threadId === threadId) return { kind: 'group', id: group.id, switchTask: false };
    if (group.tasks?.some((task) => task.threadId === threadId)) return { kind: 'group', id: group.id, switchTask: true };
  }
  return null;
}

/** Open a thread, switching the owning bot to that task first when it is not the active one. */
export async function jumpToThread(store: StoreValue, threadId: string, fallbackBotId?: string): Promise<boolean> {
  const owner = ownerOfThread(store.state, threadId);
  if (!owner) {
    // The thread is gone or never loaded; land on the bot rather than nowhere.
    if (fallbackBotId) store.dispatch({ type: 'select', selected: { kind: 'bot', id: fallbackBotId } });
    return false;
  }
  if (owner.switchTask && owner.kind === 'bot') {
    await api.patch(`/api/bots/${owner.id}`, { threadId });
    await store.refreshBots();
  }
  await store.loadThread(threadId, true);
  store.dispatch({ type: 'select', selected: { kind: owner.kind, id: owner.id } });
  return true;
}

/** Open the conversation a search hit belongs to, then scroll to and flash the hit. */
export async function jumpToMessage(store: StoreValue, threadId: string, messageId: string): Promise<void> {
  if (await jumpToThread(store, threadId)) store.dispatch({ type: 'focus', messageId });
}

export function snapshotFor(state: State, bot?: BotRecord): InstanceSnapshot | undefined {
  return bot ? state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId) : undefined;
}
