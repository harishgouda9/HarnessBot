# Security

## Reporting

Please do **not** open a public issue for a vulnerability. Email
`security@harnessbot.invalid` with what you found and how to reproduce it. We will
confirm receipt and keep you updated.

## Trust model

**Trusted:** the logged-in OS user on this machine.

**Untrusted:** model output, team packages, MCP tool results, webhook callers, paired
phones, and anything on the LAN.

The harness binds `127.0.0.1` and has no authentication, because the OS account *is*
the boundary. Shared-machine isolation is an OS-account problem: another local admin
can read `~/.harnessbot`, and no application-level control changes that.

## High-value assets

Config secrets, transcripts, the OS seat (your keyboard and mouse), Composio OAuth
grants, and Box tokens.

## Controls

- **Loopback bind.** Nothing listens off-machine except the companion sidecar, which
  is off until you ask for it.
- **Host header check.** Non-loopback `Host` values are refused, so a public DNS name
  pointed at `127.0.0.1` cannot drive the API from a browser.
- **Permission broker.** No risky action runs without a recorded source
  (`user | auto | timeout | system | peer`). No answerer means `unavailable`, and
  `unavailable` means the action did not run.
- **Narrow grants.** "Always allow" binds to a server-issued key for a request that is
  actually pending. Clients cannot invent a wider one, and the companion cannot widen
  a server key.
- **Scope separation.** Grants for your real computer are stored separately from
  cloud and tool grants. One never authorises the other.
- **Write-only secrets.** Keys go in through `PATCH /api/config` and never come back
  out. API responses carry `configured: true` and nothing else. Packaged builds move
  plaintext keys into OS secure storage on boot.
- **Redaction.** Every bot-authored field is scrubbed of content-shaped secrets before
  it is written to disk. User-typed text is stored as typed.
- **No shell.** Every CLI launch uses an argv array. There is no `shell: true` and no
  command-string building anywhere in the harness — model output reaches these
  arguments.
- **Per-provider env.** An engine only ever receives its own credential.
- **Webhook isolation.** The receiver is a separate listener serving `/health` and
  `/hooks/:secret`. Secrets are stored hashed and shown exactly once.
- **Internal routes.** `/api/internal/*` requires a per-boot random bearer, minted per
  bot and dropped when the bot is deleted.
- **Wayland fail-closed.** Host automation never starts on Wayland, and legacy opt-ins
  are cleared rather than honoured.
- **Package review.** Team packages cannot carry credentials or grants; imports land
  with connections off, MCP off, and routines paused.

## In scope

These are vulnerabilities, and we want to hear about them:

- Binding the harness off-machine, or any path that causes it.
- Echoing a secret in an API response, SSE frame, log, or process argv.
- Bypassing the permission broker, or causing an action to run without a recorded
  decision source.
- Widening an approval grant beyond the key the server issued.
- `shell: true` or command-string construction on any spawn path.
- Reaching the harness API from the webhook port.
- Starting host automation on Wayland, or starting it without an explicit opt-in.
- A team package that applies a credential, a grant, or an enabled connection.

## Out of scope

- Another admin on the same machine reading `~/.harnessbot`. Use separate OS accounts.
- Provider CLI vulnerabilities — report those to the vendor.
- The Windows installer being unsigned. It is a known gap, tracked publicly.
