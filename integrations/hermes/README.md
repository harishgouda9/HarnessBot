# HarnessBot inside Hermes

Runs HarnessBot as a [Hermes Agent](https://hermes-agent.nousresearch.com) plugin:
the **full product** (roster, rooms, skills, computer, settings) as a `/harnessbot`
page in Hermes Desktop — the same contribution model as Kanban — plus a dashboard
tab and `hermes harnessbot` on the command line. The harness runs on the machine
Hermes runs on, so on a VPS it uses that VPS.

## Install

From a HarnessBot checkout, on the machine Hermes is installed on:

```bash
npm install
node scripts/build-hermes-plugin.mjs          # stages the harness and the UI
ln -s "$(pwd)/integrations/hermes" ~/.hermes/plugins/harnessbot
hermes plugins enable harnessbot
```

On Windows use a junction instead of a symlink:

```powershell
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\hermes\plugins\harnessbot" `
         -Target "<checkout>\integrations\hermes"
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\hermes\desktop-plugins"
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\hermes\desktop-plugins\harnessbot" `
         -Target "<checkout>\integrations\hermes\desktop"
```

Or from the checkout: `node scripts/install-hermes-plugin.mjs`.

Then enable it in both places:

* **CLI / dashboard:** `hermes plugins enable harnessbot`, then restart the
  dashboard (`hermes dashboard`) and open the **HarnessBot** tab.
* **Desktop:** the plugin adds a **HarnessBot** row in the left sidebar
  (same slot as Kanban) and a **HarnessBot** tab next to SESSIONS | BOTS.
  Command palette → **Reload desktop plugins**. If the row is missing,
  Capabilities → Plugins → HarnessBot (unified copies ship off until you
  flip that switch). The harness starts the first time the page asks for
  anything; an older API-only process is restarted so it serves the UI at
  `http://127.0.0.1:8799/`.

The desktop app picks up the same package from `desktop/plugin.js`. The
`/harnessbot` page is the full HarnessBot product, served by the harness (same
origin as its API). It is not a second, thinner UI drawn with Hermes components.

Requires Node 22+ on PATH. The official Hermes Docker image already ships Node.

## How it fits together

```
Hermes Desktop ──► /harnessbot page ──► http://127.0.0.1:8799/     full UI + /api
Hermes dashboard ─┬─► /dashboard-plugins/harnessbot/ui/…           UI (static)
                  └─► /api/plugins/harnessbot/hb/…     proxy ──► harness
                                                                  127.0.0.1:8799
```

Two routes, because Hermes treats them differently, and the split is the whole design:

* **`/dashboard-plugins/…`** is Hermes' plugin-asset route. It is unauthenticated by
  design — no `<iframe src>` or `<script src>` can attach an auth header — and only
  serves browser-asset suffixes. The UI's HTML, JS and CSS come from here.
* **`/api/plugins/harnessbot/hb/…`** is the plugin's own router, behind the
  dashboard's auth gate. Everything the UI *does* goes through here.

The harness itself has **no authentication** and binds `127.0.0.1` only; its port is
never published. Hermes' gate is what makes it safe to run where other people can
reach the machine. Two details make the hop work: the proxy rewrites `Host` to
`127.0.0.1` (the harness refuses non-loopback `Host` headers as a DNS-rebinding
defence), and it streams rather than buffers, so the SSE feed the UI folds arrives
live.

## Running it on a VPS

Hermes fails closed: it refuses a non-loopback bind with no auth provider. Pick one.

* **SSH tunnel (simplest, nothing exposed).** Leave the dashboard on loopback and
  `ssh -L 9119:localhost:9119 user@vps`. In this mode the dashboard authenticates
  with a header, which the UI reads from the parent frame — that is why HarnessBot
  reads its event stream with `fetch` instead of `EventSource`, which cannot send one.
* **Reverse proxy.** Set `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD` (or
  Nous OAuth / OIDC) before binding to a reachable interface. Cookie auth then covers
  the tab, its assets and the stream with nothing extra.

Never publish the harness port itself. Nothing needs it but the plugin.

## What HarnessBot inherits from Hermes

Hermes usually arrives with a toolbox already configured, and the plugin exports it
rather than asking you to set it up twice.

| From Hermes | In HarnessBot | Arrives |
| --- | --- | --- |
| `mcp_servers` in `config.yaml` | Settings → MCP servers, named `hermes/<name>` | switched **off** |
| `<hermes home>/skills` | the skill library on every bot | installable, digest-confirmed |
| what a Hermes *plugin* contributes | via the two rows above | as above |

Definitions are refreshed from Hermes on every harness start; the on/off switch is
HarnessBot's and survives. A server Hermes drops disappears here too. Hermes plugins
themselves are Python running inside Hermes, so HarnessBot cannot load one directly —
what a plugin *contributes* travels through those two channels instead.

`GET /api/hermes` reports what was found, and says `connected: false` when running
standalone rather than pretending.

## Computer use

HarnessBot's own computer backends — a cloud desktop, a Local VM, this computer —
assume a machine with a screen, and a headless VPS has none of them. The supported
path there is the one Hermes already has: give Hermes a browser driver over MCP, and
it arrives as a tool a bot can hold.

```bash
npm install -g @modelcontextprotocol/server-playwright
npx playwright install chromium --with-deps
hermes mcp add     # register it in Hermes
```

Restart the harness (`hermes harnessbot restart`), then switch `hermes/playwright`
on in Settings → MCP servers and grant it to the bots that should have it. A bot's
computer placement will still say it has no HarnessBot backend — it names the screen
driver it *does* have rather than reporting no hands at all.

## Teaching a skill

The recorder (Settings → Experimental) turns a demonstration into a staged skill.
Finishing a recording now lifts the literals it captured into placeholders: a value
that appears in several steps becomes one `{{placeholder}}` everywhere, and
addresses, links, dates and anything you put in quotes are recognised by shape. The
skill gets a `## Parameters` block listing each one with the value it was recorded
from, so the next run is against a different customer rather than the same one.

Naming stays yours — the generated names are typed (`{{email}}`, `{{value_2}}`)
because guessing that `"Acme Corp"` means `{{client_name}}` is the kind of guess that
demos well and misfires in practice. Rename them in the staged skill before
confirming; nothing installs until you do.

## Token usage

The status bar carries a meter showing every token the roster has spent, with a
per-bot breakdown behind it. It is folded from the usage the harness already banks on
each completed turn, so it cannot disagree with the per-task figure on a bot's panel.
Cached input is counted: the model read it and the provider billed it.

The system prompt is rebuilt for every turn and most drivers send it every time, so
the sections that could grow without limit are capped — a bot's description, its
playbooks, a room bulletin, and the skill list (which a 62-skill host library made a
live concern). Memory is rendered last so a provider's prompt cache keeps hitting the
stable prefix above it.

## Configuration

`hermes config` → `plugins.entries.harnessbot.settings`, or the environment, which
wins:

| Setting | Environment | Default |
| --- | --- | --- |
| `port` | `HARNESSBOT_PORT` | `8799` (loopback only) |
| `app_dir` | `HARNESSBOT_APP_DIR` | `<plugin>/harness` |
| `data_dir` | `HARNESSBOT_DATA_DIR` | `<hermes home>/harnessbot-data` |

Bots, transcripts and memory live in `data_dir` — outside the plugin, so reinstalling
or rebuilding never touches them. Give each Hermes profile its own `data_dir` if you
want profiles isolated; HarnessBot has no user model of its own, so anyone who can
open the dashboard can drive every bot.

## Commands

```
hermes harnessbot status      # where it is, whether it is up
hermes harnessbot start|stop|restart
/harnessbot                   # the same, from inside a Hermes session
```

## What does not work headless

HarnessBot's Electron shell, macOS dictation and calls, "this computer" control, USB
Android and the embedded browser all assume a desktop. On a VPS they are unavailable;
everything else — bots, tasks, rooms, approvals, memory, routines, MCP servers — works.

Agent CLIs (`claude`, `codex`, `grok`, …) must be installed and logged in on the VPS
for the bots that use them.

## Tests

```bash
npx vitest run                                              # the UI transport seam
python integrations/hermes/supervisor.py --demo             # start/health/stop
<hermes venv python> integrations/hermes/dashboard/test_plugin_api.py
```

The last one runs the router under a real uvicorn with a real harness behind it, and
checks the two things most likely to break silently: the `Host` rewrite, and that the
event stream is not buffered.
