import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotRecord, GroupRecord } from '../../shared/types.ts';
import { api } from '../api.ts';
import { t } from '../i18n.ts';
import { jumpToMessage, SIDEBAR_AVATARS, SIDEBAR_COMPACT, SIDEBAR_MAX, SIDEBAR_MIN, useStore } from '../store.tsx';
import { ActivityDot, Avatar } from './Avatar.tsx';
import { Icon, type IconName } from './Icons.tsx';

/**
 * The roster. Bots behave like contacts: pin, unread, hide, duplicate, sections.
 * Hidden bots leave the roster and stop being @mention candidates, but hiding is not
 * deleting and the menu says so.
 *
 * Width is the user's call — 272 for the named list, 56 for avatars only when the
 * chart or a workspace needs the room. The old "Roomy" density is gone.
 */

type Density = 'compact' | 'avatars';

function BotActionMenu({ bot, onClose }: { bot: BotRecord; onClose: () => void }) {
  const { refreshBots } = useStore();
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    await fn();
    await refreshBots();
    onClose();
  };

  const item = (label: string, run: () => Promise<unknown>, danger?: boolean) => (
    <button
      type="button"
      onClick={() => void act(run)}
      className="block w-full px-3 py-1.5 text-left text-[13px] hover:opacity-80"
      style={{ color: danger ? 'var(--color-danger)' : 'var(--color-ink)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="card anim-pop absolute right-2 z-30 w-56 py-1" style={{ background: 'var(--color-raised)' }}>
      {item(bot.pinned ? 'Unpin' : 'Pin', () => api.patch(`/api/bots/${bot.id}`, { pinned: !bot.pinned }))}
      {item('Mark unread', () => api.patch(`/api/bots/${bot.id}`, { unread: true }))}
      {item('Duplicate', () => api.post(`/api/bots/${bot.id}/duplicate`))}
      {item('Copy conversation ID', async () => navigator.clipboard.writeText(bot.threadId))}
      {item(bot.hidden ? 'Unhide' : 'Hide from roster', () => api.patch(`/api/bots/${bot.id}`, { hidden: !bot.hidden }))}
      {item(
        'Delete',
        async () => {
          // Hiding is reversible; deleting takes the transcripts with it.
          if (window.confirm(`Delete ${bot.name} and every task in it? This cannot be undone.`)) {
            await api.del(`/api/bots/${bot.id}`);
          }
        },
        true,
      )}
    </div>
  );
}

function BotTile({
  bot,
  selected,
  density,
  onSelect,
}: {
  bot: BotRecord;
  selected: boolean;
  density: Density;
  onSelect: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const avatarsOnly = density === 'avatars';
  const size = avatarsOnly ? 28 : 26;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onSelect}
        title={avatarsOnly ? `${bot.name}${bot.title ? ` — ${bot.title}` : ''}` : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        className={`flex w-full items-center gap-2 rounded-xl text-left ${avatarsOnly ? 'justify-center px-0.5 py-1' : 'px-2 py-1'}`}
        style={{ background: selected ? 'var(--color-raised)' : 'transparent' }}
      >
        <span className="relative shrink-0">
          <Avatar name={bot.name} color={bot.color} activity={bot.activity} expression={bot.mascotExpression} avatarUrl={bot.avatarUrl} size={size} />
          {avatarsOnly && bot.unread ? (
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-accent)', border: '2px solid var(--color-panel)' }} />
          ) : null}
        </span>

        {avatarsOnly ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{bot.name}</span>
                {bot.chiefOfStaff ? (
                  <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                    chief
                  </span>
                ) : null}
                <ActivityDot activity={bot.activity} />
              </span>
            </span>
            {bot.unread ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--color-accent)' }} aria-label="unread" /> : null}
          </>
        )}
      </button>

      {menu ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
          <BotActionMenu bot={bot} onClose={() => setMenu(false)} />
        </>
      ) : null}
    </div>
  );
}

function RoomRow({
  group,
  selected,
  density,
  memberCount,
  onSelect,
}: {
  group: GroupRecord;
  selected: boolean;
  density: Density;
  memberCount: number;
  onSelect: () => void;
}) {
  const avatarsOnly = density === 'avatars';
  return (
    <button
      type="button"
      onClick={onSelect}
      title={avatarsOnly ? `${group.name} · ${memberCount}` : undefined}
      className={`flex w-full items-center gap-2 rounded-xl text-left ${avatarsOnly ? 'justify-center px-0.5 py-1' : 'px-2 py-1.5'}`}
      style={{ background: selected ? 'var(--color-raised)' : 'transparent' }}
    >
      <span
        className="grid shrink-0 place-items-center rounded-xl text-[13px]"
        style={{ background: 'var(--color-inset)', width: avatarsOnly ? 28 : 30, height: avatarsOnly ? 28 : 30 }}
      >
        #
      </span>
      {avatarsOnly ? null : (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{group.name}</span>
          </span>
          {group.unread ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--color-accent)' }} /> : null}
        </>
      )}
    </button>
  );
}

function SectionHeader({ label, count, density }: { label: string; count?: number; density: Density }) {
  if (density === 'avatars') return <div className="mx-auto my-2 h-px w-6" style={{ background: 'var(--color-hairline)' }} />;
  return (
    <div className="flex items-center gap-1.5 px-2 pt-3 pb-1">
      <span className="text-[11px] font-semibold tracking-wide uppercase" style={{ color: 'var(--color-ink-secondary)' }}>
        {label}
      </span>
      {count !== undefined ? (
        <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)', opacity: 0.7 }}>
          {count}
        </span>
      ) : null}
    </div>
  );
}

export function Sidebar({
  onNewBot,
  onOpenSettings,
  onOpenView,
}: {
  onNewBot: () => void;
  onOpenSettings: () => void;
  onOpenView: (view: 'calendar' | 'skills' | 'team' | 'plugins' | 'recorder') => void;
}) {
  const store = useStore();
  const { state, dispatch } = store;
  const { width, density, workspaceOpen } = state.sidebar;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{
    bots: { id: string; name: string; title: string }[];
    messages: { threadId: string; message: { id: string; text?: string } }[];
  } | null>(null);
  const resizing = useRef(false);
  // The grip's own highlight needs a render; a ref alone would never repaint it.
  const [gripping, setGripping] = useState(false);

  const avatarsOnly = density === 'avatars';
  const visible = useMemo(() => state.bots.filter((b) => !b.hidden), [state.bots]);
  const rooms = useMemo(() => state.groups.filter((g) => !g.dm), [state.groups]);
  const botChats = useMemo(() => state.groups.filter((g) => g.dm), [state.groups]);
  const pinned = visible.filter((b) => b.pinned);

  const sections = useMemo(() => {
    const map = new Map<string, BotRecord[]>();
    for (const bot of visible) {
      if (bot.pinned) continue;
      const key = bot.section ?? '';
      map.set(key, [...(map.get(key) ?? []), bot]);
    }
    return [...map.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
  }, [visible]);

  // Drag-to-resize. Pointer events on the window so the drag survives leaving the grip.
  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      resizing.current = true;
      setGripping(true);
      const startX = event.clientX;
      const startWidth = width;

      const onMove = (e: PointerEvent): void => {
        if (!resizing.current) return;
        const raw = startWidth + (e.clientX - startX);
        // Collapsing past the narrow end snaps to avatars rather than a cramped list.
        if (raw <= SIDEBAR_MIN) {
          dispatch({ type: 'sidebar', sidebar: { width: SIDEBAR_AVATARS, density: 'avatars' } });
        } else {
          dispatch({ type: 'sidebar', sidebar: { width: Math.min(SIDEBAR_MAX, raw), density: 'compact' } });
        }
      };
      const onUp = (): void => {
        resizing.current = false;
        setGripping(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width, dispatch],
  );

  useEffect(() => {
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void api.get<NonNullable<typeof results>>(`/api/search?q=${encodeURIComponent(query)}`).then(setResults);
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const select = (kind: 'bot' | 'group', id: string): void => {
    dispatch({ type: 'select', selected: { kind, id } });
    void api.post(kind === 'bot' ? `/api/bots/${id}/read` : `/api/groups/${id}/read`);
  };

  const workspaceItems: { label: string; icon: IconName; view: Parameters<typeof onOpenView>[0] }[] = [
    { label: 'Team map', icon: 'map', view: 'team' },
    { label: 'Skills', icon: 'book', view: 'skills' },
    { label: 'Teach a skill', icon: 'record', view: 'recorder' },
    { label: 'Calendar', icon: 'calendar', view: 'calendar' },
    { label: 'Connected apps', icon: 'apps', view: 'plugins' },
  ];

  const unreadTotal = visible.filter((b) => b.unread).length + rooms.filter((g) => g.unread).length;

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r hairline"
      style={{ width, background: 'var(--color-panel)' }}
      aria-label="Roster"
    >
      <div className={`flex items-center gap-2 pt-2 ${avatarsOnly ? 'flex-col px-0.5' : 'px-2'}`}>
        {avatarsOnly ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'sidebar', sidebar: { density: 'compact', width: SIDEBAR_COMPACT } })}
            title="Expand the roster"
            aria-label="Expand the roster"
            className="grid h-8 w-8 place-items-center rounded-lg"
            style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        ) : (
          <span className="relative flex min-w-0 flex-1 items-center">
            <span className="pointer-events-none absolute left-2" style={{ color: 'var(--color-ink-secondary)' }}>
              <Icon name="search" size={14} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder={t('app.search')}
              aria-label={t('app.search')}
              className="min-w-0 flex-1 rounded-lg py-1.5 pr-2 pl-7 text-[13px]"
              style={{ background: 'var(--color-inset)', color: 'var(--color-ink)' }}
            />
          </span>
        )}
        <button
          type="button"
          onClick={onNewBot}
          title={t('app.newBot')}
          aria-label={t('app.newBot')}
          className={`flex items-center justify-center gap-1 rounded-lg text-[13px] font-medium ${avatarsOnly ? 'h-8 w-8' : 'px-2.5 py-1.5'}`}
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
        >
          <Icon name="plus" size={avatarsOnly ? 18 : 14} />
          {avatarsOnly ? null : 'New'}
        </button>
      </div>

      <div className={`scroll-thin flex-1 overflow-y-auto pb-2 ${avatarsOnly ? 'px-0.5' : 'px-2'}`}>
        {results ? (
          <div className="pt-2">
            {/* Search replaces the roster; Escape puts it back. */}
            <SectionHeader label="Bots" count={results.bots.length} density="compact" />
            {results.bots.map((b) => (
              <button key={b.id} type="button" onClick={() => select('bot', b.id)} className="block w-full rounded-lg px-2 py-1 text-left text-[13px]">
                {b.name}
                <span className="ml-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  {b.title}
                </span>
              </button>
            ))}
            <SectionHeader label="Messages" count={results.messages.length} density="compact" />
            {results.messages.slice(0, 30).map((hit) => (
              <button
                key={hit.message.id}
                type="button"
                onClick={() => void jumpToMessage(store, hit.threadId, hit.message.id)}
                className="block w-full rounded-lg px-2 py-1 text-left text-[12px]"
                style={{ color: 'var(--color-ink-secondary)' }}
              >
                {hit.message.text?.slice(0, 90)}
              </button>
            ))}
            {results.bots.length + results.messages.length === 0 ? (
              <div className="px-2 py-3 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                Nothing matched.
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {pinned.length ? (
              <>
                <SectionHeader label={t('sidebar.pinned')} count={pinned.length} density={density} />
                {pinned.map((bot) => (
                  <BotTile key={bot.id} bot={bot} density={density} selected={state.selected?.id === bot.id} onSelect={() => select('bot', bot.id)} />
                ))}
              </>
            ) : null}

            {rooms.length ? (
              <>
                <SectionHeader label={t('sidebar.channels')} count={rooms.length} density={density} />
                {rooms.map((group) => (
                  <RoomRow
                    key={group.id}
                    group={group}
                    density={density}
                    memberCount={group.memberIds.length}
                    selected={state.selected?.id === group.id}
                    onSelect={() => select('group', group.id)}
                  />
                ))}
              </>
            ) : null}

            {/* Bot-to-bot DMs, so peer traffic is readable instead of invisible. */}
            {botChats.length ? (
              <>
                <SectionHeader label="Bot chats" count={botChats.length} density={density} />
                {botChats.map((group) => (
                  <RoomRow
                    key={group.id}
                    group={group}
                    density={density}
                    memberCount={group.memberIds.length}
                    selected={state.selected?.id === group.id}
                    onSelect={() => select('group', group.id)}
                  />
                ))}
              </>
            ) : null}

            {sections.map(([section, bots]) => (
              <div key={section}>
                <SectionHeader label={section || t('sidebar.bots')} count={bots.length} density={density} />
                {/* One column everywhere: two columns of name + subtitle only truncates both. */}
                <div className="flex flex-col gap-0.5">
                  {bots.map((bot) => (
                    <BotTile key={bot.id} bot={bot} density={density} selected={state.selected?.id === bot.id} onSelect={() => select('bot', bot.id)} />
                  ))}
                </div>
              </div>
            ))}

            {visible.length === 0 ? (
              <div className="px-2 py-6 text-center text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
                No bots yet. Create one, or import a team package.
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className={`border-t pt-1 pb-2 hairline ${avatarsOnly ? 'px-0.5' : 'px-2'}`}>
        <button
          type="button"
          onClick={() => dispatch({ type: 'sidebar', sidebar: { workspaceOpen: !workspaceOpen } })}
          aria-expanded={workspaceOpen}
          className={`flex w-full items-center rounded-lg ${avatarsOnly ? 'justify-center px-0 py-1' : 'gap-1.5 px-2 py-1'}`}
          style={{ color: 'var(--color-ink-secondary)' }}
          title={workspaceOpen ? 'Hide workspace' : 'Show workspace'}
          aria-label={workspaceOpen ? 'Hide workspace' : 'Show workspace'}
        >
          {avatarsOnly ? (
            <Icon name={workspaceOpen ? 'chevronDown' : 'apps'} size={16} />
          ) : (
            <>
              <span className="flex-1 text-left text-[11px] font-semibold tracking-wide uppercase">{t('sidebar.workspace')}</span>
              <Icon name={workspaceOpen ? 'chevronDown' : 'chevronRight'} size={12} />
            </>
          )}
        </button>

        {workspaceOpen ? (
          <div className={avatarsOnly ? 'flex flex-col items-center gap-1' : 'grid grid-cols-2 gap-1'}>
            {workspaceItems.map((item) => {
              const active = state.view === item.view;
              return (
                <button
                  key={item.view}
                  type="button"
                  onClick={() => onOpenView(item.view)}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center rounded-lg text-[12px] ${avatarsOnly ? 'h-8 w-8 justify-center' : 'gap-1.5 px-2 py-1.5 text-left'}`}
                  style={{
                    background: active ? 'var(--color-raised)' : 'var(--color-inset)',
                    color: active ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
                    boxShadow: active ? 'inset 2px 0 0 var(--color-accent)' : undefined,
                  }}
                >
                  <Icon name={item.icon} size={avatarsOnly ? 15 : 14} />
                  {avatarsOnly ? null : <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className={`mt-2 flex items-center gap-1 ${avatarsOnly ? 'flex-col' : ''}`}>
          {!avatarsOnly ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'sidebar', sidebar: { density: 'avatars', width: SIDEBAR_AVATARS } })}
              title="Avatars only"
              aria-label="Collapse to avatars only"
              className="grid h-8 w-8 place-items-center rounded-lg"
              style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}
            >
              <Icon name="chevronLeft" size={14} />
            </button>
          ) : null}

          <button
            type="button"
            onClick={onOpenSettings}
            title={t('app.settings')}
            className={`flex items-center justify-center gap-1 rounded-lg text-[12px] ${avatarsOnly ? 'h-8 w-8' : 'ml-auto px-2 py-1.5'}`}
            style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}
            aria-label={unreadTotal ? `${t('app.settings')} — ${unreadTotal} unread` : t('app.settings')}
          >
            <Icon name="gear" size={avatarsOnly ? 15 : 14} />
            {!avatarsOnly && unreadTotal ? <span className="tabular-nums">{unreadTotal}</span> : null}
          </button>
        </div>
      </div>

      {/* Grip sits just past the border so the whole edge is grabbable. */}
      <div
        className={`resize-grip ${gripping ? 'active' : ''}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the roster"
      />
    </aside>
  );
}
