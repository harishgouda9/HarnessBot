"""Start, health-check and stop the HarnessBot harness next to Hermes.

The harness is a plain Node process with zero runtime dependencies, so supervising
it is spawn + poll + terminate. This is the same job ``electron/main.mjs`` does for
the desktop app; the only difference is which shell owns the process.

Two rules the rest of the plugin depends on:

* The harness binds ``127.0.0.1`` and has **no** authentication of its own. Its port
  is never published. Everything reaches it through the dashboard's authenticated
  plugin router, which is the only reason this is safe to run on a VPS.
* ``/api/health`` must answer ``{"app": "harnessbot"}`` before we claim a port is
  ours. Something else on 8799 is a foreign service, not a harness to adopt.

Standard library only, so it can be tested without Hermes installed:
``python supervisor.py --demo``.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_PORT = 8799
HEALTH_TIMEOUT_SECONDS = 30.0
STOP_TIMEOUT_SECONDS = 10.0


# --------------------------------------------------------------------------
# Locations
# --------------------------------------------------------------------------

def hermes_home() -> Path:
    """Hermes' data root — the writable volume in the Docker image."""
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore

        return Path(os.environ.get("HERMES_HOME") or get_default_hermes_root())
    except Exception:
        env = os.environ.get("HERMES_HOME")
        if env:
            return Path(env)
        if sys.platform == "win32":
            local = os.environ.get("LOCALAPPDATA")
            if local:
                return Path(local) / "hermes"
        return Path.home() / ".hermes"


def app_dir() -> Path:
    """The staged harness bundle. Inside the plugin, so the whole thing is one
    directory to symlink and there is nothing to configure after installing."""
    return Path(os.environ.get("HARNESSBOT_APP_DIR") or Path(__file__).resolve().parent / "harness")


def data_dir() -> Path:
    """HarnessBot's own state. Profile-scoped, because Hermes profiles are isolated
    and two profiles sharing one bots.json would be a surprise, not a feature."""
    override = os.environ.get("HARNESSBOT_DATA_DIR")
    if override:
        return Path(override)
    return hermes_home() / "harnessbot-data"


def server_entry() -> Path:
    return app_dir() / "server" / "index.js"


def ui_dir() -> Path:
    """Dashboard-prefixed UI, served by Hermes' plugin-asset route.

    That route is the only one a plain ``<iframe src>`` can load on a loopback
    bind of the *dashboard*, where every ``/api/`` path demands a header the
    browser will not send for a navigation. The desktop app does not have that
    route, so it uses ``static_dir()`` instead.
    """
    return Path(__file__).resolve().parent / "dashboard" / "ui"


def static_dir() -> Path:
    """Standalone UI, served by the harness itself at ``http://127.0.0.1:<port>/``.

    Same origin as the API, so the full product works inside Hermes Desktop
    without the dashboard asset prefix.
    """
    return app_dir() / "ui"


def state_file() -> Path:
    return data_dir() / "supervisor.json"


def port() -> int:
    try:
        return int(os.environ.get("HARNESSBOT_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def base_url() -> str:
    return f"http://127.0.0.1:{port()}"


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------

def health() -> Optional[Dict[str, Any]]:
    """``/api/health`` if a HarnessBot harness is answering, else None.

    Confirms the ``app`` field rather than trusting the port: adopting whatever
    happens to be listening is how a plugin ends up proxying a stranger.
    """
    try:
        with urllib.request.urlopen(f"{base_url()}/api/health", timeout=2) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) and payload.get("app") == "harnessbot" else None


def is_running() -> bool:
    return health() is not None


# --------------------------------------------------------------------------
# Lifecycle
# --------------------------------------------------------------------------

def _preflight() -> Optional[str]:
    """Why we cannot start, in words a user can act on."""
    if not shutil.which("node"):
        return "node is not on PATH. HarnessBot's harness needs Node 22 or newer."
    if not server_entry().exists():
        return (
            f"the harness is not built at {app_dir()}. "
            "Run `node scripts/build-hermes-plugin.mjs` in the HarnessBot checkout."
        )
    return None


def _live_pid() -> Optional[int]:
    """The Node process actually answering /api/health, if any."""
    found = health()
    if not isinstance(found, dict) or not found.get("pid"):
        return None
    try:
        return int(found["pid"])
    except (TypeError, ValueError):
        return None


def _terminate(pid: int, timeout: float = STOP_TIMEOUT_SECONDS) -> Dict[str, Any]:
    """Kill a harness pid (and its children) and wait until /api/health goes quiet."""
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False, capture_output=True,
            )
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (OSError, ProcessLookupError):
                os.kill(pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not is_running():
            state_file().unlink(missing_ok=True)
            return {"ok": True, "stopped": True, "pid": pid}
        time.sleep(0.25)

    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False, capture_output=True,
            )
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                os.kill(pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass

    # Windows TIME_WAIT can make a just-killed listener look alive for a beat.
    settle = time.monotonic() + 2.0
    while time.monotonic() < settle:
        if not is_running():
            break
        time.sleep(0.25)

    state_file().unlink(missing_ok=True)
    return {"ok": not is_running(), "stopped": True, "pid": pid, "forced": True}


def start(wait: float = HEALTH_TIMEOUT_SECONDS) -> Dict[str, Any]:
    """Start the harness, or adopt one already answering on the port.

    An API-only process (``health.static`` false) is not adopted when we have a
    UI to serve — that is the ``{"error":"not found"}`` at GET / the desktop
    plugin used to hit. Replace it so the full product is what answers.
    """
    existing = health()
    if existing:
        want_ui = (static_dir() / "index.html").is_file()
        if existing.get("static") or not want_ui:
            return {"ok": True, "adopted": True, "url": base_url(), "health": existing}
        live = _live_pid()
        if live is not None:
            _terminate(live)
            if is_running():
                return {
                    "ok": False,
                    "error": f"could not replace the API-only harness (pid {live}). Stop it, then retry.",
                }

    problem = _preflight()
    if problem:
        return {"ok": False, "error": problem}

    data_dir().mkdir(parents=True, exist_ok=True)
    log_path = data_dir() / "harness.log"

    env = {
        **os.environ,
        "HB_PORT": str(port()),
        "HB_DATA_DIR": str(data_dir()),
        # Desktop (and a local browser pane) load the full product from the
        # harness origin. The dashboard tab keeps using ui_dir() with its own
        # mount prefix; this path is the same-origin build.
        "HB_STATIC_DIR": str(static_dir()),
    }

    # A new process group so stopping the harness also stops the agent CLIs it
    # spawned. An orphaned `claude` holding a model session is the failure mode.
    kwargs: Dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    with open(log_path, "ab") as log:
        proc = subprocess.Popen(
            [shutil.which("node") or "node", str(server_entry())],
            cwd=str(app_dir()),
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            **kwargs,
        )

    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return {
                "ok": False,
                "error": f"the harness exited with code {proc.returncode}. See {log_path}.",
            }
        found = health()
        if found:
            state_file().write_text(json.dumps({"pid": proc.pid, "port": port()}), encoding="utf-8")
            return {"ok": True, "adopted": False, "pid": proc.pid, "url": base_url(), "health": found}
        time.sleep(0.25)

    proc.terminate()
    return {"ok": False, "error": f"the harness did not answer within {wait:.0f}s. See {log_path}."}


def _recorded_pid() -> Optional[int]:
    try:
        pid = json.loads(state_file().read_text(encoding="utf-8")).get("pid")
        return int(pid) if pid else None
    except (OSError, ValueError, json.JSONDecodeError, AttributeError):
        return None


def stop(timeout: float = STOP_TIMEOUT_SECONDS) -> Dict[str, Any]:
    """Stop the harness we started. A harness we merely adopted is left alone."""
    pid = _recorded_pid()
    if pid is None:
        return {"ok": True, "stopped": False, "reason": "no harness was started by this plugin"}
    return _terminate(pid, timeout=timeout)


def restart(wait: float = HEALTH_TIMEOUT_SECONDS) -> Dict[str, Any]:
    """Kill whatever is answering on the port, then start with current env.

    Must kill the live pid, not only the one we recorded: an adopted API-only
    process has no recorded pid, and stop() would no-op then start() would
    adopt it again.
    """
    live = _live_pid() or _recorded_pid()
    if live is not None:
        _terminate(live)
    return start(wait=wait)


def status() -> Dict[str, Any]:
    found = health()
    return {
        "running": found is not None,
        "url": base_url() if found else None,
        "pid": _recorded_pid(),
        "app_dir": str(app_dir()),
        "data_dir": str(data_dir()),
        "installed": server_entry().exists(),
        "ui_built": (ui_dir() / "index.html").is_file(),
        "static_ui_built": (static_dir() / "index.html").is_file(),
        "node": shutil.which("node"),
        "health": found,
    }


# --------------------------------------------------------------------------
# Self-check
# --------------------------------------------------------------------------

def _demo() -> int:
    """Start the real harness, prove it answers, stop it, prove it stopped."""
    print(f"app_dir  : {app_dir()}")
    print(f"data_dir : {data_dir()}")

    problem = _preflight()
    if problem:
        print(f"PREFLIGHT FAILED: {problem}")
        return 1

    assert not is_running(), f"something is already on {base_url()}; stop it before the demo"

    started = start()
    assert started["ok"], f"start failed: {started.get('error')}"
    print(f"started  : pid={started.get('pid')} url={started['url']}")

    assert is_running(), "harness reported started but /api/health does not answer"
    assert status()["running"] is True

    stopped = stop()
    assert stopped["ok"], f"stop failed: {stopped}"
    assert not is_running(), "harness still answering after stop"
    print("stopped  : clean")

    print("OK")
    return 0


if __name__ == "__main__":
    if "--demo" in sys.argv:
        raise SystemExit(_demo())
    print(json.dumps(status(), indent=2))
