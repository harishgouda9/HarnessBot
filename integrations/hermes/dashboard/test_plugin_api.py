"""Self-check for the dashboard router. Runs the real harness behind it.

    <hermes venv python> test_plugin_api.py

Needs a built HarnessBot (``dist-server`` + the plugin UI build) — point
HARNESSBOT_APP_DIR at a working tree, or install one.

Deliberately runs the router under a real uvicorn rather than Starlette's
TestClient: the load-bearing behaviour here is a never-ending SSE stream, and a
test transport that buffers a response is exactly the thing that would pass while
the real dashboard hangs.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

os.environ.setdefault("HARNESSBOT_PORT", "18799")
os.environ.setdefault("HARNESSBOT_DATA_DIR", str(Path(tempfile.gettempdir()) / "harnessbot-router-test"))

DASHBOARD_PORT = int(os.environ.get("HARNESSBOT_TEST_DASHBOARD_PORT", "18811"))
MOUNT = "/api/plugins/harnessbot"
BASE = f"http://127.0.0.1:{DASHBOARD_PORT}{MOUNT}"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin_api = _load("harnessbot_plugin_api", HERE / "plugin_api.py")
supervisor = plugin_api.supervisor


def main() -> int:
    import httpx
    import uvicorn
    from fastapi import FastAPI

    print(f"app_dir : {supervisor.app_dir()}")
    print(f"port    : {supervisor.port()}")

    if not supervisor.server_entry().exists():
        print(f"SKIP: no harness build at {supervisor.server_entry()}")
        return 1
    if not supervisor.ui_dir().is_dir():
        print(f"SKIP: no UI build at {supervisor.ui_dir()}")
        print("      HB_BASE=dashboard-plugins/harnessbot/ui HB_API_BASE=api/plugins/harnessbot/hb npx vite build --outDir integrations/hermes/dashboard/ui")
        return 1

    app = FastAPI()
    app.include_router(plugin_api.router, prefix=MOUNT)

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=DASHBOARD_PORT, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 20
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "the test dashboard did not start"

    started_here = not supervisor.is_running()
    try:
        with httpx.Client(timeout=30.0) as client:
            # --- status ------------------------------------------------------
            res = client.get(f"{BASE}/status")
            assert res.status_code == 200, res.text
            assert res.json()["installed"] is True
            print("status  : ok")

            # --- the built UI ------------------------------------------------
            # Served by Hermes' plugin-asset route in the real dashboard, so here
            # we only check the build itself carries the two bases it needs.
            index = (supervisor.ui_dir() / "index.html").read_text(encoding="utf-8")
            assert "/dashboard-plugins/harnessbot/ui/assets/" in index, "UI was not built with HB_BASE"
            bundle = next(supervisor.ui_dir().glob("assets/index-*.js")).read_text(encoding="utf-8")
            # Baked slash-free by the Vite define; normalizeBase() adds the slash at runtime.
            assert '"api/plugins/harnessbot/hb"' in bundle, "UI was not built with HB_API_BASE"
            print("ui      : ok (static base and API base both baked in)")

            # --- the proxy ---------------------------------------------------
            # THE load-bearing assertion. The request carries `Host: 127.0.0.1:18811`
            # (the dashboard's port); the harness refuses any Host that is not its
            # own loopback address with 403. A 200 means the router rewrote it.
            res = client.get(f"{BASE}/hb/api/health")
            assert res.status_code == 200, f"proxy failed ({res.status_code}): {res.text}"
            assert res.json()["app"] == "harnessbot", res.text
            print("proxy   : ok (Host rewritten; harness answered)")

            res = client.get(f"{BASE}/hb/api/bots")
            assert res.status_code == 200, res.text
            print(f"bots    : ok ({len(res.json())} bot(s))")

            # A POST, because the UI writes as well as reads.
            res = client.post(f"{BASE}/hb/api/bots", json={"name": "ProxyProbe"})
            assert res.status_code in (200, 201), f"POST proxy failed: {res.status_code} {res.text}"
            bot_id = res.json().get("id")
            print(f"post    : ok (created {bot_id})")

            # --- SSE ---------------------------------------------------------
            # The whole UI folds one SSE stream; if it buffers here, the app is dead.
            with client.stream("GET", f"{BASE}/hb/api/events", timeout=20.0) as stream:
                assert stream.status_code == 200, stream.status_code
                assert "text/event-stream" in stream.headers["content-type"]
                buffered = ""
                for chunk in stream.iter_text():
                    buffered += chunk
                    if "\n\n" in buffered:
                        break
                assert "event: hello" in buffered, f"unexpected first frame: {buffered[:200]!r}"
            print("sse     : ok (hello frame arrived without buffering)")

            if bot_id:
                client.request("DELETE", f"{BASE}/hb/api/bots/{bot_id}")

    finally:
        server.should_exit = True
        thread.join(timeout=10)
        if started_here:
            supervisor.stop()

    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
