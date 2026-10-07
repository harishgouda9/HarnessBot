# HarnessBot — Improvement Architecture Design

Companion to `docs/analysis-report.md`. This document specifies the **target
architecture** for delivering the report's findings: how the system is structured
today, what changes, and exactly where each line of new work lands.

Design constraints carried over from the project charter (non-negotiable):

1. One persistence → SSE joint; no second write path (CONTRIBUTING lesson 1).
2. Zero runtime dependencies in the harness; devDeps need a reason in the PR body.
3. `node:http` + `node:sqlite` stay; no web framework, no state library.
4. Loopback-only trust model unchanged; drivers keep the `contracts.ts` SPI.
5. Capabilities stay honest: the UI never offers a knob a driver cannot turn.
6. Additive schema only; unknown enum values fail closed.

---

## 1. System context (as-is)

```
                    ┌──────────────────────────────────────────────┐
                    │  Electron shell (electron/main.mjs)          │
                    │  window · tray · single-instance · port pick │
                    │  harness spawned as utilityProcess (node)    │
                    └──────────────┬───────────────────────────────┘
                                   │ env: HB_PORT, HB_DATA_DIR
        ┌──────────────────────────┼───────────────────────────────┐
        │ Renderer (dist/)         │        Harness (dist-server/) │
        │                          ▼                               │
        │  React 19 ── StoreProvider ── one reducer ── one SSE fold │
        │     │  typed HTTP (api.ts)        ▲                      │
        │     └──────── /api/* ─────────────┤                      │
        │                                   │ broadcast()  ← SINGLE│
        │                          node:http server (index.ts)     │
        │                          routes · SSE · static · body    │
        │                                │                         │
        │     ┌──────────────────────────┼──────────────┐          │
        │     ▼                          ▼              ▼          │
        │  turns.ts orchestration    store.ts        domain mods   │
        │  (queue, approvals,        (JSON+SQLite    (memory, jobs,│
        │   usage, rooms)             emit-join)      routines, …) │
        │                │                                              │
        │                ▼                                              │
        │        harness/registry ──► drivers/{claude,codex,grok,acp,…}│
        │                │                    │                       │
        │        harness/bus ◄─────────────────┘  RuntimeEvent only    │
        │          │  │                                                │
        │          │  └─► NDJSON thread logs                          │
        │          └────► SSE clients (replay ring, 500)              │
        └─────────────────────────────────────────────────────────────┘
   Ports: 8799 harness API+SSE+UI · 8800 webhook sidecar · 5199 vite dev
   Data:  ~/.harnessbot → bots.json · groups.json · config.json ·
          messages.db (WAL) · events/*.ndjson · memory/ · skills/ · attachments/
```

Verified invariants (must survive every change in this document):

- `store.ts` mutations emit exactly one `StoreChange`; `server/index.ts`
  `broadcast()` is the only StoreChange → SSE mapping.
- `bus.publish()` drops events whose `provider` ≠ publishing driver.
- Renderer holds no agent transports; all I/O is `api.ts` HTTP + one SSE stream.
- Driver boundary passes `RuntimeEvent` only (`server/contracts.ts`).

---

## 2. Problem → architecture mapping

| Finding (report §) | Architectural cause | Target change |
| --- | --- | --- |
| Streaming re-render storm (§3.6) | Context value keyed on whole `state`; high-frequency actions (`stream`, `trace`) live in the same reducer as low-frequency ones | Split **dispatch surface**, not write path: high-frequency lane uses a selector store (§3) |
| SSE no-resume (§3.5) | `replay` ring is server-memory only; hydrate runs once | Add connection-generation re-hydrate + monotonic `seq` (§4) |
| Mega route file (§4.2) | All routes registered in one module | Route modules under `server/routes/` sharing the same router (§5) |
| Mega components (§4.2) | Growth by accretion, no ownership boundaries | Feature folders with one entry each, test-first (§6) |
| No component tests / no CI (§5) | Gates exist locally, nothing runs them | CI workflow + component/e2e layers (§7) |
| i18n façade (report §1 item 8) | Strings inline in TSX | Extraction sweep gated by `i18n:check` (§8) |
| Aider deck missing (§2.3) | Spec written, not built | New supervisor + driver + deck view per spec (§9) |
| Version/lockfile drift (§3.2–3.3) | Dual source of truth | Single-source version read; one lockfile (§10) |

---

## 3. Rendering architecture (fixes the re-render storm)

### 3.1 Principle

Keep **one reducer, one SSE fold, one write path**. Do not add Redux/Zustand.
Separate *how state is written* (unchanged) from *how renders are triggered*
(changed).

### 3.2 Two-lane store

```
                 SSE fold (store.tsx, unchanged write path)
                          │ dispatch(Action)
                          ▼
              ┌───────────────────────────┐
              │  reducer(state, action)   │   ← ONE reducer (lesson #1 intact)
              └─────────────┬─────────────┘
                            │
        ┌───────────────────┴─────────────────────┐
        ▼                                         ▼
  LOW-FREQUENCY lane                    HIGH-FREQUENCY lane
  bots, groups, config,                 'stream', 'trace',
  threads, jobs, routines,              (token deltas, runtime events)
  instances, notifications,             extracted by the fold BEFORE
  screens, orgGraph, …                  reducer dispatch:
        │                               streamBuffer / traceBuffer
        ▼                               (ref-backed, rAF-flushed @ ≤10 Hz)
  StateContext (existing                    │
  useStore() consumers)                     ▼
                                   StreamingContext via useSyncExternalStore
                                   — subscribed only by Chat's stream strip,
                                     InspectorPanel, and the trace view
```

### 3.3 Concrete changes (renderer only)

1. `src/store.tsx` — the SSE fold's `on('stream', …)` and `on('runtime', …)`
   handlers stop calling `dispatch`. They append into `streamBuffer` /
   `traceBuffer` module-level objects with a subscription list, flushed inside a
   `requestAnimationFrame` (or 100 ms timer fallback). `stream.clear` /
   `turn.started` flush-then-clear as today.
2. New `src/stream-store.ts` (~80 lines): `getSnapshot()` returns a version
   counter; `useStreaming(threadId)` uses `useSyncExternalStore` to read only the
   delta string for one thread. No new dependencies — this is the React 18+
   built-in.
3. `State.streaming` and `State.trace` are **removed** from the reducer state; the
   reducer keeps handling every other action exactly as now. The `stream` /
   `stream.clear` / `trace` action types retire with them.
4. `StoreValue` splits into `state` (from reducer) + `actions` (stable identities
   via `useRef`), so `useMemo([state])` no longer couples action stability to data
   changes. Components reading actions stop re-rendering on unrelated state.
5. `Bubble` gets `React.memo` with primitive props (`messageId`, `role`, `text`,
   `isUser`, …) so markdown results are reused across renders.

### 3.4 Invariants preserved

- Still exactly one place where SSE events become state (the fold).
- Optimistic-local-mutation class of bugs stays impossible: the buffers hold
  **display-only streaming text**, never persisted transcript — the finished reply
  still arrives via `message` StoreChange, exactly as today.
- Inspector's `trace` cap (300) moves into the buffer; entries older than the cap
  drop on flush.

### 3.5 Acceptance tests

- `src/stream-store.test.ts`: buffer coalesces N deltas into one notification per
  frame; `stream.clear` empties; subscriber isolation (change to thread A does not
  notify thread B).
- Component test: render Chat with 60 messages, feed 500 deltas, assert render
  count of `Sidebar` stays flat (React Profiler counter or render-count spy).

---

## 4. SSE delivery architecture (fixes no-resume)

### 4.1 Server changes (`server/index.ts` → later `server/routes/events.ts`)

```
broadcast(kind, data)
   │
   ├─ seq = ++globalSeq                     ← NEW (monotonic, per-process)
   ├─ frame: `id: ${seq}\nevent: ${kind}\ndata: …`
   ├─ replay.push({ seq, kind, data })      ← existing ring, now seq-tagged
   └─ write to each client

GET /api/events?since=<seq>                 ← NEW optional query
   │
   ├─ replay items with seq > since         ← precise resume
   ├─ if since is from a previous boot (seq reset detected:
   │    serverSeqBase mismatch) → send `event: resync` instead
   └─ hello { clientId, replay, serverBootId }
```

### 4.2 Renderer changes (`src/api.ts` + `src/store.tsx`)

1. `streamEvents(path)` records the last seen `id:` per frame; exposes
   `lastEventId()`.
2. The store keeps `lastSeq` (+ `serverBootId`) in a ref. On reconnect it passes
   `?since=lastSeq`.
3. On `hello` where `serverBootId` changed (harness restarted) **or** on
   `event: resync`, the fold re-runs the hydrate bundle — the same
   `refreshBots/Instances/Config/Routines/Notifications` calls the mount effect
   uses, extracted as `hydrate()` shared by both paths.
4. First connect (no `since`) behaves exactly as today — replay ring is still
   sent, so nothing changes for a fresh page load.

### 4.3 Compatibility

Old client + new server: ignores `id:` lines (SSE spec: unknown fields are
ignored) → today's behavior. New client + old server: no `id:` seen, `since`
query ignored → falls back to replay ring → today's behavior. No break either way.

### 4.4 Acceptance tests

- `server/index.test.ts` additions: frames carry increasing `id`; `?since=`
  returns only newer frames; boot-id mismatch triggers `resync`.
- `src/event-stream.test.ts` additions: parser records last id; reconnect URL
  carries `since`; `resync` triggers exactly one hydrate.

---

## 5. Harness API modularization (splits `server/index.ts`)

### 5.1 Target layout

```
server/
  index.ts            ← bootstrap only: config, static, SSE core, listen  (~300 lines)
  http.ts             ← router (route/match), HttpError, bad/notFound,
                        readJsonBody, Handler context        (shared, stable)
  sse.ts              ← clients map, broadcast(), replay ring, seq   (the JOINT)
  routes/
    health.ts         ← /api/health
    events.ts         ← /api/events (§4)
    bots.ts           ← /api/bots/* (CRUD, read, duplicate, tasks, messages,
                        interrupt, respond, approvals, rewind, edit, queue)
    threads.ts        ← /api/threads/* (messages, reactions, events, export)
    groups.ts         ← /api/groups/*  (rooms)
    config.ts         ← /api/config
    instances.ts      ← /api/instances/*, /api/local-models, /api/cli-*
    mcp.ts            ← /api/mcp-servers/*
    computer.ts       ← /api/bots/:id/{computer,local-vm,browser}, /api/internal/screen
    routines.ts       ← /api/routines/*, /api/calendar-calls
    jobs.ts           ← /api/jobs/*
    search.ts         ← /api/search
    org.ts            ← /api/org-graph/*, /api/team-map, /api/teams/*
    skills.ts         ← /api/skills, /api/recordings/*
    webhooks.ts       ← /api/webhooks/*
    tts.ts            ← /api/tts/*
    attachments.ts    ← /api/attachments/*
    phone.ts          ← /api/phone/*
    internal.ts       ← /api/internal/* (token-gated)
    misc.ts           ← /api/backup, /api/package-status, /api/hermes,
                        /api/decisions, /api/notifications, /api/sidebar-sections
```

Each module: `import type { Register } from '../http.ts'; export function register(r: Register): void { r.get('/api/bots', …); … }`.
`index.ts` calls all `register()`s in one list.

### 5.2 Rules

- `broadcast()` lives ONLY in `sse.ts`; routes import it never — they mutate
  `store.ts`, which already emits `StoreChange`, and the existing
  StoreChange→SSE wiring in `sse.ts` maps it (the joint moves file, not shape).
- Route bodies are copied verbatim first — **no behavior change in the split PR**.
  Route tests (`index.test.ts` etc.) keep passing unmodified, which proves the
  extraction.
- `scripts/bundle-server.mjs` resolves static imports → new files included
  automatically; still re-run `pnpm build:server` + `test:packaged-server`
  (CONTRIBUTING lesson 15) and confirm `/api/health` green in the package.
- `/api/internal/*` stays last-registered with its token middleware so ordering
  bugs surface in the existing route-match tests.

### 5.3 Sequencing

1. PR A: extract `http.ts` + `sse.ts` (pure moves) + tests green.
2. PR B–E: move route groups in the order health/events → bots/threads/groups →
   config/instances/mcp → everything else. Each PR is mechanical and test-gated.

---

## 6. Renderer modularization (splits mega-components)

### 6.1 Target layout

```
src/
  App.tsx · main.tsx · store.tsx · stream-store.ts (§3) · api.ts · i18n.ts
  features/
    chat/
      ChatView.tsx          ← entry (from Chat.tsx)
      Bubble.tsx · Markdown.tsx · Composer.tsx · MessageList.tsx
      transcript-menu.ts    ← pure helpers (already mostly in composer-send.ts)
      chat.test.tsx
    settings/
      SettingsModal.tsx     ← entry (from Settings.tsx)
      tabs/{Providers,Mcp,Computers,Webhooks,Voice,Appearance,Advanced}.tsx
      settings.test.tsx
    dialogs/                ← from Overlays.tsx, one file per dialog
      Modal.tsx             ← shared primitive (focus trap lands here, §6.3)
      NewBotDialog.tsx · CommandPalette.tsx · EngineSwitcher.tsx · …
    computer/  ← Panels.tsx ComputerPanel + Workspaces.tsx
    memory/    ← Panels.tsx MemoryPanel + InspectorPanel
    teammap/   ← TeamMap.tsx + ChatDrawer split
    skills/    ← Skills.tsx
    sidebar/   ← Sidebar.tsx + Avatar + UsageChip
  components/ui/            ← Icons, Avatar primitives, shared input classes
```

### 6.2 Extraction rules (per CONTRIBUTING: no drive-by refactors)

1. Write the component tests FIRST (§7) against the *current* file — they pin
   behavior.
2. Move one component per PR; exports from the old path re-export during the
   transition so `App.tsx` diffs stay one line.
3. No visual/JSX changes in extraction PRs; screenshots in the PR body per
   CONTRIBUTING.
4. Inline `style={inputStyle}` constants consolidate into `.hb-input` CSS class in
   a follow-up (design-system §4.4 of the report), not during the move.

### 6.3 Accessibility work landing with the split

`Modal.tsx` gains: initial focus to first focusable (or the dialog itself),
Tab/Shift+Tab cycle trap, focus restore to the invoker on close, `aria-describedby`.
Every dialog inherits it by moving to the primitive — this closes report §4.3
item 2 with no per-dialog effort.

---

## 7. Quality engineering architecture (tests + CI)

### 7.1 Layer model

```
Layer 3  e2e (Playwright, 1–3 smokes)        → test:e2e        (NEW)
Layer 2  component tests (Testing Library)   → *.test.tsx      (NEW)
Layer 1  unit/contract (existing vitest)     → *.test.ts       (402 today, KEEP)
Layer 0  static gates (tsc, oxlint,          → verify script   (KEEP, wire to CI)
         contrast, i18n, electron --check)
```

New devDependencies (each with PR-body justification per charter):
`@testing-library/react`, `@testing-library/user-event`, `jsdom` (Layer 2);
`@playwright/test` (Layer 3); `@vitest/coverage-v8` (measurement). None enter the
runtime bundle — `scripts/bundle-server.mjs` only follows server imports, and
Vite only follows renderer imports; tests are excluded by their `*.test.*` names.

### 7.2 vitest config evolution

```ts
// vitest.config.ts — additive
test: {
  // existing: include server/src/integrations/scripts *.test.ts, forks pool…
  projects: [
    { // node-side (current behavior, unchanged)
      extends: true,
      environment: 'node',
      include: ['server/**/*.test.ts', 'integrations/**/*.test.ts',
                'scripts/**/*.test.ts'],
    },
    { // renderer components (NEW)
      environment: 'jsdom',
      include: ['src/**/*.test.tsx'],
    },
  ],
  coverage: {
    provider: 'v8',
    include: ['server/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['**/*.test.*', 'server/testing/**'],
    // thresholds: start at measured baseline, ratchet upward
  },
}
```

Forks pool stays for server tests (DATA_DIR isolation is load-bearing —
`server/testing/setup.ts`).

### 7.3 Component journeys (priority order)

1. `chat-send.test.tsx` — dispatch SSE `message` + stream buffer updates → bubble
   settles. Pins §3's two-lane design.
2. `approval-card.test.tsx` — Allow / Deny / Always-allow renders the narrow key;
   click calls `/api/bots/:id/respond` with expected body (mock `fetch`).
3. `no-engines.test.tsx` — `noEngines(state)` true → setup screen, not empty
   roster (pins the documented "empty ≠ not-asked-yet" rule).
4. `thread-race.test.tsx` — snapshot GET resolves after newer SSE message →
   message still visible (the `inflight` invariant).

### 7.4 e2e smoke (single spec, hermetic)

`e2e/smoke.spec.ts`: spawn harness with `HB_DATA_DIR=<tmp>` + fake driver, serve
`dist/`, Playwright opens app → asserts roster renders → sends message to fake bot
→ asserts streamed reply + decision-log entry → closes. Runs only on CI + pre-release,
never in `verify` (keeps local loop fast).

### 7.5 CI pipeline (new `.github/workflows/verify.yml`)

```yaml
name: verify
on: { push: { branches: [main] }, pull_request: }
jobs:
  verify:
    runs-on: ubuntu-latest          # tests are OS-neutral (fakes, no CLIs)
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4  # version from packageManager field
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile   # requires the Phase 0 lockfile fix
      - run: pnpm verify
      - run: pnpm test -- --coverage
      - run: pnpm test:e2e                   # enabled once Playwright lands
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage/ }
```

The workflow is added after Phase 0 establishes the pnpm lockfile; enable the e2e
step when the Playwright layer lands. A later manual desktop workflow can run
`pnpm package:win`; signing stays out of scope.

---

## 8. i18n architecture (closes the façade)

### 8.1 Direction

Keep the runtime overlay design (`t()` + catalogs + English fallback) — it is the
right shape for this app. Fix coverage, not machinery.

### 8.2 Steps

1. **Extraction sweep**: codemod + hand pass replacing literal chrome strings in
   `src/features/**` with `t('domain.key')`. Catalog grows from 24 keys to an
   expected ~300. Keys use `area.name` convention already present.
2. **Checker upgrade** (`scripts/i18n-check.mjs`): report `% of source strings
   using t()` as a new line; fail CI below a ratcheted floor (start 60 %, raise to
   90 %). Missing *translations* keep the current warn-and-fallback behavior —
   honest and non-blocking for contributors.
3. **Locale backfill**: machine-translate the 7 locales for the full key set, then
   hand-review high-traffic keys (composer, approvals, onboarding) — approval
   strings must never be ambiguous in another language.
4. **HTML layout audit**: no text in `::before/::after` (keeps keys extractable).

### 8.3 What stays English by design

Engine/CLI proper nouns, `docs/`, and workspace sidebar labels noted as hardcoded
in `aider-deck.md` — documented exceptions, listed in the checker's allowlist.

---

## 9. Feature architecture: Aider deck (per `docs/aider-deck.md`)

The spec exists and is authoritative; this section only shows where it plugs into
the target architecture.

```
operator / bot turn
      │
      ▼
Aider driver (server/drivers/aider.ts)         ← NEW, registered in builtIn.ts
      │  one session per threadId               kind: 'aider', caps: steer only
      ▼
AiderDeck supervisor (server/aider/deck.ts)     ← NEW
      │  spawn(argv[]) — never shell:true       caps: 8 sessions, 400 evt / 256 KiB
      ▼
aider process ──stdout lines──► ring buffer ──SSE──► HarnessBot view 'aider'
      ▲                                             sessions | stream | editor
      │ stdin (prompt, /add, /exit)                    │
file editor ──PUT (path contained, mtime-checked)──────┘
```

Landing points in the target architecture:

- **Routes** → `server/routes/aider.ts` (registered in §5's list):
  `GET/POST/DELETE /api/aider/sessions`, `POST …/:id/input`, `GET …/:id/tree`,
  `PUT …/:id/file`.
- **View** → `src/features/aider/AiderDeck.tsx` per §6; `view` union in
  `store.tsx` + sidebar workspace item.
- **Transport rule holds**: chat messages remain canonical `RuntimeEvent`s through
  the bus; the deck's SSE is a *separate* endpoint scoped to sessions (like
  `/api/threads/:id/events`), not a second write path for chat.
- **Tests** → `server/aider/deck.test.ts` against a Node fake (READY/ECHO/EXIT),
  unit-level, no HTTP boot — exactly as the spec's Testing section demands.
- **Bundle** → supervisor is statically imported from a route module → picked up
  by `bundle-server.mjs`; smoke test covers packaged launch (lesson 15).

---

## 10. Release-engineering architecture (version + lockfile single-sourcing)

### 10.1 Version

```ts
// server/version.ts  (NEW — generated or read once)
import { createRequire } from 'node:module';
export const VERSION: string =
  (createRequire(import.meta.url)('../package.json') as { version: string }).version;
```

- `GET /api/health` returns `version: VERSION`.
- `server/index.test.ts` asserts `body.version === VERSION` (import, no literal).
- Packaged build: `bundle-server.mjs` already inlines JSON imports it reaches —
  verify in the packaged smoke test that `/api/health` still answers the right
  string; if the bundler drops it, switch to a tiny generated
  `version.ts` written by the build script instead (same single-source rule).

### 10.2 Lockfile

1. Delete `package-lock.json`.
2. `pnpm install` → commit `pnpm-lock.yaml`.
3. CI uses `pnpm install --frozen-lockfile` (§7.5) so drift fails the build.
4. README/CONTRIBUTING already document pnpm — no doc change needed.

---

## 11. Data-layer evolution (FTS + analytics, additive only)

```
~/.harnessbot/messages.db  (SQLite WAL today)
   messages … existing schema untouched
   + FTS5 virtual table message_fts(text, content='messages')   ← ADDITIVE
   + triggers keep it in sync (INSERT/UPDATE/DELETE)
   + migration runs once behind a version pragma in message-db.ts
```

- `server/search.ts` gains an FTS fast-path (`MATCH ?`) with the current linear
  filter as fallback if the index is missing — unknown-state fails open to today's
  behavior, matching the fail-closed/fallback house style.
- **Analytics** needs no schema: `TaskUsage` + `spend.ts` already bank per-task
  cost/turns; a new `GET /api/usage/summary?from&to` route (in §5's routes list)
  aggregates it, and the renderer page renders plain SVG bars — no chart library,
  honoring the zero-runtime-dep altitude rule.

---

## 12. Delivery roadmap (dependency-ordered)

```
Phase 0  Hygiene            lint 4 warnings · lockfile · version single-source
         (report §3.1–3.4)  └─ gates green at 0 warnings
              │
Phase 1  Perf + Resume      two-lane store (§3) · Bubble memo · SSE since+hydrate (§4)
         (report §3.5–3.6)  └─ render-count test + resume tests green
              │
Phase 2  Quality rails      CI workflow (§7.5) · coverage ratchet · 4 component
         (report §5)        journeys · first e2e smoke
              │
Phase 3  Structure          server/routes split (§5, PR A–E) · features/ split (§6,
         (report §4.2)      test-first) · Modal focus trap lands with dialogs
              │
Phase 4  Features           Aider deck (§9) · FTS + usage page (§11) · toasts ·
         (report §6)        DnD attachments · settings search · keyboard map
              │
Phase 5  i18n completion    extraction sweep + locale backfill (§8)
         (report §1 item 8; §6 backlog)
```

Phase gates: every phase ends with `pnpm verify` green (plus the new CI layers
from Phase 2 onward). Phases 0–1 are small, independent PRs; Phase 3's splits are
mechanical and reversible; nothing in this plan rewrites the driver SPI, the store
joint, or the trust model.

