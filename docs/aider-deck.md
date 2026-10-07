# Aider Deck — realtime session surface

Status: spec for implementation. The UI is a live view of a process this harness spawned. It is not a screenshot, not Aider's Streamlit `--gui` (absent on the installed 0.16.0), and not a tail of a terminal we did not start.

## Problem

When a bot (or the operator) works through Aider, the chat transcript is the wrong surface. Aider's work is a long-lived process: prompts, diffs, file adds, and questions. The operator must see that stream as it happens and must be able to edit the files in that session's folder without leaving the deck. Edits have to land on disk and be announced back to the same Aider process.

## Why the harness owns the process

| Approach | Rejected because |
| --- | --- |
| `aider --gui` / `--browser` | Not in Aider 0.16.0. Later Streamlit GUI is a second view of one process, localhost-only, and still not an editor. |
| Attach to an already-running Aider PTY | Windows has no safe attach. A bot that shells out to Aider in some other terminal stays invisible. |
| HTML mock of a terminal | Not a session. Closing the page would not be the process. |

The door is the Aider engine. A bot whose driver is `aider` gets a deck session for that thread's `cwd`. The Workspace → Aider page lists those sessions. The operator can also start one on a folder. Anything spawned outside this supervisor is out of scope and must be said so in the UI.

## Architecture

```
operator / bot turn
        │
        ▼
Aider driver (server/drivers/aider.ts)
        │  one session per threadId
        ▼
AiderDeck supervisor (server/aider/deck.ts)
        │  spawn, no shell, stdin stays open
        ▼
aider process  ──stdout lines──►  ring buffer
        ▲                              │
        │ stdin (prompt, /add, /exit)  │ SSE
        │                              ▼
file editor ──PUT, path contained──► disk
                                      │
                                      ▼
                              HarnessBot view `aider`
                              sessions | stream | editor
```

Chat still receives canonical `RuntimeEvent`s. The deck is the richer surface: raw lines, the file tree, and the editor. The two must not invent a second persistence path for chat messages.

## Process rules

- Spawn through `spawnCli` / `node:child_process` argv arrays. Never `shell: true`. Never a concatenated command string.
- Default command: `findCli('aider')`. Tests and the UI may pass an explicit `command` + `args` (a Node fake). Do not read `~/.grok/auth.json`. Do not put API keys on argv. Inherit the process env; do not log it.
- Flags when the binary is real Aider: `--no-auto-commits`, `--no-gitignore`, `--watch-files`, `--dark-mode`, `--yes-always` is forbidden (it would apply edits without a person). Do not pass `--no-check-update` (Aider 0.16.0 exits 2 on that flag).
- One session per `threadId`. A second start for the same id returns the existing session.
- Cap live sessions at 8. Cap retained output at 400 events / 256 KiB.
- On stop: write `/exit\n` if stdin is open, then `killTree` after 2s if it has not exited.
- Session cwd must already exist, must be absolute after resolve, and must be a directory.

## Events

Each event is `{ id, at, type, ... }`.

| type | fields | meaning |
| --- | --- | --- |
| `status` | `status: starting \| ready \| busy \| idle \| exited`, `code?` | process lifecycle |
| `output` | `text` | one ANSI-stripped stdout/stderr chunk |
| `input` | `text` | a line the deck wrote to stdin (operator or bot) |
| `file` | `path`, `op: write` | the editor saved a file inside cwd |

`ready` is emitted on the first stdout chunk or after the spawn callback, whichever comes first. `busy` while a line was sent and no new output has arrived for the trailing quiet window is optional; do not block the UI on it. `exited` carries the exit code.

Strip ANSI (`ESC [ ... ]` and `ESC ] ... BEL`) before storing `output.text`.

## HTTP (loopback harness only)

All paths stay on the existing server. No new port. No auth beyond the existing loopback Host check.

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/api/aider/status` | | `{ available, bin, reason? }` |
| GET | `/api/aider/sessions` | | `{ sessions: Session[] }` |
| POST | `/api/aider/sessions` | `{ cwd, threadId?, botId?, command?, args? }` | session |
| DELETE | `/api/aider/sessions/:id` | | `{ stopped: true }` |
| GET | `/api/aider/sessions/:id/events` | | SSE, replay then live, `event: aider` |
| POST | `/api/aider/sessions/:id/input` | `{ text }` | `{ ok: true }` — appends a newline if missing |
| GET | `/api/aider/sessions/:id/tree` | | `{ entries: { path, kind: file\|dir }[] }` |
| GET | `/api/aider/sessions/:id/file` | `?path=` | `{ path, content, mtimeMs }` |
| PUT | `/api/aider/sessions/:id/file` | `{ path, content, expectedMtimeMs? }` | `{ path, mtimeMs }` then `/add` that relative path |

Errors are `{ error }` with 400 or 404. A path that escapes the session cwd is 400, not a write. A missing session is 404. A file over 1 MiB is 400. `expectedMtimeMs` mismatch is 409 `{ error, mtimeMs }` and must not write.

Tree walk: skip `.git`, `node_modules`, `dist`, depth 4, max 200 entries. Relative POSIX-style paths in the JSON (`src/App.tsx`), never absolute.

SSE shape matches `/api/events`: `content-type: text/event-stream`, replay buffered events, ping every 15s, drop the client on close.

## File edit contract

The editor is how the operator changes a file "inside" Aider:

1. Load the file with its `mtimeMs`.
2. PUT the new content with `expectedMtimeMs`.
3. The supervisor writes the file (utf-8) only if the path is contained and the mtime matches or was omitted.
4. It then writes `/add <relative>\n` to that session's stdin so Aider's chat context includes the edit.
5. It emits a `file` event.

Do not commit. Do not format the file. Do not touch files outside the session cwd.

## Driver

`server/drivers/aider.ts` exports a `ProviderDriver` registered from `registerBuiltInDrivers`.

- kind `aider`, display name `Aider`, bin `aider`
- capabilities: `steer: true` only. No MCP hands, no images. Honest: this driver cannot mount computer use.
- models: one entry `default` / `Aider default`
- `snapshot`: available when `findCli('aider')` hits, else unavailable `missing_cli`
- `sendTurn`: ensure a session for `input.threadId` at `input.cwd` (fallback `process.cwd()`), write `input.text` to stdin, emit `turn.started`, emit `content.delta` / `item.completed` from output lines, emit `turn.completed` when the process goes idle is **not** required — Aider does not end a turn. Emit `turn.started` and stream output as `content.delta`. Emit `turn.completed` only when the process exits during the turn or the abort signal fires.
- `interrupt`: write a blank line is not enough. Call the session stop only on `dispose` / thread drop. `interrupt` writes `\x03` if the process is alive, else no-ops.
- `answerRequest`: no-op resolve. Aider questions are answered by the deck input box, not the approval card.
- AbortSignal on the turn must not kill the session. The session outlives one message.

## UI

New view id `aider`.

- `src/store.tsx` view union gains `'aider'`
- `src/App.tsx` `openView` union and `centre` switch: render `<AiderDeck />`
- `src/components/Sidebar.tsx` `onOpenView` union and a workspace item `{ label: 'Aider', icon: 'file', view: 'aider' }`
- `src/components/AiderDeck.tsx`

Layout, flush to the existing app (CSS variables already in the app, not a new theme):

- Left: sessions (bot id, cwd basename, status). Start form: folder path. Stop button.
- Centre: live output, monospace, auto-scroll unless the user scrolled up. Prompt box posts to `/input`.
- Right: file tree. Click loads the editor. Save is the PUT above. Show 409 as "file changed on disk" and do not overwrite.

Poll `GET /api/aider/sessions` every 2s. One `EventSource` on the selected session's `/events`, closed on change or unmount. Use `api` / `apiUrl` / `authHeaders` from `src/api.ts`. No second transport.

Copy in the empty state, one sentence: sessions appear when a bot uses the Aider engine, or when you start one here. Aider started in another terminal is not shown.

## Tests

`server/aider/deck.test.ts` uses a Node fake, not the real model.

Fake behaviour (inline `node -e` or a temp script):

- print `READY\n` on start
- echo each stdin line as `ECHO <line>\n`
- exit on a line `EXIT`

Assert:

- start returns a session and a later event poll or the in-memory buffer contains `READY`
- `writeInput` is echoed
- `writeFile` inside cwd round-trips; `../escape` throws or returns an error and does not create a file outside cwd
- mtime mismatch does not write
- stop emits `exited`

Export the supervisor functions so the test does not need HTTP. Add a thin route test only if the existing `server/index.test.ts` pattern makes it cheap; do not boot the whole server if that file's setup is heavy. Prefer unit tests on `deck.ts`.

## Out of scope

- Upgrading Aider
- Git commits from the deck
- Attaching to foreign processes
- Monaco or a new dependency
- Drive-by refactors, formatting, or i18n keys (workspace labels in the sidebar are already hardcoded English)
