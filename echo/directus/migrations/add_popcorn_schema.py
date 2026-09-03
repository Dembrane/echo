#!/usr/bin/env python3
"""Idempotent migration for popcorn sessions.

Popcorn rides the canvas loop tables. This adds the four things it needs:

- `project_report.kind` accepts "popcorn" alongside "report" and "canvas";
- `project_report.public_token` (string): the capability for the public page;
- `canvas_config_revision.popcorn_settings` (json): presentation toggles;
- `agent_loop.popcorn_state` (json): per-conversation phrases and analysis.

Run against local Directus, then pull the snapshot:

  python3 add_popcorn_schema.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  cd echo/directus && bash sync.sh -u http://localhost:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import sys
import json
import urllib.parse
import urllib.request
from typing import Any
from pathlib import Path

SERVER_PATH = Path(__file__).resolve().parents[2] / "server"
if str(SERVER_PATH) not in sys.path:
    sys.path.insert(0, str(SERVER_PATH))

from add_smart_loop_phase0_schema import (  # noqa: E402
    Directus,
    login,
    json_field,
    ensure_field,
    string_field,
    ensure_schema,
)

REPORT_KINDS = ["report", "canvas", "popcorn"]


def _patch(dx: Directus, path: str, body: dict[str, Any]) -> dict:
    if dx.dry_run:
        print(f"    [dry-run] PATCH {path}")
        return {}
    return dx._request("PATCH", path, body)  # noqa: SLF001


def ensure_report_kind_choice(dx: Directus) -> None:
    path = "/fields/project_report/kind"
    field = dx.get(path).get("data") or {}
    meta = field.get("meta") or {}
    options = meta.get("options") or {}
    existing = [choice.get("value") for choice in options.get("choices") or []]
    if all(kind in existing for kind in REPORT_KINDS):
        print("  project_report.kind: choices already include popcorn, skipping")
        return
    choices = [{"text": kind, "value": kind} for kind in REPORT_KINDS]
    _patch(dx, path, {"meta": {"options": {**options, "choices": choices}}})
    print("  project_report.kind: choices updated")


def ensure_popcorn_schema(dx: Directus) -> None:
    print("Step 0/3: phase 0 dependencies")
    ensure_schema(dx)

    print("Step 1/3: project_report kind choices and public token")
    ensure_report_kind_choice(dx)
    ensure_field(
        dx,
        "project_report",
        string_field("project_report", "public_token", sort=21),
    )

    print("Step 2/3: canvas_config_revision.popcorn_settings")
    ensure_field(
        dx,
        "canvas_config_revision",
        json_field("canvas_config_revision", "popcorn_settings", sort=10),
    )

    print("Step 3/3: agent_loop.popcorn_state")
    ensure_field(dx, "agent_loop", json_field("agent_loop", "popcorn_state", sort=40))


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email", required=True)
    parser.add_argument("-p", "--password", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = login(args.url, args.email, args.password)
    ensure_popcorn_schema(Directus(args.url, token, dry_run=args.dry_run))
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
