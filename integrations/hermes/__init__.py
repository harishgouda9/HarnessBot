"""HarnessBot as a Hermes plugin.

Hermes already owns a machine, an authenticated dashboard, a desktop app and a
plugin system. HarnessBot already owns a harness that speaks HTTP and serves its
own UI. This plugin is the joint: it supervises the harness as a local process
and lets Hermes put the full product behind its auth gate (dashboard) or on a
``/harnessbot`` page (desktop).

What lives where:

* ``supervisor.py``     — start/health/stop the Node harness (no Hermes imports,
                          so it can be tested standalone)
* ``bridge.py``         — exports Hermes' MCP servers and skills to HarnessBot
* ``dashboard/``        — the tab: a FastAPI router and a small JS bundle
* ``desktop/plugin.js`` — native Desktop contributions (sidebar, page, status)
* this file             — ``hermes harnessbot ...`` and ``/harnessbot``

The dashboard and the desktop page own the harness lifecycle (they start on
first request), so nothing is auto-started here. A CLI- or gateway-only user
starts it with ``hermes harnessbot start``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os

from . import bridge, supervisor

logger = logging.getLogger(__name__)


def _apply_config(ctx) -> None:
    """Config into the environment the supervisor reads.

    ``setdefault`` on purpose: a real environment variable is a deliberate
    override (a dev pointing at a working tree) and outranks stored config.
    """
    for key, env_name in (("port", "HARNESSBOT_PORT"), ("app_dir", "HARNESSBOT_APP_DIR"), ("data_dir", "HARNESSBOT_DATA_DIR")):
        value = ctx.get_config(key, None)
        if value not in (None, ""):
            os.environ.setdefault(env_name, str(value))


# ---------------------------------------------------------------------------
# hermes harnessbot ...
# ---------------------------------------------------------------------------

_SUBCOMMANDS = (
    ("status", "Show whether the harness is running, and where"),
    ("start", "Start the harness on its loopback port"),
    ("stop", "Stop the harness this plugin started"),
    ("restart", "Stop then start"),
)


def _setup_cli(subparser: argparse.ArgumentParser) -> None:
    subs = subparser.add_subparsers(dest="harnessbot_command")
    for name, help_text in _SUBCOMMANDS:
        subs.add_parser(name, help=help_text)


def _print(payload: dict) -> None:
    print(json.dumps(payload, indent=2))


def _cli(args: argparse.Namespace) -> int:
    action = getattr(args, "harnessbot_command", None) or "status"

    if action == "status":
        state = supervisor.status()
        _print(state)
        return 0 if state["running"] else 1

    if action == "start":
        bridge.refresh(supervisor.data_dir())
        result = supervisor.start()
        _print(result)
        return 0 if result["ok"] else 1

    if action == "stop":
        result = supervisor.stop()
        _print(result)
        return 0 if result["ok"] else 1

    if action == "restart":
        supervisor.stop()
        bridge.refresh(supervisor.data_dir())
        result = supervisor.start()
        _print(result)
        return 0 if result["ok"] else 1

    print(f"unknown subcommand: {action}")
    return 2


# ---------------------------------------------------------------------------
# /harnessbot
# ---------------------------------------------------------------------------

def _slash(raw_args: str) -> str:
    state = supervisor.status()
    if state["running"]:
        return f"HarnessBot is running on {state['url']} (pid {state['pid'] or 'adopted'})."
    if not state["installed"]:
        return f"HarnessBot is not built at {state['app_dir']}. Run `node scripts/build-hermes-plugin.mjs`."
    return "HarnessBot is built but not running. Run `hermes harnessbot start`."


# ---------------------------------------------------------------------------

def register(ctx) -> None:
    _apply_config(ctx)

    ctx.register_cli_command(
        name="harnessbot",
        help="Run HarnessBot alongside Hermes (start, stop, status)",
        setup_fn=_setup_cli,
        handler_fn=_cli,
        description=(
            "HarnessBot is a roster of agent contacts with their own models, memory and "
            "tools. This manages the local harness the dashboard tab talks to."
        ),
    )

    ctx.register_command("harnessbot", _slash, description="Where HarnessBot is running")

    # Leaving a harness behind after the plugin is unloaded would keep a port and
    # whatever agent CLIs it spawned alive with nothing owning them.
    ctx.on_unload(lambda: supervisor.stop())
