"""Hand HarnessBot what Hermes already has: its MCP servers and its skills.

Hermes is the host, and it usually arrives with a configured toolbox — MCP servers
in ``config.yaml`` and a skills library under ``<hermes home>/skills``. Rebuilding
either inside HarnessBot would be a second copy to keep in step, so this exports a
small manifest instead and HarnessBot reads it at boot.

Two deliberate choices:

* **Paths, not payloads.** The manifest carries the skills *directory*, not 62
  skill bodies. HarnessBot already knows how to read a ``SKILL.md`` tree, and a
  copied body is a body that goes stale.
* **Definitions, not permissions.** Servers arrive switched off. Hermes having a
  server configured is not the same as the user wanting every bot to hold it, and
  HarnessBot's own rule for imported packages is that nothing runs unasked.

Hermes plugins themselves are Python running in the Hermes process, so HarnessBot
cannot load them; what a plugin *contributes* — its MCP servers and its bundled
skills — arrives through exactly these two channels.

Runs inside Hermes, so it may import Hermes. ``supervisor.py`` may not.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

BRIDGE_ENV = "HB_HERMES_BRIDGE"
PREFIX = "hermes/"
MAX_SERVERS = 100


def _hermes_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        config = load_config()
        return config if isinstance(config, dict) else {}
    except Exception as exc:  # pragma: no cover - Hermes not importable
        logger.debug("HarnessBot bridge: no Hermes config (%s)", exc)
        return {}


def _hermes_home() -> Optional[Path]:
    try:
        from hermes_constants import get_default_hermes_root

        return Path(os.environ.get("HERMES_HOME") or get_default_hermes_root())
    except Exception:
        env = os.environ.get("HERMES_HOME")
        return Path(env) if env else None


def mcp_servers(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Hermes' ``mcp_servers`` in the shape HarnessBot stores them.

    Named with a ``hermes/`` prefix so both sides can tell an imported definition
    from one the user typed into HarnessBot, and so refreshing these never touches
    the others.
    """
    raw = (config if config is not None else _hermes_config()).get("mcp_servers")
    if not isinstance(raw, dict):
        return []

    servers: List[Dict[str, Any]] = []
    for name, entry in list(raw.items())[:MAX_SERVERS]:
        if not isinstance(entry, dict):
            continue
        # Hermes can mark an entry off; an entry it will not run is not one to offer.
        if entry.get("enabled") is False:
            continue

        url = entry.get("url")
        record: Dict[str, Any] = {"name": f"{PREFIX}{name}"[:80], "enabled": False}
        if url:
            record["transport"] = "sse" if entry.get("type") == "sse" else "http"
            record["url"] = str(url)
            headers = entry.get("headers")
            if isinstance(headers, dict):
                record["headers"] = {str(k): str(v) for k, v in headers.items()}
        else:
            command = entry.get("command")
            if not command:
                continue
            record["transport"] = "stdio"
            record["command"] = str(command)
            args = entry.get("args")
            record["args"] = [str(a) for a in args] if isinstance(args, list) else []
            env = entry.get("env")
            if isinstance(env, dict):
                record["env"] = {str(k): str(v) for k, v in env.items()}
        servers.append(record)
    return servers


def skills_root() -> Optional[str]:
    home = _hermes_home()
    if not home:
        return None
    root = home / "skills"
    return str(root) if root.is_dir() else None


def manifest() -> Dict[str, Any]:
    config = _hermes_config()
    return {
        "version": 1,
        "writtenAt": int(time.time() * 1000),
        "profile": os.environ.get("HERMES_PROFILE", "") or "default",
        "skillsRoot": skills_root(),
        "mcpServers": mcp_servers(config),
    }


def refresh(data_dir: Path) -> Optional[Path]:
    """Write the manifest and point the environment at it. Returns the path, or None.

    Called before the harness is started so the child inherits ``BRIDGE_ENV``; a
    failure here is never fatal — HarnessBot runs perfectly well with no bridge,
    it just does not see Hermes' toolbox.
    """
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        target = data_dir / "hermes-bridge.json"
        payload = manifest()
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(target)
        os.environ[BRIDGE_ENV] = str(target)
        logger.debug(
            "HarnessBot bridge: %d MCP server(s), skills=%s",
            len(payload["mcpServers"]), payload["skillsRoot"],
        )
        return target
    except Exception as exc:
        logger.warning("HarnessBot bridge: could not write manifest (%s)", exc)
        return None


if __name__ == "__main__":
    print(json.dumps(manifest(), indent=2))
