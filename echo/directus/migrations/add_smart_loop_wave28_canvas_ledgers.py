#!/usr/bin/env python3
"""Idempotent migration for SMART loop Wave 28 canvas ledgers.

Run against local Directus, then pull the snapshot:

  python3 add_smart_loop_wave28_canvas_ledgers.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  cd echo/directus && bash sync.sh -u http://localhost:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import sys
import argparse
from pathlib import Path

SERVER_PATH = Path(__file__).resolve().parents[2] / "server"
if str(SERVER_PATH) not in sys.path:
    sys.path.insert(0, str(SERVER_PATH))

from add_smart_loop_phase0_schema import (  # noqa: E402
    Directus,
    login,
    json_field,
    ensure_field,
    ensure_schema,
)


def ensure_wave28_schema(dx: Directus) -> None:
    print("Step 0/1: phase 0 dependencies")
    ensure_schema(dx)

    print("Step 1/1: agent_loop canvas ledger fields")
    for sort, field in enumerate(
        (
            "canvas_tabs",
            "canvas_quotes_ledger",
            "canvas_concepts_ledger",
            "canvas_crux",
            "canvas_host_items",
            "canvas_story_slides",
        ),
        start=30,
    ):
        ensure_field(dx, "agent_loop", json_field("agent_loop", field, sort=sort))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email", required=True)
    parser.add_argument("-p", "--password", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = login(args.url, args.email, args.password)
    ensure_wave28_schema(Directus(args.url, token, dry_run=args.dry_run))
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
