# Contributing

## The bar

```
pnpm typecheck && pnpm test
```

Server changes come with tests. UI changes come with a screenshot and a journey you
actually walked, not a single render.

## Match the altitude

This codebase is small, direct, plain Node. Thirty lines beat a new framework, and the
harness has **zero runtime dependencies** on purpose — it is `node:http`, `node:sqlite`,
and about sixty lines of hand-rolled validation. A new runtime dependency needs a
reason in the PR body.

Other habits worth keeping:

- Colocate tests as `*.test.ts` next to the code.
- Comments explain *why*. Don't delete one that explains a past incident.
- Additive schema only: optional fields, migrated in place. Unknown enum values fail
  closed (`autoReview` → `off`).
- Don't refactor unrelated code in a feature PR.

## Adding an engine

1. Read `server/contracts.ts`.
2. Add an entry to `SPECS` in `server/drivers/builtIn.ts`, or a new file calling
   `defineCliDriver` if the vendor needs real protocol work.
3. `decodeConfig` throws synchronously; `create` rejects asynchronously. A missing CLI
   snapshots as `unavailable` with a reason that names the next action.
4. Emit only your own `driverKind` events — the bus drops the rest.
5. Write a contract test against a scripted fake CLI (see
   `server/drivers/claude.test.ts`), covering stream, tools, permission round-trip,
   interrupt, and a failure mode. Don't mock `child_process`; the bugs live in the
   spawn path.

Capabilities must be honest. If the driver cannot mount a computer, say so — the UI
reads the snapshot and will otherwise offer a tool that silently fails.

## Adding a chat card

Extend `Message.kind` and its payload type in `shared/types.ts`, redact bot-authored
fields in the store, render it in `Chat.tsx` with the existing card chrome, and add a
round-trip test. Never store executable code in a card. If it is a confirmation, it
must require an explicit click before any side effect, and bind a digest if the bytes
matter.

## Testing rules

- No sleeps. Wait on events (`recordEvents().until(...)`) or on SSE.
- Never touch the real `~/.harnessbot`. `server/testing/setup.ts` points `HB_DATA_DIR`
  and `HOME` at a temp dir before anything is imported.
- Driver tests use scripted fake CLIs; extend `FAKE_MODE` rather than mocking spawn.
- Fake CLI shebangs launch through Node on Windows.

## Things that are not "simplifications"

These are paid-for lessons. A PR that removes one is a regression:

1. Every store write emits a `StoreChange`; every user-visible event persists. One
   joint, no second write path.
2. Resume cursors are per task. A rewind drops them and replays the visible branch.
3. Never offer a capability the driver's `capabilities` object does not declare.
4. "Always allow" is a narrow key bound to a pending request, not a blanket grant.
5. Local-computer approval scope is a separate memory from cloud and tool grants.
6. Imported packages: `composio: false`, MCP off, routines paused, no credentials.
7. Human computer control is a two-phase hold. UI state alone must not assert release.
8. Browser profile ids are lowercase; `guest` is reserved.
9. Webhook secrets are shown once; Bearer beats a secret in a URL.
10. Preview is not permission. Auto must not start host automation.
11. Wayland: never start host automation, and clear legacy opt-ins.
12. Don't sum `thread.token-usage.updated` — bank from `turn.completed` only.
13. A skill card's sha256 must match the staged bytes, or the card is deny-only.
14. At most one Chief of Staff per section; `reportsTo` is repaired on load.
15. New spawnable entry points go in `SPAWNED_PROXIES` in `scripts/bundle-server.mjs`.
    Incident 0.1.24 was an unbundled import that killed packaged launch while
    `/api/health` stayed green.
16. MCP JSON schemas stay flat: no `oneOf` / `anyOf` / `allOf` / `const` / `format`.

## Out of scope unless asked

Moving the harness to the public internet. Multi-tenant SaaS auth on the agent loop.
Replacing the driver model with one hosted LLM proxy. Enabling Wayland host control
without a real-seat safety design. Credentials in team packages. A token or paywall.
Skins that fail AA contrast.
