"""Dashboard routes for HarnessBot: proxy its API behind the dashboard auth gate.

Mounted by the Hermes dashboard at ``/api/plugins/harnessbot/``. One job: proxy
``/hb/...`` to the HarnessBot harness on loopback.

The UI itself is *not* served here. Hermes gates every ``/api/`` route, and on a
loopback bind that gate wants a header no ``<iframe src>`` or ``<script src>`` can
send — so the UI is served from the dashboard's own unauthenticated plugin-asset
route (``/dashboard-plugins/harnessbot/ui/``), which exists for exactly that reason
and allows only browser-asset suffixes. The API keeps the gate.

**This file adds no authentication and must never add a bypass.** That gate is the
entire reason the harness, which has no auth of its own, can be run on a VPS. The
harness stays bound to 127.0.0.1 and its port is never published.

The dashboard imports this file with ``spec_from_file_location`` and no package, so
relative imports are unavailable; the sibling supervisor is loaded by path below.
"""

from __future__ import annotations

import asyncio
import os
import importlib.util
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

_PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _load_sibling(name: str):
    """Import a module from the plugin directory by path.

    The dashboard imports this file with no package, so `from . import x` is not
    available here even though it is in `__init__.py`.
    """
    spec = importlib.util.spec_from_file_location(f"harnessbot_{name}", _PLUGIN_DIR / f"{name}.py")
    if spec is None or spec.loader is None:  # pragma: no cover - packaging error
        raise ImportError(f"cannot load harnessbot {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


supervisor = _load_sibling("supervisor")
bridge = _load_sibling("bridge")

router = APIRouter()

# Headers that describe one hop and must not be forwarded to the next.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
})

# Connect fast (it is loopback), never time out a read: /api/events is an SSE
# stream that is *supposed* to stay open with nothing on it.
_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0)

_client: Optional[httpx.AsyncClient] = None
_start_lock = asyncio.Lock()


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False)
    return _client


def _start_with_bridge() -> dict:
    """Refresh the Hermes manifest, then start. Order matters: the harness reads the
    manifest once at boot, so it has to exist before the process does."""
    bridge.refresh(supervisor.data_dir())
    return supervisor.start()


async def _ensure_running() -> Optional[str]:
    """Start the harness if it is not up. Returns an error string, or None."""
    if supervisor.is_running():
        return None
    async with _start_lock:
        if supervisor.is_running():
            return None
        result = await run_in_threadpool(_start_with_bridge)
    return None if result.get("ok") else str(result.get("error") or "the harness could not be started")


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def _public_base(request: Request) -> str:
    """Where this dashboard answers from, as an absolute URL.

    The desktop app renders the same UI but is not served by the dashboard, so it
    cannot resolve a relative path against it; it has to be told. A reverse proxy
    rewrites the request, so an explicitly configured public URL wins.
    """
    configured = os.environ.get("HERMES_DASHBOARD_PUBLIC_URL", "").strip()
    return (configured or str(request.base_url)).rstrip("/")


@router.get("/status")
async def status(request: Request):
    """What the tab shows before it dares render an iframe."""
    state = await run_in_threadpool(supervisor.status)
    return {**state, "ui_url": f"{_public_base(request)}/dashboard-plugins/harnessbot/ui/index.html"}


@router.post("/start")
async def start():
    return await run_in_threadpool(_start_with_bridge)


@router.post("/stop")
async def stop():
    return await run_in_threadpool(supervisor.stop)


@router.post("/restart")
async def restart():
    """Stop then start so a harness adopted from before HB_STATIC_DIR was set
    begins serving the full UI. The desktop plugin calls this when health.static
    is false. Refresh the Hermes manifest before start, same as /start."""

    def _restart() -> dict:
        supervisor.stop()
        return _start_with_bridge()

    return await run_in_threadpool(_restart)


# ---------------------------------------------------------------------------
# API proxy
# ---------------------------------------------------------------------------

@router.api_route(
    "/hb/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy(path: str, request: Request):
    problem = await _ensure_running()
    if problem:
        return JSONResponse({"error": problem}, status_code=503)

    target = f"{supervisor.base_url()}/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    # The harness refuses a non-loopback Host header as a DNS-rebinding defence,
    # so the dashboard's own Host (a VPS hostname) must not survive the hop.
    headers["host"] = f"127.0.0.1:{supervisor.port()}"

    body = await request.body()
    upstream = _http().build_request(request.method, target, headers=headers, content=body)

    try:
        response = await _http().send(upstream, stream=True)
    except httpx.HTTPError as exc:
        return JSONResponse({"error": f"harness unreachable: {exc}"}, status_code=502)

    async def body_stream():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose()

    return StreamingResponse(
        body_stream(),
        status_code=response.status_code,
        headers={k: v for k, v in response.headers.items() if k.lower() not in _HOP_BY_HOP},
        media_type=response.headers.get("content-type"),
    )
