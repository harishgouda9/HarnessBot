# HarnessBot

A local-first desktop chat app where every contact is a real AI agent — with its own
model, memory, computer, connected apps, and voice.

HarnessBot is an open-source take on the "AI as a messaging app" idea: a roster of
named bots instead of one assistant that forgets who it is. It is **not affiliated
with xAI**, it has **no token and no cryptocurrency**, and nothing is behind a
paywall. Apache-2.0.

```
pnpm install
pnpm dev:all          # harness on 127.0.0.1:8799, UI on 127.0.0.1:5199
open http://127.0.0.1:5199
```

You need at least one agent CLI installed and logged in (`claude`, `codex`, `grok`,
`cursor-agent`, …). HarnessBot runs the CLIs you already pay for; it does not proxy
them, and it does not ask you to create an account.

## Features and benefits

Each bot is a named contact, not a blank chat box. It keeps its own model, memory,
working folder, and tool grants. You stay on this machine: the harness binds to
loopback and does not ask for an account.

![HarnessBot connects a roster, chat, a team map, and a computer](docs/images/features.jpg)

| Benefit | What you get |
| --- | --- |
| **Private** | Your chats, memory, and approvals stay on this computer. HarnessBot uses the agent CLIs you already signed in. |
| **Named** | Every bot has a persona, a model, and a memory you can read and correct. Switching engines does not merge them into one assistant. |
| **Hands** | A bot can use a desktop only after you place one and, for this computer, opt in. You can take the wheel back. |
| **Teams** | Rooms, @mentions, and a team map let bots ask each other or hand work off, with the exchange visible to you. |

![You, the harness, the agent, and the reply](docs/images/message-flow.jpg)

A turn is four steps:

1. **Message.** You write in that bot’s chat, or mention it in a room.
2. **Route.** The harness picks the bot’s engine, folder, and only the tools that bot is allowed to use.
3. **Model.** Claude, Grok, Hermes, or another connected CLI does the work.
4. **Stream.** The reply, tool activity, and any approval card come back into the same thread.

![Opt in, then a screenshot, then your approval](docs/images/computer-use.jpg)

Desktop use is a separate choice from chat:

1. **Opt in.** Pick This computer and confirm that this bot may use the real screen, keyboard, and mouse.
2. **Screenshot.** The bot looks first, then clicks, types, or opens a page with the desktop tools.
3. **You approve.** Actions on the real computer ask in the chat. Opening a site is not signing in: the bot stops at a login wall instead of typing a password or a one-time code.

![Private, named bots, hands, and teams](docs/images/benefits.jpg)

## What it actually does

- **Bots are contacts.** Pin, mark unread, duplicate, hide, file into sections. Each
  one has a persona, a model, a working folder, memory, and its own tool grants.
- **Tasks are clean slates.** A task is an independent conversation with its own
  transcript, provider session, resume cursor, usage, and pinned folder.
- **Approvals happen in chat.** Shell commands and file edits become cards with
  Allow / Deny / answer. "Always allow" is a narrow key (`Bash:git`), never a blanket
  grant, and grants for your real computer live in a separate memory from cloud ones.
  Every answer — including the ones nobody gave — is in the decision log under Settings.
- **Memory you can read and correct.** Structured entries per bot and per section, each
  showing its kind, source and confidence. Anything a bot inferred can be edited or
  deleted, and bots cannot write to a section's shared memory without your grant.
- **Rooms and teams.** Multi-bot rooms with `@mentions`, a bulletin, turn timeouts, a
  shared desk, org chart, Chief of Staff, and whole teams importable from one
  Markdown file.
- **Hands, on purpose.** Cloud desktop (Box or your own VPS), Local VM over
  Docker/Podman, this computer (opt-in), a built-in browser, connected apps over
  Composio, custom MCP servers, and physical Android over USB. Each placement states
  its own consequences, and expanded workspaces let you take over a VM desktop or a
  browser tab in the main column.
- **A team map you can actually draw on.** The reporting spine and the working graph
  are drawn differently on purpose: one manager per bot on the spine, plus dotted
  lines, peers, handoffs, and numbered workflow steps you create by dragging between
  cards. Pan, zoom, snap, tidy layout, and saved views. Double-click any bot to open
  its conversation in the side drawer without leaving the chart.
- **Automation.** Weekday or one-off routines that start a *fresh* task, plus webhooks
  that fire one from outside — created, rotated and revoked from Settings, on a
  receiver that runs on its own port.
- **Voice.** ElevenLabs TTS on the harness, per-bot voices, macOS dictation and calls.

## Where things live

| Path | What |
| --- | --- |
| `server/contracts.ts` | The architecture in one file: driver SPI + `RuntimeEvent` |
| `server/harness/` | Registry (configs → live instances or unavailable shadows) and the event bus |
| `server/drivers/` | One entry per provider; `builtIn.ts` is the table |
| `server/store.ts` | Persistence, and the single persistence → SSE joint |
| `server/index.ts` | The whole HTTP + SSE API, plain `node:http` |
| `src/` | React app. No transports of its own |
| `electron/` | Desktop shell, gated native capabilities |
| `scripts/mcp-server.mjs` | Bounded MCP control plane for Cursor / Claude Desktop |

Your data lives in `~/.harnessbot` (override with `HB_DATA_DIR`): `bots.json`,
`groups.json`, `config.json`, `messages.db` (SQLite WAL, owner-only), per-thread
NDJSON event logs, memory, skills, and attachments.

## Architecture in one paragraph

Two processes. The React app holds **no** agent transports: it sends typed HTTP
commands and folds **one** SSE stream into **one** reducer. The harness owns every
agent CLI, normalises each vendor's protocol into canonical `RuntimeEvent` objects,
persists through a store that emits a `StoreChange` on every write, and maps those
changes to SSE in exactly one place. That single joint is why "persisted but not
shown" and "shown but not persisted" cannot both exist.

## Safety model

The harness binds `127.0.0.1` and has **no authentication** — the trust boundary is
your OS user account. That is a deliberate design, and it is also why:

- Binding it off-machine is a vulnerability, not a feature. If you need internet
  delivery, tunnel **only** the webhook port.
- The webhook receiver runs on its own port and serves only `/health` and
  `/hooks/:secret`. It cannot reach `/api/bots`.
- Non-loopback `Host` headers are refused (DNS-rebinding defence).
- Secrets are write-only through the API. `GET /api/config` returns booleans.
- Everything a bot authored is scrubbed of content-shaped secrets before storage.
  What *you* type is stored exactly as you typed it.
- Ubuntu Wayland host control is disabled and legacy opt-ins are cleared. Preview is
  not permission, and Auto never reaches for your real desktop.
- Team packages never carry credentials, conversations, permissions, memory, or
  computer access. Imported members start with connections off and routines paused.

Found a vulnerability? See [SECURITY.md](SECURITY.md) — please don't open a public
issue.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev:all` | Harness + Vite together |
| `pnpm dev:server` / `pnpm dev` | Just one of them |
| `pnpm dev:desktop` | Electron against the running dev server |
| `pnpm typecheck` | App + server `tsc` |
| `pnpm test` | Vitest: unit, driver contract, API smoke |
| `pnpm verify` | typecheck + test + contrast + i18n + Electron syntax |
| `pnpm check:contrast` | WCAG AA check across every shipping skin |
| `pnpm build:server` | Bundle the harness for packaging |
| `pnpm mcp` | The stdio MCP server (the app must be running) |

## Platforms

macOS is the primary target. Windows works (the installer is not code-signed yet, so
SmartScreen will warn). Ubuntu 24.04 GNOME is beta: Xorg host control is opt-in and
overlay-free; Wayland host control is disabled.

Dictation and calls are macOS-only right now, and the UI does not pretend otherwise.

## License

Apache-2.0. See [LICENSE](LICENSE).
