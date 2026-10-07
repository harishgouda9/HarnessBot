# HarnessBot — Deep Analysis & Improvement Report

Date: 2026-10-06 · Codebase: `main` @ e8619f5 (working tree, v0.1.44) · Analyzer: automated deep review

---

## 1. Executive summary

HarnessBot is a **local-first, two-process desktop chat app** (React renderer + plain
`node:http` harness) where every contact is a real AI agent driven through vendor CLIs
(Claude, Codex, Grok, ACP, OpenAI-compatible). The engineering quality is **unusually
high** for a project this size: strict TypeScript across three tsconfigs, 402 passing
tests across 51 files, WCAG AA contrast gates, an i18n checker, an Electron syntax
gate, a documented security model, and a deliberately small dependency surface (zero
runtime dependencies in the harness).

The full `pnpm verify` chain was executed for this report:

| Gate | Result |
| --- | --- |
| `typecheck` (app + server + desktop) | ✅ 0 errors (strict + `noUncheckedIndexedAccess`) |
| `test` (vitest) | ✅ **51 files, 402/402 tests pass** (44s) |
| `lint` (oxlint, 96 rules) | ⚠️ **4 warnings, 0 errors** (details in §3.1) |
| `check:contrast` | ✅ 5 skins × 9 pairs, AA 4.5:1 |
| `i18n:check` | ⚠️ en 24/24; **7 locales at 38–58%** of only 24 keys |
| `check:electron` | ✅ `node --check` passes on all 3 files |

**Top findings, in priority order:**

1. **Streaming re-render storm (UI performance bug).** Every streamed token dispatches
   into the single reducer, which produces a new `state`, which recreates the context
   value (`useMemo([state])`), which re-renders **every** `useStore()` consumer —
   Sidebar, Chat, Panels — at token rate. §4.1 has the fix that preserves the
   one-reducer invariant.
2. **Four lint warnings**, three of which are real code smells: nullish-coalescing used
   for control flow (`store.getBot(...) ?? notFound(...)`) in three routes. It works
   today because `notFound()` throws, but it is exactly the pattern that breaks under
   "cleanup" refactors. §3.1.
3. **Lockfile inconsistency.** `package.json` declares `packageManager: pnpm@10.33.0`
   and the README says `pnpm install`, yet the repo ships `package-lock.json` (npm,
   297 KB) and no `pnpm-lock.yaml`. Two package managers will drift. §3.2.
4. **Version string is tripled.** `0.1.44` is hardcoded in `server/index.ts`
   (`/api/health`), asserted literally in `server/index.test.ts`, and declared in
   `package.json`. A release bump that misses one breaks the health test or ships a
   wrong version. §3.3.
5. **No CI.** There is no `.github/` directory — every gate must be run by hand, and a
   46-file modified working tree (current state) shows how easily things pile up. §3.4.
6. **Zero UI component tests.** All 402 tests cover server logic, stores, and pure
   modules; `src/components/` (≈450 KB of TSX) has no render/journey tests, and there
   is no e2e layer. §5.1.
7. **Mega-files.** `server/index.ts` (1,669 lines, ~160 routes), `Settings.tsx`
   (1,356), `Chat.tsx` (1,328), `Panels.tsx` (1,232), `Overlays.tsx` (51 KB),
   `TeamMap.tsx` (51 KB). They compile and test fine, but they slow review, amplify
   merge conflicts, and hide ownership. §6.1.
8. **i18n is a façade.** 23 `t()` call sites vs. a UI with hundreds of strings; 7 of 8
   locales cover ≤58% of just 24 keys. The checker passes "by design", but the product
   is effectively English-only. §6.
9. **SSE replay has no resume.** A ring buffer of 500 events with no `Last-Event-ID`
   cursor: a client disconnected long enough silently misses roster/config changes
   until a manual reload. §3.5.
10. **A shipped spec with no implementation:** `docs/aider-deck.md` fully specifies the
    Aider realtime session deck (routes, events, driver, UI, tests) but
    `server/aider/`, `server/drivers/aider.ts`, and `src/components/AiderDeck.tsx` do
    not exist. This is the single largest ready-to-build feature. §2.3.

**Nothing found that threatens the security model.** The loopback bind, Host-header
check, write-only secrets, argv-only spawning (no `shell: true` anywhere), per-provider
env isolation, narrow approval grants, and redaction pipeline are all present and
consistent with `SECURITY.md`. §7.

---

## 2. What the system is today

### 2.1 Component inventory

| Layer | Files | Size | Role |
| --- | --- | --- | --- |
| Harness API | `server/index.ts` | 1,669 lines | Whole HTTP + SSE API, plain `node:http`, loopback-only, no auth (OS account is the boundary) |
| Turn orchestration | `server/turns.ts` | 1,019 lines | Queueing, cwd pinning, approvals wiring, usage banking, room routing |
| Driver SPI | `server/contracts.ts` | ~270 lines | `RuntimeEvent` union, `ProviderAdapter`, `DriverCapabilities` — the architecture in one file |
| Drivers | `server/drivers/` (acp 32 KB, cli 24 KB, openai-compat, claude, grok, spawn, builtIn) | | One entry per vendor; `builtIn.ts` is the table |
| Harness core | `server/harness/{bus,registry}.ts` | small | Event fan-in with provider-match drop; config → adapter-or-shadow |
| Persistence | `server/store.ts` (19.7 KB), `message-db.ts`, `paths.ts` | | Single persistence→SSE joint; SQLite WAL; NDJSON thread logs |
| Domain modules | approvals, memory, routines, jobs, skills, org, teams, computer, vm, phone, spend, search, webhooks, backup… (85 files, 37 with tests) | | Business logic, each colocated-test-covered |
| React app | `src/` — store (659 lines), App, api, i18n, 18 components | ≈450 KB TSX | No transports of its own; one SSE fold, one reducer |
| Styling | `src/styles.css` | 419 lines | 5 skins via `[data-skin]` CSS vars, reduced-motion block, WCAG-gated |
| Desktop shell | `electron/` | 3 files | Window, tray, single-instance, port pick + health probe, harness as `utilityProcess` |
| Control planes | `scripts/mcp-server.mjs`, `server/mcp/*` | | Bounded MCP for Cursor/Claude Desktop; computer driver |
| Integration | `integrations/hermes/` | Python + TSX | Plugin inside Hermes (bridge, supervisor, dashboard, desktop) |
| Specs | `docs/aider-deck.md` | | **Unimplemented** Aider deck feature spec |

### 2.2 Data flow (verified)

```
UI send ──POST /api/bots/:id/messages──► turns.sendTurn
   └► registry.get(instanceId) ──► driver.sendTurn(SendTurnInput)
        └► vendor CLI / ACP / HTTP stream
             └► ctx.emit(RuntimeEvent) ──► bus.publish(driverKind, event)
                  ├─► NDJSON thread log (except content.delta)
                  └─► subscribers: turns (buffer/approvals/usage) + SSE broadcast
                       └► store mutations emit StoreChange ──► broadcast(kind, data)
                            └► renderer SSE fold ──► reducer ──► React render
```

Two invariants hold end-to-end and are protected by tests:
**every store write emits exactly one `StoreChange`** (no second write path), and
**the bus drops events whose `provider` ≠ publishing driver** (no forged attribution).

### 2.3 Feature surface vs. advertised surface

README promises: roster/contacts, tasks as clean slates, in-chat approvals with narrow
grants, readable memory, team map, rooms, computer use (opt-in → screenshot → approve),
voice (macOS), webhooks, routines/jobs, skills, MCP servers, Hermes plugin. **All were
found implemented.** The gap list — things specified or implied but absent:

| Gap | Evidence | Value |
| --- | --- | --- |
| Aider deck | full spec in `docs/aider-deck.md`, zero implementation files | High — realtime session surface |
| Transcript search speed | `search.ts` filters in JS over loaded messages; SQLite could host FTS5 | Medium |
| Usage/cost analytics view | `spend.ts` + `UsageChip.tsx` exist, no history/chart page | Medium |
| i18n completeness | §1 item 8 | Medium |
| Windows/Linux dictation & calls | README admits macOS-only — UI correctly does not fake it | Low (honest) |
| Auto-update implementation | `config.updates: 'Automatic' \| 'Manual'` exists; no updater code found (`electron-updater` absent) | Verify intent |


---

## 3. Bugs, errors, and correctness findings

### 3.1 Lint gate: 4 warnings (the only failing gate in `pnpm verify`)

| # | Location | Rule | Assessment | Fix |
| --- | --- | --- | --- | --- |
| 1 | `server/jobs.test.ts:441` | no-unused-vars (`job`) | Dead local in a test | Delete or rename `_job` |
| 2 | `server/index.ts:1442` (`GET /bots/:id/jobs`) | no-unused-expressions | Works only because `notFound()` throws | `if (!store.getBot(params.id!)) notFound('no such bot');` |
| 3 | `server/index.ts:1447` (`POST /bots/:id/jobs`) | no-unused-expressions | Same pattern | Same fix |
| 4 | `server/index.ts:1481` (`GET /jobs/:id/log`) | no-unused-expressions | Same pattern | `if (!jobs.getJob(params.id!)) notFound('no such job');` |

Warnings 2–4 are **latent bugs**: the guard's effectiveness depends on an expression
being evaluated for side effect, which a well-meaning refactor (e.g. "simplify the
coalescing") silently removes — turning a 404 into a 200. Fix before anything else;
three one-line edits, no behavior change, `oxlint` returns to 0 warnings.

### 3.2 Lockfile / package-manager drift (release engineering)

`package.json` → `"packageManager": "pnpm@10.33.0"`, README/CONTRIBUTING → `pnpm …`,
but the repo contains `package-lock.json` and no `pnpm-lock.yaml`. Consequences:
installs are not reproducible against the declared manager; contributor installs via
npm silently succeed with a different resolution; Corepack will complain. Fix: delete
`package-lock.json`, commit `pnpm-lock.yaml`, and gate it in CI.

### 3.3 Version string triplication

`server/index.ts:280` hardcodes `version: '0.1.44'`, `server/index.test.ts:91`
asserts the literal, `package.json` declares `0.1.44`. Fix: read the version once
from `package.json` in the server and assert it equals `package.json.version` in the
test. One source of truth, release bumps become atomic.

### 3.4 No CI pipeline

No `.github/workflows`. `pnpm verify` (typecheck → test → contrast → i18n → electron)
is comprehensive but manual. With a 46-file dirty working tree today, the risk is
real. Fix: one workflow running `pnpm verify` on push + PR (spec in the companion
architecture doc, §7).

### 3.5 SSE replay has no resume cursor

`server/index.ts` keeps a global `replay` ring (cap 500, `REPLAY_MAX`) and replays it
to each new client; the renderer reconnects after 1.5 s (`store.tsx` error handler) but
**there is no `Last-Event-ID` and no re-hydrate on reconnect**. A client disconnected
while >500 events accumulate — or across a harness restart (replay is in-memory) —
misses `bot`, `config`, and `message.patch` changes; the UI shows stale roster state
until reload. The initial hydrate runs only once on mount (`useEffect(..., [])`).
Fix (two small steps, no protocol break): (a) on SSE `hello` after a dropped
connection, re-run the hydrate bundle; (b) optionally add a monotonic `seq` to frames
and a `?since=` query for precise resume. Both are specified in the architecture doc §4.



### 3.6 Streaming re-render storm (performance bug, user-visible)

`src/store.tsx:628`: `useMemo(..., [state])` — the context value changes on **every**
reducer call. The SSE fold dispatches `stream` on every `content.delta`
(`store.tsx:594–596`) and `trace` on every runtime event (`store.tsx:600–608`). Each
dispatch = new `state` = new context value = re-render of every consumer (Sidebar list
of up to 100 bots, Chat transcript, Panels) **per token**. At 50 tok/s this is 50
full-tree renders/second. It works in small transcripts; it will jank in long ones on
weak machines. The fix must NOT split the write path (CONTRIBUTING lesson #1) — see
architecture doc §3: keep one reducer, route streaming/trace through a ref-backed
store with `useSyncExternalStore` selectors, dispatch at ≤10 Hz via rAF batching.

### 3.7 Smaller correctness notes

| Item | Location | Severity | Note |
| --- | --- | --- | --- |
| `listBots()` returns the live internal array | `server/store.ts` | Low | Callers can mutate store state by reference. Return a copy or a `readonly` type. |
| `JSON.stringify` config equality | `server/harness/registry.ts:79` | Low | Key-order sensitive; stable today (JSON round-trip) but a deep-equal avoids needless adapter restarts after config edits. |
| `portFree()` resolves `true` after 400 ms even under a slow listener | `electron/main.mjs:72` | Low | If a listener accepts >400 ms later, port reported free → `EADDRINUSE` at bind. Add try/catch around listen with fallback to next candidate. |
| `readJsonBody(): Promise<any>` | `server/index.ts:170` | Low | The only `any`-typed boundary; parsing is validated ad hoc per route. Type it `unknown` and narrow centrally. |
| Dual generation counters for thread fetch | `store.tsx` state `fetchGen` + ref `fetchGen.current` | Low | Two sources of truth for "is this snapshot current"; consolidate on the ref (the state copy appears unread). |
| ~10 `eslint-disable` `exhaustive-deps` | store, Chat, Pages, Panels, Skills, TeamMap, Settings, ChatModelPicker, Overlays | Low | Each is documented and deliberate, but each is a stale-closure risk; migrate to stable callbacks as components split. |
| 32 MB base64 JSON uploads | `api.ts uploadAttachment`, `MAX_JSON_BYTES` | Low | Base64 inflates 33 %; building a 43 MB JS string is slow. A raw `application/octet-stream` PUT removes both costs. |
| `.aider.chat.history.md` untracked at repo root | git status | Nit | Aider artifact; add to `.gitignore`. |
| 46 modified + ~44 untracked files on `main` | git status | Process | Large uncommitted tree; commit in reviewable slices before feature work. |

### 3.8 What is NOT broken (verified, keep-green list)

- **Security controls**: loopback bind + Host check, write-only secrets
  (`publicConfig()` exposes booleans only), no `shell: true`/`exec` anywhere in the
  harness, argv-array spawning with model output reaching args, per-provider env
  isolation (`DRIVER_SECRET` table), approval broker with `unavailable` fail-closed,
  redaction before storage, webhook listener on a separate port/route set, internal
  routes behind per-boot tokens. All present as documented.
- **RuntimeEvent discipline**: provider-match drop in the bus, NDJSON skip for
  `content.delta` (the stall incident the comment references), no vendor types past
  the driver boundary.
- **Registry failure mode**: unknown driver / invalid config / create failure all end
  in a renderable `unavailable` shadow, never a thrown exception; reloads are
  serialized and a rejection cannot poison the chain.
- **Tests**: 402 passing, including driver contract tests against scripted fake CLIs
  (stream, tools, permission round-trip, interrupt, mid-stream death, auth failure),
  a fail-closed open-card test, approval timeouts that never become permission, and
  Windows-safe fake shebangs.
- **Accessibility foundations**: `role="dialog"` + `aria-modal` + labels on both
  modals, `aria-current` settings nav, `aria-expanded`/`haspopup` pickers, 110 ARIA
  attributes total, `prefers-reduced-motion` honored, AA contrast gate for all skins.
- **Markdown safety**: `skipHtml` everywhere — model output renders as text, never
  markup; no `dangerouslySetInnerHTML` / `innerHTML` in the codebase.


---

## 4. Design & UI improvement analysis

### 4.1 Performance design (highest ROI)

1. **Token-rate rendering** — see §3.6 / architecture doc §3. Also batch `trace`
   entries (they cap at 300 and are appended per event today).
2. **Memoize the transcript** — `Bubble`/`Markdown` are not `React.memo`'d; one
   `state` change re-parses markdown for all mounted messages (window = 60, grows on
   demand). Wrap `Bubble` in `React.memo` with primitive props so markdown parsing is
   cached per message id by render reuse.
3. **Virtualize long threads** — no virtualization today (windowing is count-based).
   For threads beyond a few hundred messages, replace expand-on-demand with a
   row-virtualized list while keeping the expand semantics.
4. **Context value shape** — split `StoreValue` into state-driven and action-driven
   halves so action functions are referentially stable (kills the `useMemo([state])`
   dependency on the whole object).

### 4.2 Structural design (maintainability)

**Renderer.** `Settings.tsx` (1,356 lines, 7 tabs), `Chat.tsx` (1,328), `Panels.tsx`
(1,232), `Overlays.tsx` (11 dialogs), `TeamMap.tsx` (51 KB), `Skills.tsx` (46 KB) are
each several features in one file. Target feature folders — `features/settings/`,
`features/chat/`, `features/computer/`… — with one exported entry each, extracted
**without behavior change** and covered by the new component tests (§5.1) before any
split. `Overlays.tsx` in particular should become `components/dialogs/` with one file
per dialog sharing a single `Modal` primitive (the existing one at `Overlays.tsx:12`
is already correct — Escape handling, `role="dialog"`, `aria-modal`).

**Harness.** `server/index.ts` mixes ~160 routes with SSE plumbing, static serving,
and body parsing. Split into `server/routes/{bots,threads,groups,instances,routines,
jobs,webhooks,internal,config,…}.ts`, each exporting `register(get, post, patch, put,
del)` — the router, `HttpError`, `readJsonBody`, and `broadcast` stay shared.
`broadcast()` must remain the **single** SSE joint (lesson #1); moving route files
does not touch it. The bundle script (`scripts/bundle-server.mjs`) walks static
imports, so new files are picked up — but verify `SPAWNED_PROXIES`/entry points per
CONTRIBUTING lesson #15 and re-run the packaged smoke test.

**Store.** The 42-action union and ~160-line reducer in `store.tsx` are well-factored
already (flat, no nesting). Keep one reducer; only extract `streaming`/`trace` per
§3.6. Do **not** introduce Redux/Zustand — CONTRIBUTING explicitly weighs new
dependencies.

### 4.3 UI/UX improvements

| # | Improvement | Rationale | Effort |
| --- | --- | --- | --- |
| 1 | Skeleton/empty/loading states for thread open, instances, jobs | Today: spinner-or-nothing; the `instancesLoaded` pattern already exists — extend it | S |
| 2 | Focus management in dialogs | `role="dialog"` exists; no initial focus, no focus trap, no focus restore on close | S |
| 3 | Keyboard map for transcript (↑ edit draft, ⌘K palette exists, j/k messages) | Power-user surface matches the product's CLI audience | M |
| 4 | Settings search box | 7 tabs + nested panes; a fuzzy filter that jumps to the field | S |
| 5 | Toasts for failures currently only `console`-swallowed | `catch {}` paths (thread load, speak, jobs refresh) fail silently in UI | S |
| 6 | Drag-and-drop + paste-to-attach | `uploadAttachment` exists; no DnD handlers found in Chat | M |
| 7 | Usage analytics page (spend history, per-bot cost sparkline) | Data already banked (`TaskUsage`, `spend.ts`); only a view is missing | M |
| 8 | Transcript search-in-thread (client) + global FTS (server) | `search.ts` is linear; SQLite FTS5 index over `messages.db` | M |
| 9 | Diff cards for file edits | Approvals show text; a unified diff preview raises approval quality | M |
| 10 | i18n extraction sweep | See §6 (i18n row) | M |

### 4.4 Design-system notes

The skin system (`data-skin` + CSS variables, 5 skins, contrast-gated) is solid and
should stay the single theming mechanism. Improvements: (a) document tokens
(`--color-raised`, `--color-hairline`, …) in one place — they are used inline via
`style={{}}` in dozens of components, which defeats CSS-level theming tools; (b)
standardize the repeated `inputStyle` const (defined independently in Settings,
Overlays, and others) as a shared class (`.hb-input`) — one definition, one place to
theme; (c) `anim-*` classes already respect `prefers-reduced-motion` — keep that rule
for any new animation.

---

## 5. Testing & quality plan

### 5.1 Current state

- **402 tests / 51 files, all green.** Server logic is genuinely well covered:
  approvals (26), computer (24), store (22), jobs (21), turns, routines, drivers
  (claude 14, grok 6, acp), bus, registry, org, memory, skills, teams, search,
  spend, backup, forget-bot, phone, desktop, notifications, webhooks…
- **Gap 1 — UI:** zero tests under `src/components/`. The reducer and pure helpers
  are tested (`thread-fold`, `jobs-fold`, `composer-send`, `event-stream`,
  `model-catalog`, `speak-replies`, `usage`…), but no render/journey coverage for
  Chat, Sidebar, approval cards, or Settings.
- **Gap 2 — no e2e.** No Playwright/Cypress. CONTRIBUTING asks UI changes to ship
  "a journey you actually walked"; nothing automates that journey.
- **Gap 3 — no coverage measurement.** Vitest runs without `--coverage`; nobody can
  say what fraction of `src/` is exercised.
- **Gap 4 — no CI** (§3.4).

### 5.2 Plan

1. Add `@testing-library/react` + `jsdom` (devDependencies only — the harness keeps
   zero runtime deps) and colocate `*.test.tsx` per CONTRIBUTING.
   Priority journeys: (i) send message → stream delta → message settles;
   (ii) approval card Allow/Deny/Always-allow key binding; (iii) engine-unavailable
   shadow renders a reason; (iv) thread switch with inflight snapshot race (the exact
   bug `inflight` exists for).
2. Add `vitest --coverage` (v8) with **ratcheted** thresholds: start at the measured
   baseline, raise on PRs that grow uncovered code.
3. One Playwright smoke: boot the harness (`HB_STATIC_DIR=dist`), open the app, send
   a message through the fake driver, assert the bubble + decision log. Wire as
   `test:e2e`.
4. CI runs `pnpm verify` + coverage + smoke (architecture doc §7).

---

## 6. Feature backlog (prioritized)

| Priority | Feature | Foundation already in repo | Notes |
| --- | --- | --- | --- |
| P0 | Fix 4 lint warnings, lockfile, version single-source, CI | §3.1–3.4 | Days; unblocks everything |
| P0 | Streaming render fix + memoized transcript | §3.6, §4.1 | Perf bug users feel |
| P1 | **Aider deck** | Full spec: `docs/aider-deck.md` | Implement per spec: supervisor, driver, routes, `AiderDeck.tsx`, fake-process tests. Spec forbids new deps and `--yes-always`. |
| P1 | SSE reconnect re-hydrate (+ optional `seq` resume) | §3.5 | Stale-UI bug |
| P1 | Component tests + coverage + CI | §5 | |
| P2 | Usage/cost analytics page | `spend.ts`, `UsageChip.tsx`, `TaskUsage` | Chart with plain SVG (no chart lib, per altitude rule) |
| P2 | Global transcript search → SQLite FTS5 | `message-db.ts`, `search.ts` | Migration is additive (lesson: additive schema) |
| P2 | Focus trap + skeletons + failure toasts | §4.3 items 1, 2, 5 | |
| P2 | i18n extraction sweep + locale completion | `i18n.ts`, checker | Route all new chrome through `t()`; backfill the 7 locales |
| P3 | Diff preview cards for file edits | approval card pipeline | Render-only; never executable |
| P3 | DnD/paste attachments; octet-stream upload | `uploadAttachment` | Drops the 33 % base64 tax |
| P3 | Feature-folder split of Settings/Chat/Panels/Overlays | §4.2 | Behavior-preserving, test-first |
| P3 | Route-module split of `server/index.ts` | §4.2 | Keep `broadcast` joint |
| P3 | Settings search, keyboard map | §4.3 | |
| P4 | Verify/auto-update story for `config.updates` | config field exists, updater absent | Decide: implement `electron-updater` or narrow the setting |
| P4 | Windows/Linux parity for voice/phone | honestly gated today | Track as platform work |

Out of scope by project charter (do not propose again): internet-exposed harness,
multi-tenant SaaS auth, hosted LLM proxy, Wayland host control without a safety
design, credentials in team packages, tokens/paywalls, skins failing AA.

---

## 7. Security review summary

Verified against `SECURITY.md` claims — **all controls located in code**:

- Loopback bind `127.0.0.1` + non-loopback `Host` refusal (DNS-rebinding defense) ✅
- Secrets write-only; `publicConfig()` returns `configured: boolean` only ✅
- No `shell:true`, no `exec`, no command-string building; argv arrays only ✅
- Per-provider credential env isolation (`DRIVER_SECRET`) ✅
- Approval broker fail-closed: no answerer → `unavailable` → action does not run;
  timeouts never become permission (tested) ✅
- "Always allow" binds server-issued keys to pending requests only ✅
- Real-computer grants stored separately from cloud/tool grants ✅
- Redaction of bot-authored content pre-storage; user text stored as typed ✅
- Webhook receiver on separate port, secret-gated route, hashed secrets shown once ✅
- `/api/internal/*` per-boot bearer tokens, dropped with the bot ✅
- Package imports land with connections off, MCP off, routines paused ✅
- Model output sanitized in markdown (`skipHtml`, no HTML-injection paths) ✅

Residual recommendations: (a) add a regression test asserting `/api/health` never
leaks config; (b) consider a `Content-Security-Policy` meta on the static UI (it
currently relies on framework defaults); (c) the 32 MB JSON body cap is a local-only
DoS surface — acceptable given the trust model, but worth a comment in code.

---

## 8. Evidence appendix

Commands executed for this report (working tree, 2026-10-06):

```
npm run typecheck      → 0 errors (3 tsconfigs, strict)
npm run test           → 51 files, 402/402 pass, 44.26s
npm run lint           → 4 warnings, 0 errors, 143 files, 96 rules
npm run check:contrast → OK: 5 skins, 9 pairs each, AA
npm run i18n:check     → en 100%, de 58%, es 50%, fr 46%, hi/ja/pt-br/zh 38%
node --check electron/{main.mjs,preload.cjs,tray-icon.mjs} → pass
git status             → 46 modified, ~44 untracked (pre-existing working tree)
```

Key file metrics: `server/index.ts` 1,669 lines; `src/components/Settings.tsx` 1,356;
`src/components/Chat.tsx` 1,328; `src/components/Panels.tsx` 1,232; `server/turns.ts`
1,019; `src/store.tsx` 659; `src/styles.css` 419; server has 85 TS files / 37 test
files; renderer has 11 test files / 0 component tests; 23 `t()` call sites; 110 ARIA
attributes; 0 `innerHTML`/`dangerouslySetInnerHTML`; 0 `shell:true`.

Companion document: **`docs/improvement-architecture.md`** — target system
architecture for delivering everything above.

