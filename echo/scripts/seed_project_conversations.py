"""
Seed fake conversations into a project so usage numbers populate.

Usage:
    python scripts/seed_project_conversations.py \
        --project-id ae0c0523-a148-4d39-a9d4-b963decf144d

Creates 1 "Plenary" conversation at 1 hour + 10 "Round Table N" conversations
at 1 hour each for a total of 11 hours of audio. `duration` is stored in
seconds (matches workspaces._get_workspace_usage).

Requires DIRECTUS_TOKEN + DIRECTUS_BASE_URL env vars (falls back to
directus/.env if unset). Idempotent: re-running skips any conversation
whose title already exists in the project so you don't double-count.
"""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from datetime import datetime, timezone

import requests

DIRECTUS_URL = os.environ.get("DIRECTUS_BASE_URL", "http://directus:8055")
DIRECTUS_TOKEN = os.environ.get("DIRECTUS_TOKEN", "")

if not DIRECTUS_TOKEN:
    env_path = os.path.join(os.path.dirname(__file__), "..", "directus", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DIRECTUS_TOKEN="):
                    DIRECTUS_TOKEN = line.split("=", 1)[1].strip().strip('"').strip("'")

HEADERS = {
    "Authorization": f"Bearer {DIRECTUS_TOKEN}",
    "Content-Type": "application/json",
}


def api(method: str, path: str, data: dict | None = None, params: dict | None = None) -> dict | None:
    url = f"{DIRECTUS_URL}{path}"
    resp = requests.request(method, url, headers=HEADERS, json=data, params=params, timeout=30)
    if resp.status_code >= 400:
        print(f"  ERROR {resp.status_code} on {method} {path}: {resp.text[:500]}")
        return None
    if resp.status_code == 204:
        return {}
    return resp.json()


def ensure_project_exists(project_id: str) -> dict | None:
    data = api("GET", f"/items/project/{project_id}")
    if not data or not isinstance(data, dict) or "data" not in data:
        return None
    return data["data"]


def existing_titles(project_id: str) -> set[str]:
    """Read current conversation titles for idempotency."""
    resp = api(
        "GET",
        "/items/conversation",
        params={
            "filter[project_id][_eq]": project_id,
            "filter[deleted_at][_null]": "true",
            "fields": "title",
            "limit": -1,
        },
    )
    if not resp or "data" not in resp:
        return set()
    return {(r.get("title") or "").strip() for r in resp["data"] if r.get("title")}


def create_conversation(
    *,
    project_id: str,
    title: str,
    duration_seconds: float,
    created_at_iso: str,
) -> bool:
    payload = {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "title": title,
        "duration": duration_seconds,
        "source": "PORTAL_AUDIO",
        "is_finished": True,
        "is_all_chunks_transcribed": True,
        "is_audio_processing_finished": True,
        # Created_at is auto-filled server-side, but we can override so a
        # freshly-seeded set lines up with "this month".
        "created_at": created_at_iso,
    }
    resp = api("POST", "/items/conversation", data=payload)
    if resp is None:
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", required=True, help="Target project UUID.")
    parser.add_argument(
        "--plenary-hours",
        type=float,
        default=1.0,
        help="Duration of the Plenary conversation (hours). Default 1.",
    )
    parser.add_argument(
        "--round-tables",
        type=int,
        default=10,
        help="Number of 'Round Table N' conversations to create. Default 10.",
    )
    parser.add_argument(
        "--round-table-hours",
        type=float,
        default=1.0,
        help="Duration of each round table (hours). Default 1.",
    )
    args = parser.parse_args()

    if not DIRECTUS_TOKEN:
        print("Set DIRECTUS_TOKEN (or populate directus/.env).")
        return 2

    project = ensure_project_exists(args.project_id)
    if not project:
        print(f"Project {args.project_id} not found or fetch failed.")
        return 2
    print(f"Project: {project.get('name', args.project_id)}")

    have = existing_titles(args.project_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    conversations: list[tuple[str, float]] = [
        (f"Plenary - {int(args.plenary_hours)}hr", args.plenary_hours * 3600),
    ]
    for i in range(1, args.round_tables + 1):
        conversations.append((f"Round Table {i}", args.round_table_hours * 3600))

    created = 0
    skipped = 0
    failed = 0
    for title, duration_s in conversations:
        if title in have:
            print(f"  skip  {title}  (already exists)")
            skipped += 1
            continue
        ok = create_conversation(
            project_id=args.project_id,
            title=title,
            duration_seconds=duration_s,
            created_at_iso=now_iso,
        )
        if ok:
            print(f"  add   {title}  ({duration_s / 3600:.1f}h)")
            created += 1
        else:
            print(f"  FAIL  {title}")
            failed += 1

    total_hours = sum(d for _, d in conversations) / 3600
    print(
        f"\nDone. created={created} skipped={skipped} failed={failed}. "
        f"Target total: {total_hours:.1f}h across {len(conversations)} conversations."
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
