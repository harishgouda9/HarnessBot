// integrations/hermes/desktop/src/plugin.tsx
import {
  KEYBINDS_AREA,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  host,
  queryClient
} from "@hermes/plugin-sdk";

// integrations/hermes/desktop/src/logic.ts
function toneFor(bot) {
  switch (bot.activity) {
    case "working":
      return "positive";
    case "waiting-on-you":
      return "caution";
    case "no-signal":
    case "dead":
      return "critical";
    default:
      return "neutral";
  }
}
var ACTIVITY_LABEL = {
  working: "Working",
  "waiting-on-you": "Waiting on you",
  "no-signal": "No signal",
  dead: "Unavailable",
  idle: "Idle"
};
function sectionsOf(bots) {
  const bySection = /* @__PURE__ */ new Map();
  for (const bot of bots) {
    const key = bot.section?.trim() || "";
    const list = bySection.get(key);
    if (list) list.push(bot);
    else bySection.set(key, [bot]);
  }
  const named = [...bySection.entries()].filter(([name]) => name).sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, bots: list }));
  const loose = bySection.get("") ?? [];
  return loose.length ? [...named, { name: "Unsectioned", bots: loose }] : named;
}
function matches(bot, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [bot.name, bot.title, bot.section].some((field) => (field ?? "").toLowerCase().includes(q));
}
function nextHarnessAction(status) {
  if (status.static_ui_built === false) return "build";
  if (!status.running) return "start";
  if (!status.health?.static) return "restart";
  return "ready";
}
function productUrl(url) {
  if (!url) return null;
  return url.endsWith("/") ? url : `${url}/`;
}
function canUseWebview(create) {
  const el = create("webview");
  if (!el) return false;
  return el.tagName.toLowerCase() === "webview" && el.constructor !== globalThis.HTMLUnknownElement;
}

// integrations/hermes/desktop/src/harness.ts
var BUILD_HINT = "Run `node scripts/build-hermes-plugin.mjs` in the HarnessBot checkout, then reload desktop plugins.";
var Harness = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  /** Plugin-level: is the harness process up, and where does it live. */
  status() {
    return this.ctx.rest("/status");
  }
  start() {
    return this.ctx.rest("/start", { method: "POST" });
  }
  restart() {
    return this.ctx.rest("/restart", { method: "POST" });
  }
  /**
   * Bring the harness up serving the full UI, or explain why it cannot.
   *
   * Side-effecting on purpose: the desktop page is a viewport onto the product,
   * and a harness that is up but answering JSON at GET / is the bug the user
   * hit (`{"error":"not found"}` at 127.0.0.1:8799).
   */
  async ensureRunning() {
    let status = await this.status();
    const action = nextHarnessAction(status);
    if (action === "build") {
      return { ...status, ok: false, error: `HarnessBot's interface has not been built. ${BUILD_HINT}` };
    }
    if (action === "start" || action === "restart") {
      const result = action === "start" ? await this.start() : await this.restart();
      if (!result.ok) return { ...status, ok: false, error: result.error || `the harness could not be ${action}ed` };
      status = await this.status();
    }
    if (!status.running || !status.url) {
      return { ...status, ok: false, error: "HarnessBot started but is not answering." };
    }
    if (!status.health?.static) {
      return { ...status, ok: false, error: `HarnessBot is running but not serving its UI. ${BUILD_HINT}` };
    }
    return { ...status, ok: true };
  }
  api(path, opts) {
    return this.ctx.rest(`/hb/api${path}`, opts);
  }
  bots() {
    return this.api("/bots");
  }
  bot(id) {
    return this.api(`/bots/${encodeURIComponent(id)}`);
  }
  groups() {
    return this.api("/groups");
  }
  engines() {
    return this.api("/instances");
  }
  hermes() {
    return this.api("/hermes");
  }
  messages(threadId, all = false) {
    return this.api(`/threads/${encodeURIComponent(threadId)}/messages${all ? "?all=true" : ""}`);
  }
  send(botId, text, threadId) {
    return this.api(`/bots/${encodeURIComponent(botId)}/messages`, {
      method: "POST",
      body: { text, threadId }
    });
  }
  interrupt(botId) {
    return this.api(`/bots/${encodeURIComponent(botId)}/interrupt`, { method: "POST" });
  }
  /** Answer an approval card. The harness owns the decision log; this only relays. */
  respond(botId, requestId, choiceId, answer) {
    return this.api(`/bots/${encodeURIComponent(botId)}/respond`, {
      method: "POST",
      body: { requestId, choiceId, answer }
    });
  }
};
var KEYS = {
  status: ["harnessbot", "status"],
  bots: ["harnessbot", "bots"],
  groups: ["harnessbot", "groups"],
  engines: ["harnessbot", "engines"],
  hermes: ["harnessbot", "hermes"],
  thread: (id) => ["harnessbot", "thread", id]
};

// integrations/hermes/desktop/src/roster.tsx
import { Badge, Button, EmptyState, ErrorState, Loader, ScrollArea, SearchField, StatusDot, cn, useQuery } from "@hermes/plugin-sdk";
import { useMemo, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function BotRow({
  bot,
  selected,
  onSelect
}) {
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick: () => onSelect(bot),
      "aria-current": selected ? "true" : void 0,
      className: cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        selected ? "bg-(--ui-fill-secondary)" : "hover:bg-(--ui-fill-tertiary)"
      ),
      children: [
        /* @__PURE__ */ jsx(StatusDot, { tone: toneFor(bot) }),
        /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
          /* @__PURE__ */ jsx("span", { className: "block truncate", children: bot.name }),
          bot.title ? /* @__PURE__ */ jsx("span", { className: "block truncate text-xs text-(--ui-text-tertiary)", children: bot.title }) : null
        ] }),
        bot.activity && bot.activity !== "idle" ? /* @__PURE__ */ jsx(Badge, { children: ACTIVITY_LABEL[bot.activity] ?? bot.activity }) : null
      ]
    }
  );
}
function RosterPane({
  ctx,
  onOpen,
  onLaunch
}) {
  const harness = useMemo(() => new Harness(ctx), [ctx]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const bots = useQuery({
    queryKey: KEYS.bots,
    queryFn: () => harness.bots(),
    // Polled, not streamed: see the note in logic.ts — Hermes' auth gate does
    // not cover WebSocket routes, so there is no socket to lean on here.
    refetchInterval: 1e4
  });
  if (bots.isLoading) return /* @__PURE__ */ jsx(Loader, { label: "Loading the roster\u2026" });
  if (bots.error) {
    return /* @__PURE__ */ jsx(
      ErrorState,
      {
        title: "HarnessBot is not answering",
        description: String(bots.error?.message ?? bots.error),
        action: /* @__PURE__ */ jsx(Button, { onClick: () => void bots.refetch(), children: "Try again" })
      }
    );
  }
  const all = bots.data ?? [];
  if (!all.length) {
    return /* @__PURE__ */ jsx(
      EmptyState,
      {
        title: "No bots yet",
        description: "Open HarnessBot to create one.",
        action: onLaunch ? /* @__PURE__ */ jsx(Button, { onClick: onLaunch, children: "Open HarnessBot" }) : void 0
      }
    );
  }
  const visible = all.filter((bot) => matches(bot, query));
  const sections = sectionsOf(visible);
  return /* @__PURE__ */ jsxs("div", { className: "flex h-full flex-col gap-2 p-2", children: [
    onLaunch ? /* @__PURE__ */ jsx(Button, { size: "sm", onClick: onLaunch, children: "Open HarnessBot" }) : null,
    /* @__PURE__ */ jsx(SearchField, { value: query, onValueChange: setQuery, placeholder: "Search bots" }),
    /* @__PURE__ */ jsxs(ScrollArea, { className: "min-h-0 flex-1", children: [
      sections.map((section) => /* @__PURE__ */ jsxs("div", { className: "mb-2", children: [
        /* @__PURE__ */ jsx("div", { className: "px-2 pb-1 text-xs text-(--ui-text-tertiary)", children: section.name }),
        section.bots.map((bot) => /* @__PURE__ */ jsx(
          BotRow,
          {
            bot,
            selected: bot.id === selected,
            onSelect: (next) => {
              setSelected(next.id);
              onOpen(next);
            }
          },
          bot.id
        ))
      ] }, section.name)),
      !visible.length ? /* @__PURE__ */ jsxs("div", { className: "px-2 py-4 text-sm text-(--ui-text-tertiary)", children: [
        "Nothing matches \u201C",
        query,
        "\u201D."
      ] }) : null
    ] })
  ] });
}

// integrations/hermes/desktop/src/workspace.tsx
import { Button as Button2, ErrorState as ErrorState2, Loader as Loader2, useQuery as useQuery2 } from "@hermes/plugin-sdk";
import { useEffect, useMemo as useMemo2, useRef, useState as useState2 } from "react";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function ProductFrame({ url, onOpenExternal }) {
  const webview = canUseWebview((tag) => typeof document === "undefined" ? null : document.createElement(tag));
  const guest = useRef(null);
  const [failed, setFailed] = useState2(null);
  const [generation, setGeneration] = useState2(0);
  useEffect(() => {
    setFailed(null);
    const el = guest.current;
    if (!el) return;
    const fail = (event) => {
      const detail = event;
      if (detail.isMainFrame === false) return;
      setFailed(detail.errorDescription || "the page failed to load");
    };
    el.addEventListener("did-fail-load", fail);
    return () => el.removeEventListener("did-fail-load", fail);
  }, [url, generation, webview]);
  if (failed) {
    return /* @__PURE__ */ jsx2(
      ErrorState2,
      {
        title: "HarnessBot did not load",
        description: `${failed} (${url})`,
        action: /* @__PURE__ */ jsxs2("div", { className: "flex flex-wrap gap-2", children: [
          /* @__PURE__ */ jsx2(
            Button2,
            {
              onClick: () => {
                setFailed(null);
                setGeneration((n) => n + 1);
              },
              children: "Try again"
            }
          ),
          onOpenExternal ? /* @__PURE__ */ jsx2(Button2, { variant: "ghost", onClick: () => onOpenExternal(url), children: "Open in a window" }) : null
        ] })
      }
    );
  }
  const fill = { className: "absolute inset-0 h-full w-full border-0", src: url };
  return /* @__PURE__ */ jsx2("div", { className: "relative h-full min-h-0 w-full", children: webview ? (
    // Electron custom element. JSX would not parse in a disk plugin; the
    // compiled bundle emits createElement('webview', …).
    /* @__PURE__ */ jsx2(
      "webview",
      {
        ref: guest,
        title: "HarnessBot",
        ...fill,
        allowpopups: true,
        partition: "persist:harnessbot"
      }
    )
  ) : /* @__PURE__ */ jsx2("iframe", { title: "HarnessBot", ...fill, allow: "clipboard-read; clipboard-write; microphone", onError: () => setFailed("the frame was blocked") }) }, generation);
}
function Workspace({ ctx }) {
  const harness = useMemo2(() => new Harness(ctx), [ctx]);
  const status = useQuery2({
    queryKey: KEYS.status,
    queryFn: async () => {
      const result = await harness.ensureRunning();
      if (!result.ok) throw new Error(result.error || "HarnessBot failed to start");
      return result;
    },
    refetchInterval: 12e3
  });
  if (status.isLoading) return /* @__PURE__ */ jsx2(Loader2, { label: "Starting HarnessBot\u2026" });
  const url = productUrl(status.data?.url);
  if (status.error || !url) {
    return /* @__PURE__ */ jsx2(
      ErrorState2,
      {
        title: "HarnessBot is not answering",
        description: String(status.error?.message ?? status.error ?? "No URL was reported."),
        action: /* @__PURE__ */ jsx2(Button2, { onClick: () => void status.refetch(), children: "Try again" })
      }
    );
  }
  return /* @__PURE__ */ jsx2(
    ProductFrame,
    {
      url,
      onOpenExternal: (href) => {
        void ctx.os?.openExternal?.(href);
      }
    }
  );
}

// integrations/hermes/desktop/src/usage-meter.tsx
import { Popover, PopoverContent, PopoverTrigger, ScrollArea as ScrollArea2, Tip, cn as cn2, useQuery as useQuery3 } from "@hermes/plugin-sdk";
import { useMemo as useMemo3 } from "react";

// src/usage.ts
var EMPTY_USAGE = { input: 0, output: 0, cachedInput: 0, costUsd: 0, turns: 0, tokens: 0, leanSaved: 0 };
function totalsFor(bot) {
  const totals = { ...EMPTY_USAGE };
  for (const task of bot.tasks ?? []) {
    const usage = task.usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cachedInput += usage.cachedInput ?? 0;
    totals.costUsd += usage.costUsd ?? 0;
    totals.turns += usage.turns ?? 0;
    totals.leanSaved += usage.leanSaved ?? 0;
  }
  totals.tokens = totals.input + totals.output + totals.cachedInput;
  return totals;
}
function usageBreakdown(bots) {
  const total = { ...EMPTY_USAGE };
  const perBot = [];
  for (const bot of bots) {
    const totals = totalsFor(bot);
    if (totals.turns || totals.tokens) perBot.push({ bot, totals });
    total.input += totals.input;
    total.output += totals.output;
    total.cachedInput += totals.cachedInput;
    total.costUsd += totals.costUsd;
    total.turns += totals.turns;
    total.tokens += totals.tokens;
    total.leanSaved += totals.leanSaved;
  }
  perBot.sort((a, b) => b.totals.tokens - a.totals.tokens);
  return { total, perBot };
}
function formatTokens(count) {
  const n = Math.max(0, Math.round(count));
  if (n < 1e3) return String(n);
  if (n < 1e6) {
    const k = n / 1e3;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1e6;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}
function formatCost(costUsd) {
  if (!costUsd) return null;
  return costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
}

// integrations/hermes/desktop/src/usage-meter.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function UsageMeter({ ctx }) {
  const harness = useMemo3(() => new Harness(ctx), [ctx]);
  const bots = useQuery3({ queryKey: KEYS.bots, queryFn: () => harness.bots(), refetchInterval: 15e3 });
  const { total, perBot } = usageBreakdown(bots.data ?? []);
  if (!total.tokens) return null;
  const cost = formatCost(total.costUsd);
  return /* @__PURE__ */ jsxs3(Popover, { children: [
    /* @__PURE__ */ jsx3(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsx3(
      "button",
      {
        type: "button",
        "aria-label": `HarnessBot token usage: ${total.tokens.toLocaleString()} tokens`,
        className: cn2("inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem]", "text-(--ui-text-tertiary)"),
        children: /* @__PURE__ */ jsx3(Tip, { label: `${total.input.toLocaleString()} in \xB7 ${total.output.toLocaleString()} out \xB7 ${total.turns} turns`, children: /* @__PURE__ */ jsxs3("span", { className: "inline-flex items-center gap-1", children: [
          /* @__PURE__ */ jsx3("span", { "aria-hidden": true, children: "\u25F7" }),
          /* @__PURE__ */ jsx3("span", { className: "tabular-nums", children: formatTokens(total.tokens) }),
          cost ? /* @__PURE__ */ jsx3("span", { children: cost }) : null
        ] }) })
      }
    ) }),
    /* @__PURE__ */ jsxs3(PopoverContent, { className: "w-64 p-2 text-xs", children: [
      /* @__PURE__ */ jsxs3("div", { className: "mb-1.5 flex items-baseline justify-between", children: [
        /* @__PURE__ */ jsx3("span", { className: "font-medium", children: "HarnessBot tokens" }),
        /* @__PURE__ */ jsx3("span", { className: "tabular-nums", children: total.tokens.toLocaleString() })
      ] }),
      /* @__PURE__ */ jsx3(ScrollArea2, { className: "max-h-56", children: /* @__PURE__ */ jsx3("ul", { className: "space-y-0.5", children: perBot.map(({ bot, totals }) => /* @__PURE__ */ jsxs3("li", { className: "flex items-baseline justify-between gap-2", children: [
        /* @__PURE__ */ jsx3("span", { className: "truncate", children: bot.name }),
        /* @__PURE__ */ jsx3("span", { className: "shrink-0 tabular-nums text-(--ui-text-tertiary)", children: formatTokens(totals.tokens) })
      ] }, bot.id)) }) })
    ] })
  ] });
}

// integrations/hermes/desktop/src/plugin.tsx
import { jsx as jsx4 } from "react/jsx-runtime";
var ID = "harnessbot";
var ROUTE = "/harnessbot";
var COMPOSER_AT_COMPLETIONS = "composer.atCompletions";
var plugin_default = {
  id: ID,
  name: "HarnessBot",
  description: "Roster, rooms, skills and computer \u2014 a sidebar row next to Kanban, a tab beside SESSIONS | BOTS, and a /harnessbot page.",
  defaultEnabled: true,
  register(ctx) {
    const harness = new Harness(ctx);
    const open = () => host.navigate(ROUTE);
    ctx.registerMany([
      {
        id: "nav",
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { path: ROUTE, label: "HarnessBot", codicon: "organization" }
      },
      {
        id: "pane",
        area: PANES_AREA,
        title: "HarnessBot",
        data: {
          placement: "left",
          width: "260px",
          collapsible: true,
          hideOnly: true,
          dock: { pane: "sessions", pos: "center", enforce: true }
        },
        render: () => /* @__PURE__ */ jsx4(RosterPane, { ctx, onOpen: open, onLaunch: open })
      },
      {
        id: "page",
        area: ROUTES_AREA,
        title: "HarnessBot",
        data: { path: ROUTE },
        render: () => /* @__PURE__ */ jsx4(Workspace, { ctx })
      },
      {
        id: "usage",
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => /* @__PURE__ */ jsx4(UsageMeter, { ctx })
      },
      {
        id: "palette-open",
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          label: "HarnessBot: Open",
          keywords: ["harnessbot", "bots", "roster", "agents", "contacts"],
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: "keybind-open",
        area: KEYBINDS_AREA,
        data: {
          id: `${ID}.open`,
          category: "view",
          defaults: ["mod+alt+b"],
          label: "HarnessBot: Open",
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: "mentions",
        area: COMPOSER_AT_COMPLETIONS,
        data: {
          provide: (query) => {
            const bots = queryClient.getQueryData(KEYS.bots) ?? [];
            const q = query.trim().toLowerCase();
            return bots.filter((bot) => !q || bot.name.toLowerCase().includes(q)).slice(0, 8).map((bot) => ({
              id: `harnessbot:${bot.id}`,
              label: bot.name,
              detail: bot.title || "HarnessBot",
              insert: `@${bot.name}`
            }));
          }
        }
      }
    ]);
    void harness.ensureRunning().then(() => {
      void queryClient.prefetchQuery({ queryKey: KEYS.bots, queryFn: () => harness.bots() });
    });
  }
};
export {
  plugin_default as default
};
