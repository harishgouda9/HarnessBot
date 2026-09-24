import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HarnessbotColor } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useStore, type OrgLink, type OrgNode } from '../store.tsx';
import { ActivityDot, Avatar, botColor } from './Avatar.tsx';
import { Icon, IconButton } from './Icons.tsx';
import { EngineRow, NewBotDialog } from './Overlays.tsx';

/**
 * The org canvas.
 *
 * Two things are being drawn at once and they are not the same thing: the reporting
 * spine (`reportsTo`, one manager, repaired on load) and the working graph (dotted
 * lines, peers, handoffs, numbered workflow steps). Keeping them visually distinct is
 * the whole point — a chart that renders "Ana reviews Bo's PRs" the same as "Bo
 * reports to Ana" is worse than no chart.
 */

const NODE_W = 228;
const NODE_H = 84;
const GRID = 20;

/**
 * The side panel is furniture, not workspace state, so its width lives in
 * localStorage next to the sidebar's rather than travelling to the harness.
 */
const PANEL_KEY = 'hb.teammap.panel';
const PANEL_MIN = 240;
const PANEL_MAX = 560;

function loadPanelWidth(): number {
  try {
    const raw = Number(localStorage.getItem(PANEL_KEY));
    if (Number.isFinite(raw) && raw > 0) return Math.min(PANEL_MAX, Math.max(PANEL_MIN, raw));
  } catch {
    /* private window or blocked site data */
  }
  return 300;
}

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

type LinkKind = OrgLink['kind'];

/**
 * What a drag between two cards will draw. `reports` is not a link at all — it sets
 * the manager on the bot record — but from the user's side it is the same gesture, so
 * it belongs in the same pen chooser rather than hidden in a dropdown in the panel.
 */
type PenKind = LinkKind | 'reports';

const LINK_STYLES: Record<LinkKind | 'reports', { label: string; dash?: string; width: number; arrow: boolean; hint: string }> = {
  reports: { label: 'Reports to', width: 2, arrow: true, hint: 'The spine. Drag the manager’s bottom handle onto a report. One manager per bot.' },
  dotted: { label: 'Dotted line', dash: '5 4', width: 1.6, arrow: true, hint: 'A secondary reporting line.' },
  peer: { label: 'Peer', dash: '2 4', width: 1.6, arrow: false, hint: 'A working relationship, no direction.' },
  flow: { label: 'Handoff', width: 1.8, arrow: true, hint: 'Work moves from one bot to the other.' },
  workflow: { label: 'Workflow step', width: 2.2, arrow: true, hint: 'An ordered step. Numbered, so a process reads in sequence.' },
};

const LINK_COLOR: Record<LinkKind | 'reports', string> = {
  reports: 'var(--color-ink-secondary)',
  dotted: 'var(--color-ink-secondary)',
  peer: 'var(--color-ink-secondary)',
  flow: 'var(--color-accent)',
  workflow: 'var(--color-accent)',
};

interface Point {
  x: number;
  y: number;
}

/** A hairline between toolbar groups, so the row reads as zones rather than a queue. */
const Divider = (): React.ReactElement => (
  <span className="mx-0.5 h-5 w-px shrink-0" style={{ background: 'var(--color-hairline)' }} aria-hidden="true" />
);

/** Anchor an edge to the nearest node edge rather than to its centre. */
function edgePoint(from: Point, to: Point): { a: Point; b: Point } {
  const ac = { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 };
  const bc = { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  // Mostly-vertical edges leave the top/bottom; mostly-horizontal leave the sides.
  const vertical = Math.abs(dy) * NODE_W > Math.abs(dx) * NODE_H;
  const a = vertical
    ? { x: ac.x, y: ac.y + (dy > 0 ? NODE_H / 2 : -NODE_H / 2) }
    : { x: ac.x + (dx > 0 ? NODE_W / 2 : -NODE_W / 2), y: ac.y };
  const b = vertical
    ? { x: bc.x, y: bc.y + (dy > 0 ? -NODE_H / 2 : NODE_H / 2) }
    : { x: bc.x + (dx > 0 ? -NODE_W / 2 : NODE_W / 2), y: bc.y };
  return { a, b };
}

const curve = (a: Point, b: Point): string => {
  const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
  const bend = Math.max(24, Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) / 2.4));
  const c1 = vertical ? { x: a.x, y: a.y + Math.sign(b.y - a.y) * bend } : { x: a.x + Math.sign(b.x - a.x) * bend, y: a.y };
  const c2 = vertical ? { x: b.x, y: b.y - Math.sign(b.y - a.y) * bend } : { x: b.x - Math.sign(b.x - a.x) * bend, y: b.y };
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
};

export function TeamMapPage() {
  const { state, dispatch, refreshBots, refreshOrgGraph } = useStore();
  const graph = state.orgGraph;

  const canvasRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState<Point>({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [sectionFilter, setSectionFilter] = useState('');
  const [linkKind, setLinkKind] = useState<PenKind>('reports');
  const [newBot, setNewBot] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [resizing, setResizing] = useState<{ x: number; w: number } | null>(null);
  /** Compact hides the hint strip and the pen labels, giving the canvas its height back. */
  const [compact, setCompact] = useState(false);
  const [drawGripping, setDrawGripping] = useState(false);
  const [connecting, setConnecting] = useState<{ from: string; to: Point } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const [panning, setPanning] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const [snap, setSnap] = useState(true);
  /** The right panel is opt-in. Selecting a card or a line counts as opting in. */
  const [panelOpen, setPanelOpen] = useState(false);
  const [chartName, setChartName] = useState('');
  const [error, setError] = useState('');
  /** Click a card: Profile or Chat. Dragging the card does not count as a click. */
  const [cardMenu, setCardMenu] = useState<string | null>(null);

  useEffect(() => {
    void refreshOrgGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed local positions from the server, keeping anything the user is dragging now.
  useEffect(() => {
    if (!graph) return;
    setPositions((current) => {
      const next = { ...current };
      graph.nodes.forEach((node, i) => {
        if (next[node.id]) return;
        next[node.id] = node.pos ?? { x: (i % 5) * 220, y: Math.floor(i / 5) * 150 };
      });
      return next;
    });
  }, [graph]);

  const nodes = useMemo(
    () => (graph?.nodes ?? []).filter((n) => !sectionFilter || n.section === sectionFilter),
    [graph, sectionFilter],
  );
  const visibleIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const sections = useMemo(() => [...new Set((graph?.nodes ?? []).map((n) => n.section))].filter(Boolean), [graph]);

  /** Reporting spine plus sidecar links, as one drawable list. */
  const edges = useMemo(() => {
    const list: (OrgLink & { spine?: boolean })[] = [];
    for (const node of nodes) {
      if (node.reportsTo && visibleIds.has(node.reportsTo)) {
        list.push({ id: `spine:${node.id}`, from: node.reportsTo, to: node.id, kind: 'dotted', spine: true });
      }
    }
    for (const link of graph?.links ?? []) {
      if (visibleIds.has(link.from) && visibleIds.has(link.to)) list.push(link);
    }
    return list;
  }, [nodes, graph, visibleIds]);

  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
    },
    [pan, zoom],
  );

  const savePosition = async (id: string, pos: Point): Promise<void> => {
    await api.post('/api/org-graph/positions', { positions: { [id]: pos } });
  };

  /** Middle of what the user is currently looking at, in canvas coordinates. */
  const viewportCentre = (): Point => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const raw = { x: (rect.width / 2 - pan.x) / zoom - NODE_W / 2, y: (rect.height / 2 - pan.y) / zoom - NODE_H / 2 };
    return { x: Math.round(raw.x / GRID) * GRID, y: Math.round(raw.y / GRID) * GRID };
  };

  /**
   * A bot created from the map lands where the user is looking, under whichever card
   * is selected. Creating an org chart top-down is the whole reason to add a bot from
   * here rather than from the roster.
   */
  const placeNewBot = async (botId: string): Promise<void> => {
    const parent = selectedNode ? positions[selectedNode] : undefined;
    const pos = parent ? { x: parent.x, y: parent.y + 150 } : viewportCentre();
    setPositions((p) => ({ ...p, [botId]: pos }));
    await savePosition(botId, pos);
    if (selectedNode) await api.patch(`/api/bots/${botId}`, { reportsTo: selectedNode });
    await refreshBots();
    await refreshOrgGraph();
    setSelectedNode(botId);
  };

  const onMouseMove = (e: React.MouseEvent): void => {
    if (resizing) {
      // Dragging left widens: the handle is on the panel's left edge.
      setPanelWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, resizing.w + (resizing.x - e.clientX))));
      return;
    }
    if (panning) {
      setPan({ x: panning.px + (e.clientX - panning.x), y: panning.py + (e.clientY - panning.y) });
      return;
    }
    if (connecting) {
      setConnecting({ ...connecting, to: toWorld(e.clientX, e.clientY) });
      return;
    }
    if (drag) {
      const world = toWorld(e.clientX, e.clientY);
      const raw = { x: world.x - drag.dx, y: world.y - drag.dy };
      const pos = snap ? { x: Math.round(raw.x / GRID) * GRID, y: Math.round(raw.y / GRID) * GRID } : raw;
      setPositions((p) => ({ ...p, [drag.id]: pos }));
      setDrag({ ...drag, moved: true });
    }
  };

  const onMouseUp = async (e: React.MouseEvent): Promise<void> => {
    if (connecting) {
      // Land the edge on whichever node is under the cursor.
      const target = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id');
      if (target && target !== connecting.from) await createLink(connecting.from, target);
      setConnecting(null);
    }
    if (drag?.moved) {
      const pos = positions[drag.id];
      if (pos) await savePosition(drag.id, pos);
    } else if (drag && !drag.moved) {
      setCardMenu(drag.id);
      setSelectedLink(null);
    }
    if (resizing) {
      try {
        localStorage.setItem(PANEL_KEY, String(panelWidth));
      } catch {
        /* not worth surfacing */
      }
      setResizing(null);
    }
    setDrag(null);
    setPanning(null);
  };

  const createLink = async (from: string, to: string): Promise<void> => {
    setError('');
    try {
      if (linkKind === 'reports') {
        // Attaching is a property of the report, not an edge in the sidecar: one
        // manager per bot, and the server repairs cycles when it lands.
        await api.patch(`/api/bots/${to}`, { reportsTo: from });
        await refreshBots();
      } else {
        const step =
          linkKind === 'workflow'
            ? (graph?.links.filter((l) => l.kind === 'workflow').length ?? 0) + 1
            : undefined;
        await api.post('/api/org-graph/links', { from, to, kind: linkKind, step });
      }
      await refreshOrgGraph();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  /** Detach: clear the manager, leaving the bot where it sits rather than moving it. */
  const detach = async (botId: string): Promise<void> => {
    setError('');
    try {
      await api.patch(`/api/bots/${botId}`, { reportsTo: null });
      await refreshBots();
      await refreshOrgGraph();
      setSelectedLink(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const layout = async (): Promise<void> => {
    const next = await api.get<Record<string, Point>>('/api/org-graph/auto-layout');
    setPositions((p) => ({ ...p, ...next }));
    await api.post('/api/org-graph/positions', { positions: next });
    await refreshOrgGraph();
    fit(next);
  };

  const fit = (source?: Record<string, Point>): void => {
    const points = Object.entries(source ?? positions).filter(([id]) => visibleIds.has(id) || source);
    if (!points.length) return;
    const xs = points.map(([, p]) => p.x);
    const ys = points.map(([, p]) => p.y);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(...xs) - Math.min(...xs) + NODE_W;
    const height = Math.max(...ys) - Math.min(...ys) + NODE_H;
    const next = Math.max(0.4, Math.min(1.2, Math.min((rect.width - 80) / width, (rect.height - 80) / height)));
    setZoom(next);
    setPan({ x: 40 - Math.min(...xs) * next, y: 40 - Math.min(...ys) * next });
  };

  const selected = selectedNode ? byId.get(selectedNode) : undefined;
  const activeLink = graph?.links.find((l) => l.id === selectedLink);
  /** A selected spine line names the report, whose manager is the thing to detach. */
  const activeSpine = selectedLink?.startsWith('spine:') ? byId.get(selectedLink.slice(6)) : undefined;
  const panelVisible = panelOpen || Boolean(selected) || Boolean(activeLink) || Boolean(activeSpine);

  const closePanel = (): void => {
    setSelectedNode(null);
    setSelectedLink(null);
    setPanelOpen(false);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      {/*
       * Two rows, because the toolbar was doing two unrelated jobs in one strip: what
       * you are looking at, and what a drag will draw. Nine controls in a row wrap into
       * a ragged block the moment the window narrows, and nothing in it said which
       * control belonged with which. Row one is the view, row two is the pen.
       */}
      <header className="flex flex-col border-b hairline" style={{ background: 'var(--color-panel)' }}>
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto px-4 py-2">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: 'var(--color-inset)', color: 'var(--color-accent)' }}>
              <Icon name="map" size={15} />
            </span>
            Team
          </h1>

          <Divider />

          <select value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)} className="rounded-lg px-2 py-1 text-[12px]" style={inputStyle} aria-label="Filter by section">
            <option value="">All sections</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="rounded-full px-2 py-0.5 text-[11px] tabular-nums" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            {nodes.length} {nodes.length === 1 ? 'bot' : 'bots'}
          </span>

          <span className="flex-1" />

          {/* Building an org chart and being sent elsewhere to add the next person to
              it is the break this button closes: the new card lands on this canvas. */}
          <button
            type="button"
            onClick={() => setNewBot(true)}
            title={selected ? `Add a bot reporting to ${selected.name}` : 'Add a bot to this chart'}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
          >
            <Icon name="plus" size={13} />
            New bot
          </button>

          <Divider />

          <span className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-inset)' }}>
            <button type="button" onClick={() => void layout()} title="Arrange every card by its reporting line" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]">
              <Icon name="wand" size={13} />
              Tidy
            </button>
            <button type="button" onClick={() => fit()} title="Fit every card on screen" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]">
              <Icon name="fit" size={13} />
              Fit
            </button>
          </span>

          <span className="flex items-center gap-0.5 rounded-lg px-0.5" style={{ background: 'var(--color-inset)' }}>
            <IconButton icon="minus" label="Zoom out" size={14} onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))} />
            <button
              type="button"
              onClick={() => setZoom(1)}
              title="Reset zoom to 100%"
              className="w-11 text-center text-[11px] tabular-nums"
              style={{ color: 'var(--color-ink-secondary)' }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <IconButton icon="plus" label="Zoom in" size={14} onClick={() => setZoom((z) => Math.min(2, z + 0.15))} />
          </span>

          <Divider />

          <IconButton
            icon={compact ? 'chevronDown' : 'chevronUp'}
            label={compact ? 'Show the drawing tools' : 'Hide the drawing tools'}
            tone="raised"
            active={compact}
            onClick={() => setCompact(!compact)}
          />
          {/*
           * One button, not a permanent 300px column. The legend and saved views are
           * reference material — worth reaching for, not worth a fifth of the canvas on
           * every visit. Selecting a card or a line opens it on its own.
           */}
          <IconButton
            icon="panelRight"
            label={panelVisible ? 'Hide the side panel' : 'Legend and saved views'}
            tone="raised"
            active={panelVisible}
            onClick={() => (panelVisible ? closePanel() : setPanelOpen(true))}
          />
          <button type="button" onClick={() => dispatch({ type: 'view', view: 'chat' })} className="flex items-center gap-1 text-[12px]">
            <Icon name="chevronLeft" size={13} />
            Back
          </button>
        </div>

        {compact ? null : (
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-1.5 hairline">
            <span className="text-[10px] font-semibold tracking-[0.08em] uppercase" style={{ color: 'var(--color-ink-secondary)' }}>
              Draw
            </span>
            {/*
             * Each option shows the line it will actually draw, not just its name. Five
             * words in a row read as tabs; five line samples read as a pen choice.
             */}
            <span className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-inset)' }} role="group" aria-label="Line to draw">
              {(['reports', 'workflow', 'flow', 'dotted', 'peer'] as PenKind[]).map((kind) => {
                const active = linkKind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setLinkKind(kind)}
                    title={LINK_STYLES[kind].hint}
                    aria-pressed={active}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]"
                    style={{
                      background: active ? 'var(--color-raised)' : 'transparent',
                      color: active ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
                      boxShadow: active ? '0 1px 2px #0000000f' : undefined,
                    }}
                  >
                    <svg width="18" height="10" aria-hidden="true" className="shrink-0">
                      <line
                        x1="1"
                        y1="5"
                        x2="17"
                        y2="5"
                        stroke={active ? LINK_COLOR[kind] : 'currentColor'}
                        strokeWidth={LINK_STYLES[kind].width}
                        strokeDasharray={LINK_STYLES[kind].dash}
                      />
                    </svg>
                    {LINK_STYLES[kind].label}
                  </button>
                );
              })}
            </span>

            <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
              Snap to grid
            </label>

            <span className="flex-1" />

            <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              Drag a card's bottom handle onto another to{' '}
              {linkKind === 'reports' ? 'attach it as a report' : `draw a ${LINK_STYLES[linkKind].label.toLowerCase()}`}.
            </span>
          </div>
        )}

        {/* The error is the one line here that is not reference material, so it stays
            even when the drawing row is folded away. */}
        {error ? (
          <div className="border-t px-4 py-1.5 text-[12px] hairline" style={{ color: 'var(--color-danger)' }}>
            {error}
          </div>
        ) : null}
      </header>
      <div
        className={`resize-grip row ${drawGripping ? 'active' : ''}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the map tools"
        onPointerDown={(event) => {
          event.preventDefault();
          setDrawGripping(true);
          const startY = event.clientY;
          const startCompact = compact;
          const onMove = (e: PointerEvent): void => {
            const dy = e.clientY - startY;
            if (dy < -16) setCompact(true);
            else if (dy > 16) setCompact(false);
            else setCompact(startCompact);
          };
          const onUp = (): void => {
            setDrawGripping(false);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        }}
      />
      <div
        className="flex min-h-0 flex-1"
        onMouseMove={resizing ? onMouseMove : undefined}
        onMouseUp={resizing ? (e) => void onMouseUp(e) : undefined}
        // A resize that wanders up into the toolbar would otherwise never see its
        // mouseup and the panel would keep following the cursor.
        onMouseLeave={resizing ? (e) => void onMouseUp(e) : undefined}
      >
        <div
          ref={canvasRef}
          className="relative min-w-0 flex-1 overflow-hidden"
          style={{
            cursor: panning ? 'grabbing' : 'grab',
            background: 'radial-gradient(1200px 600px at 20% 0%, color-mix(in srgb, var(--color-accent) 7%, transparent), transparent 55%), var(--color-app)',
          }}
          onMouseMove={onMouseMove}
          onMouseUp={(e) => void onMouseUp(e)}
          onMouseLeave={() => {
            setDrag(null);
            setPanning(null);
            setConnecting(null);
          }}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('[data-node-id]')) return;
            setSelectedNode(null);
            setSelectedLink(null);
            setCardMenu(null);
            setPanning({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
          }}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            setZoom((z) => Math.max(0.3, Math.min(2, z - e.deltaY * 0.002)));
          }}
        >
          {/* A faint grid makes snapping legible without drawing attention to itself. */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, var(--color-hairline) 1px, transparent 0)',
              backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
              backgroundPosition: `${pan.x}px ${pan.y}px`,
              opacity: 0.6,
            }}
          />

          {nodes.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
              <div className="max-w-sm rounded-2xl px-5 py-4 text-center" style={{ background: 'var(--color-panel)', border: '1px solid var(--color-hairline)', boxShadow: '0 12px 32px #00000018' }}>
                <div className="text-[14px] font-semibold">No one on the map yet</div>
                <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                  Add a bot, then drag the handle under a card onto another to draw who reports to whom.
                </div>
              </div>
            </div>
          ) : null}

          <div className="absolute origin-top-left" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <svg className="pointer-events-none absolute overflow-visible" style={{ width: 1, height: 1 }}>
              <defs>
                {(['reports', 'dotted', 'peer', 'flow', 'workflow'] as const).map((kind) => (
                  <marker key={kind} id={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={LINK_COLOR[kind]} />
                  </marker>
                ))}
              </defs>

              {edges.map((edge) => {
                const from = positions[edge.from];
                const to = positions[edge.to];
                if (!from || !to) return null;
                const kind = edge.spine ? 'reports' : edge.kind;
                const style = LINK_STYLES[kind];
                const { a, b } = edgePoint(from, to);
                const active = selectedLink === edge.id;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                return (
                  <g key={edge.id}>
                    <path
                      d={curve(a, b)}
                      fill="none"
                      stroke={active ? 'var(--color-focus)' : LINK_COLOR[kind]}
                      strokeWidth={active ? style.width + 1.5 : style.width}
                      strokeDasharray={style.dash}
                      markerEnd={style.arrow ? `url(#arrow-${kind})` : undefined}
                      opacity={edge.spine ? 0.75 : 1}
                    />
                    {/* A fat invisible path so a 2px line is still clickable. The
                        reporting spine gets one too: detaching has to be reachable
                        from the line you can see, not only from a dropdown. */}
                    <path
                      d={curve(a, b)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      className="pointer-events-auto cursor-pointer"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setSelectedLink(edge.id);
                        setSelectedNode(null);
                      }}
                    />
                    {edge.kind === 'workflow' && edge.step ? (
                      <>
                        <circle cx={mid.x} cy={mid.y} r={10} fill="var(--color-accent)" />
                        <text x={mid.x} y={mid.y + 3.5} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-accent-ink)">
                          {edge.step}
                        </text>
                      </>
                    ) : null}
                    {edge.label ? (
                      <text x={mid.x} y={mid.y - 14} textAnchor="middle" fontSize="10" fill="var(--color-ink-secondary)">
                        {edge.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}

              {connecting && positions[connecting.from] ? (
                <path
                  d={curve(
                    { x: positions[connecting.from]!.x + NODE_W / 2, y: positions[connecting.from]!.y + NODE_H },
                    connecting.to,
                  )}
                  fill="none"
                  stroke="var(--color-focus)"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                />
              ) : null}
            </svg>

            {nodes.map((node) => {
              const pos = positions[node.id];
              if (!pos) return null;
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  pos={pos}
                  selected={selectedNode === node.id}
                  menuOpen={cardMenu === node.id}
                  onOpenProfile={() => {
                    setCardMenu(null);
                    setSelectedNode(node.id);
                    setSelectedLink(null);
                    setPanelOpen(true);
                  }}
                  onOpenChat={() => {
                    // Stay on the map. Selecting a bot switches the whole window to chat.
                    setCardMenu(null);
                    dispatch({ type: 'drawer', botId: node.id });
                  }}
                  onDetach={node.reportsTo ? () => void detach(node.id) : undefined}
                  onStartDrag={(e) => {
                    const world = toWorld(e.clientX, e.clientY);
                    setCardMenu(null);
                    setDrag({ id: node.id, dx: world.x - pos.x, dy: world.y - pos.y, moved: false });
                    setSelectedLink(null);
                  }}
                  onStartConnect={(e) => {
                    e.stopPropagation();
                    setCardMenu(null);
                    setConnecting({ from: node.id, to: toWorld(e.clientX, e.clientY) });
                  }}
                />
              );
            })}
          </div>

          {nodes.length === 0 ? (
            <div className="absolute inset-0 grid place-items-center text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {graph ? 'No bots in this section yet.' : 'Loading the chart…'}
            </div>
          ) : null}
        </div>

        {panelVisible ? (
          <aside className="anim-panel relative shrink-0 overflow-y-auto border-l hairline scroll-thin" style={{ background: 'var(--color-panel)', width: panelWidth }}>
            {/* Drag the edge to widen. A saved view list and a long link label want
                different amounts of room, and 300px was only ever right for one. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the side panel"
              onMouseDown={(e) => {
                e.preventDefault();
                setResizing({ x: e.clientX, w: panelWidth });
              }}
              className="absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-col-resize"
              style={{ background: resizing ? 'var(--color-focus)' : 'transparent' }}
            />
            <div className="flex items-center gap-2 border-b px-3 py-1.5 hairline">
              <span className="flex-1 text-[12px] font-semibold">
                {activeLink || activeSpine ? 'Line' : selected ? selected.name : 'Map reference'}
              </span>
              <IconButton icon="close" label="Close the panel" size={14} onClick={closePanel} />
            </div>
            {activeSpine ? (
              <SpineInspector node={activeSpine} nodes={graph?.nodes ?? []} onDetach={() => void detach(activeSpine.id)} />
            ) : activeLink ? (
              <LinkInspector
                link={activeLink}
                nodes={graph?.nodes ?? []}
                onChanged={refreshOrgGraph}
                onClose={() => setSelectedLink(null)}
              />
            ) : selected ? (
              <NodeInspector
                node={selected}
                nodes={graph?.nodes ?? []}
                onChanged={async () => {
                  await refreshBots();
                  await refreshOrgGraph();
                }}
                onOpenChat={() => dispatch({ type: 'drawer', botId: selected.id })}
              />
            ) : (
              <LegendAndCharts
                chartName={chartName}
                setChartName={setChartName}
                positions={positions}
                botIds={nodes.map((n) => n.id)}
                onApplyChart={(chart) => {
                  if (chart.positions) setPositions((p) => ({ ...p, ...chart.positions }));
                  setSectionFilter('');
                }}
              />
            )}
          </aside>
        ) : null}
      </div>

      {newBot ? <NewBotDialog onClose={() => setNewBot(false)} onCreated={placeNewBot} /> : null}
    </div>
  );
}

function NodeCard({
  node,
  pos,
  selected,
  menuOpen,
  onOpenProfile,
  onOpenChat,
  onDetach,
  onStartDrag,
  onStartConnect,
}: {
  node: OrgNode;
  pos: Point;
  selected: boolean;
  menuOpen: boolean;
  onOpenProfile: () => void;
  onOpenChat: () => void;
  onDetach?: () => void;
  onStartDrag: (e: React.MouseEvent) => void;
  onStartConnect: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      data-node-id={node.id}
      className="group absolute select-none rounded-2xl"
      style={{
        left: pos.x,
        top: pos.y,
        width: NODE_W,
        height: NODE_H,
        background: 'var(--color-card)',
        border: `1px solid ${selected || menuOpen ? 'var(--color-focus)' : 'var(--color-hairline)'}`,
        boxShadow: selected || menuOpen
          ? '0 10px 28px #00000024, 0 0 0 3px color-mix(in srgb, var(--color-focus) 28%, transparent)'
          : '0 8px 20px #00000014',
        cursor: 'move',
        zIndex: menuOpen ? 5 : 1,
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onStartDrag(e);
      }}
    >
      {/* The colour band is the bot's identity colour — the same one the roster uses. */}
      <span className="absolute top-3 bottom-3 left-0 w-1 rounded-r-full" style={{ background: botColor(node.color as HarnessbotColor) }} />

      <div className="flex h-full items-center gap-2.5 pr-2 pl-4">
        <Avatar
          name={node.name}
          color={node.color as HarnessbotColor}
          activity={node.activity as never}
          expression={node.mascotExpression}
          avatarUrl={node.avatarUrl}
          size={32}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold">{node.name}</span>
            <ActivityDot activity={node.activity as never} />
            {node.unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--color-accent)' }} /> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1">
            {node.chiefOfStaff ? (
              <span
                className="shrink-0 rounded px-1 text-[9px] font-semibold tracking-wide uppercase"
                style={{ background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)', color: 'var(--color-accent)' }}
              >
                Chief
              </span>
            ) : null}
            <span className="truncate text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {node.title || 'No title'}
            </span>
            {node.section ? (
              <span className="shrink-0 rounded px-1 text-[9px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
                {node.section}
              </span>
            ) : null}
          </div>
        </div>
        {onDetach ? (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDetach();
            }}
            title={`Detach ${node.name} from their manager`}
            aria-label={`Detach ${node.name} from their manager`}
            className="shrink-0 rounded-md p-1.5"
            style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
          >
            <Icon name="unlink" size={13} />
          </button>
        ) : null}
      </div>

      {/* Connect handle sits under the card so a reporting line is dragged downward. */}
      <button
        type="button"
        aria-label={`Draw a link from ${node.name}`}
        onMouseDown={onStartConnect}
        className="absolute -bottom-[7px] left-1/2 h-3.5 w-3.5 -translate-x-1/2 rounded-full"
        style={{ background: 'var(--color-accent)', border: '2px solid var(--color-card)', cursor: 'crosshair' }}
      />

      {menuOpen ? (
        <div
          className="card absolute top-full left-1/2 z-30 mt-2.5 w-40 -translate-x-1/2 py-1"
          style={{ background: 'var(--color-raised)' }}
          role="menu"
          aria-label={`${node.name} actions`}
        >
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onOpenProfile}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]"
          >
            <Icon name="user" size={14} />
            Profile
          </button>
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onOpenChat}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]"
          >
            <Icon name="chevronRight" size={14} />
            Chat
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NodeInspector({
  node,
  nodes,
  onChanged,
  onOpenChat,
}: {
  node: OrgNode;
  nodes: OrgNode[];
  onChanged: () => Promise<void>;
  onOpenChat: () => void;
}) {
  // The graph node is a projection; the engine controls need the whole bot record.
  const { state } = useStore();
  const bot = state.bots.find((b) => b.id === node.id);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    await api.patch(`/api/bots/${node.id}`, patch);
    await onChanged();
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <Avatar name={node.name} color={node.color as HarnessbotColor} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{node.name}</div>
          <div className="truncate text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {node.title || 'No title'}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenChat}
        className="mt-3 w-full rounded-lg px-3 py-1.5 text-[13px]"
        style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
      >
        Open chat
      </button>

      {/* Which engine a card runs on is org information: it is the difference between
          two identical-looking boxes, and the chart was the one place you could not
          see it or change it. */}
      {bot ? (
        <>
          <div className="mt-4 text-[10px] font-semibold tracking-[0.08em] uppercase" style={{ color: 'var(--color-ink-secondary)' }}>
            Engine
          </div>
          <div className="mt-1.5">
            <EngineRow bot={bot} compact />
          </div>
        </>
      ) : null}

      {/* One heading, then fields. The panel used to be three controls each trailed by
          its own paragraph, which reads as a wall rather than a form. */}
      <div className="mt-5 text-[10px] font-semibold tracking-[0.08em] uppercase" style={{ color: 'var(--color-ink-secondary)' }}>
        Place in the org
      </div>

      <label htmlFor="org-reports-to" className="mt-2 block text-[12px] font-medium">
        Reports to
      </label>
      <select
        id="org-reports-to"
        value={node.reportsTo ?? ''}
        /* null, not undefined: JSON.stringify drops undefined and the PATCH arrives empty. */
        onChange={(e) => void save({ reportsTo: e.target.value || null })}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={inputStyle}
      >
        <option value="">No manager</option>
        {nodes
          .filter((n) => n.id !== node.id)
          .map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
      </select>

      <label htmlFor="org-section" className="mt-3 block text-[12px] font-medium">
        Section
      </label>
      <input
        id="org-section"
        defaultValue={node.section}
        placeholder="e.g. Research"
        onBlur={(e) => void save({ section: e.target.value || undefined })}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={inputStyle}
      />

      <label className="mt-3 flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={node.chiefOfStaff} onChange={(e) => void save({ chiefOfStaff: e.target.checked })} />
        <span className="min-w-0">
          Chief of Staff
          <span className="block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
            One per section. Promoting another bot demotes this one.
          </span>
        </span>
      </label>

      <p className="mt-4 border-t pt-2 text-[11px] hairline" style={{ color: 'var(--color-ink-secondary)' }}>
        One manager per bot. Cycles and dangling managers are repaired when the workspace loads.
      </p>
    </div>
  );
}

/**
 * The reporting spine has no record of its own to edit — it is one field on the
 * report. So this panel does the two things a selected spine line can do: say what it
 * means, and cut it.
 */
function SpineInspector({ node, nodes, onDetach }: { node: OrgNode; nodes: OrgNode[]; onDetach: () => void }) {
  const manager = nodes.find((n) => n.id === node.reportsTo);
  return (
    <div className="p-3">
      <div className="text-[14px] font-semibold">Reports to</div>
      <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {node.name} reports to {manager?.name ?? 'someone who is gone'}.
      </div>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        The spine, not a drawn link. Detaching leaves {node.name} where it is on the canvas and
        without a manager — it does not delete anything.
      </p>
      <button
        type="button"
        onClick={onDetach}
        className="mt-4 w-full rounded-lg px-3 py-1.5 text-[13px]"
        style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
      >
        Detach {node.name}
      </button>
    </div>
  );
}

function LinkInspector({
  link,
  nodes,
  onChanged,
  onClose,
}: {
  link: OrgLink;
  nodes: OrgNode[];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const name = (id: string): string => nodes.find((n) => n.id === id)?.name ?? 'unknown';

  const update = async (patch: Partial<OrgLink>): Promise<void> => {
    await api.patch(`/api/org-graph/links/${link.id}`, patch);
    await onChanged();
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[14px] font-semibold">Link</span>
        <button type="button" onClick={onClose} className="text-[12px]">
          Close
        </button>
      </div>
      <div className="mt-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {name(link.from)} → {name(link.to)}
      </div>

      <label className="mt-3 block text-[12px] font-medium">Kind</label>
      <select value={link.kind} onChange={(e) => void update({ kind: e.target.value as LinkKind })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]" style={inputStyle}>
        {(['workflow', 'flow', 'dotted', 'peer'] as LinkKind[]).map((kind) => (
          <option key={kind} value={kind}>
            {LINK_STYLES[kind].label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {LINK_STYLES[link.kind].hint}
      </p>

      <label className="mt-3 block text-[12px] font-medium">Label</label>
      <input
        defaultValue={link.label ?? ''}
        placeholder="e.g. sends draft for review"
        onBlur={(e) => void update({ label: e.target.value })}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={inputStyle}
      />

      {link.kind === 'workflow' ? (
        <>
          <label className="mt-3 block text-[12px] font-medium">Step number</label>
          <input
            type="number"
            min={1}
            defaultValue={link.step ?? 1}
            onBlur={(e) => void update({ step: Number(e.target.value) })}
            className="mt-1 w-24 rounded-lg px-2 py-1.5 text-[13px]"
            style={inputStyle}
          />
        </>
      ) : null}

      <button
        type="button"
        onClick={async () => {
          await api.del(`/api/org-graph/links/${link.id}`);
          await onChanged();
          onClose();
        }}
        className="mt-4 w-full rounded-lg px-3 py-1.5 text-[13px]"
        style={{ background: 'var(--color-raised)', color: 'var(--color-danger)' }}
      >
        Remove link
      </button>
    </div>
  );
}

function LegendAndCharts({
  chartName,
  setChartName,
  positions,
  botIds,
  onApplyChart,
}: {
  chartName: string;
  setChartName: (v: string) => void;
  positions: Record<string, Point>;
  botIds: string[];
  onApplyChart: (chart: { positions?: Record<string, Point> }) => void;
}) {
  const { state, refreshOrgGraph } = useStore();
  const charts = state.orgGraph?.charts ?? [];

  return (
    <div className="p-3">
      <div className="text-[13px] font-semibold">Legend</div>
      <div className="mt-2 flex flex-col gap-2">
        {(['reports', 'workflow', 'flow', 'dotted', 'peer'] as const).map((kind) => (
          <div key={kind} className="flex items-start gap-2">
            <svg width="34" height="14" className="mt-0.5 shrink-0">
              <line
                x1="1"
                y1="7"
                x2="33"
                y2="7"
                stroke={LINK_COLOR[kind]}
                strokeWidth={LINK_STYLES[kind].width}
                strokeDasharray={LINK_STYLES[kind].dash}
              />
            </svg>
            <div className="min-w-0">
              <div className="text-[12px] font-medium">{LINK_STYLES[kind].label}</div>
              <div className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                {LINK_STYLES[kind].hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 text-[13px] font-semibold">Saved views</div>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        A view remembers which bots it shows and where you put them, so a process diagram and an
        org chart can disagree about layout without fighting each other.
      </p>

      <div className="mt-2 flex gap-2">
        <input value={chartName} onChange={(e) => setChartName(e.target.value)} placeholder="View name" className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[12px]" style={inputStyle} />
        <button
          type="button"
          disabled={!chartName.trim()}
          onClick={async () => {
            await api.post('/api/org-graph/charts', {
              name: chartName.trim(),
              botIds,
              positions: Object.fromEntries(botIds.map((id) => [id, positions[id]]).filter(([, p]) => p)),
            });
            setChartName('');
            await refreshOrgGraph();
          }}
          className="rounded-lg px-3 text-[12px] disabled:opacity-40"
          style={{ background: 'var(--color-raised)' }}
        >
          Save
        </button>
      </div>

      {charts.map((chart) => (
        <div key={chart.id} className="mt-2 flex items-center gap-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--color-inset)' }}>
          <button type="button" onClick={() => onApplyChart(chart)} className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[12px] font-medium">{chart.name}</span>
            <span className="block text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {chart.botIds.length} bot{chart.botIds.length === 1 ? '' : 's'}
            </span>
          </button>
          <button
            type="button"
            onClick={async () => {
              await api.del(`/api/org-graph/charts/${chart.id}`);
              await refreshOrgGraph();
            }}
            className="text-[11px]"
            style={{ color: 'var(--color-danger)' }}
          >
            Delete
          </button>
        </div>
      ))}

      {charts.length === 0 ? (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
          No saved views yet.
        </div>
      ) : null}
    </div>
  );
}
