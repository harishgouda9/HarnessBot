import {
  KEYBINDS_AREA,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  host,
  queryClient,
} from '@hermes/plugin-sdk';
import type { BotRecord } from '../../../../shared/types.ts';
import { Harness, KEYS, type PluginCtx } from './harness.ts';
import { RosterPane } from './roster.tsx';
import { Workspace } from './workspace.tsx';
import { UsageMeter } from './usage-meter.tsx';

/**
 * HarnessBot as a Hermes Desktop feature — the same contribution model as Kanban.
 *
 * Sidebar row (next to Kanban) + a hide-only tab in the SESSIONS | BOTS strip +
 * `/harnessbot` page + status-bar meter + palette/keybind + @mentions. The page
 * is the full product; the tab is a native roster that opens it. Local
 * contribution ids are *not* prefixed with `harnessbot:` — the host already
 * namespaces them, and `harnessbot:route` became
 * `plugin:harnessbot:harnessbot:harnessbot:route` in the error boundary.
 */

const ID = 'harnessbot';
const ROUTE = '/harnessbot';

/** Areas that live outside the SDK's export surface are plain strings by contract. */
const COMPOSER_AT_COMPLETIONS = 'composer.atCompletions';

export default {
  id: ID,
  name: 'HarnessBot',
  description:
    'Roster, rooms, skills and computer — a sidebar row next to Kanban, a tab beside SESSIONS | BOTS, and a /harnessbot page.',
  defaultEnabled: true,
  register(ctx: PluginCtx) {
    const harness = new Harness(ctx);
    const open = () => host.navigate(ROUTE);

    ctx.registerMany([
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { path: ROUTE, label: 'HarnessBot', codicon: 'organization' },
      },
      {
        id: 'pane',
        area: PANES_AREA,
        title: 'HarnessBot',
        data: {
          placement: 'left',
          width: '260px',
          collapsible: true,
          hideOnly: true,
          dock: { pane: 'sessions', pos: 'center', enforce: true },
        },
        render: () => <RosterPane ctx={ctx} onOpen={open} onLaunch={open} />,
      },
      {
        id: 'page',
        area: ROUTES_AREA,
        title: 'HarnessBot',
        data: { path: ROUTE },
        render: () => <Workspace ctx={ctx} />,
      },
      {
        id: 'usage',
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => <UsageMeter ctx={ctx} />,
      },
      {
        id: 'palette-open',
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          label: 'HarnessBot: Open',
          keywords: ['harnessbot', 'bots', 'roster', 'agents', 'contacts'],
          run: () => host.navigate(ROUTE),
        },
      },
      {
        id: 'keybind-open',
        area: KEYBINDS_AREA,
        data: {
          id: `${ID}.open`,
          category: 'view',
          defaults: ['mod+alt+b'],
          label: 'HarnessBot: Open',
          run: () => host.navigate(ROUTE),
        },
      },
      {
        id: 'mentions',
        area: COMPOSER_AT_COMPLETIONS,
        data: {
          provide: (query: string) => {
            const bots = queryClient.getQueryData<BotRecord[]>(KEYS.bots) ?? [];
            const q = query.trim().toLowerCase();
            return bots
              .filter((bot) => !q || bot.name.toLowerCase().includes(q))
              .slice(0, 8)
              .map((bot) => ({
                id: `harnessbot:${bot.id}`,
                label: bot.name,
                detail: bot.title || 'HarnessBot',
                insert: `@${bot.name}`,
              }));
          },
        },
      },
    ]);

    void harness.ensureRunning().then(() => {
      void queryClient.prefetchQuery({ queryKey: KEYS.bots, queryFn: () => harness.bots() });
    });
  },
};
