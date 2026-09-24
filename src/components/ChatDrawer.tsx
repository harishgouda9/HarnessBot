import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store.tsx';
import { ChatView } from './Chat.tsx';

/**
 * The chat drawer keeps a conversation open on the right while a workspace page owns
 * the centre. Opening the org chart or the calendar should not mean losing the thread
 * you were reading — the conversation is the source of truth, so it stays reachable.
 *
 * Width is furniture: it lives in localStorage next to the roster, and the left edge
 * is a real grip so a map + chat layout can be split to taste.
 */

const DRAWER_KEY = 'hb.drawer.width';
const DRAWER_MIN = 280;
const DRAWER_MAX = 720;
const DRAWER_DEFAULT = 400;

function loadWidth(): number {
  try {
    const raw = Number(localStorage.getItem(DRAWER_KEY));
    if (Number.isFinite(raw) && raw > 0) return Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, raw));
  } catch {
    /* private window or blocked site data */
  }
  return DRAWER_DEFAULT;
}

function saveWidth(width: number): void {
  try {
    localStorage.setItem(DRAWER_KEY, String(width));
  } catch {
    /* not worth surfacing */
  }
}

export function ChatDrawer() {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === state.drawerBotId);
  const [width, setWidth] = useState(loadWidth);
  const [gripping, setGripping] = useState(false);
  const resizing = useRef(false);

  useEffect(() => {
    if (!bot) return;
    const onKey = (e: KeyboardEvent): void => {
      // Escape closes the drawer, but only when nothing else has claimed it.
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        dispatch({ type: 'drawer', botId: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bot, dispatch]);

  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      resizing.current = true;
      setGripping(true);
      const startX = event.clientX;
      const startWidth = width;

      const onMove = (e: PointerEvent): void => {
        if (!resizing.current) return;
        const next = Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, startWidth - (e.clientX - startX)));
        setWidth(next);
      };
      const onUp = (): void => {
        resizing.current = false;
        setGripping(false);
        setWidth((w) => {
          saveWidth(w);
          return w;
        });
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width],
  );

  if (!bot) return null;

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l hairline"
      style={{ width, background: 'var(--color-app)' }}
      aria-label={`Chat with ${bot.name}`}
    >
      <div
        className={`resize-grip start ${gripping ? 'active' : ''}`}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat"
      />
      <ChatView bot={bot} compact={width < 360} onOpenPanel={() => {}} onClose={() => dispatch({ type: 'drawer', botId: null })} />
    </aside>
  );
}
