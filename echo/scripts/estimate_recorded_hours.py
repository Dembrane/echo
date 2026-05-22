"""
Estimate total hours recorded across all conversations for the last 30 days
and the last 6 months.

Usage:
    DIRECTUS_URL=https://... \
    DIRECTUS_EMAIL=... \
    DIRECTUS_PASSWORD=... \
    python scripts/estimate_recorded_hours.py

Designed to be gentle on a live Directus:
  - Small batches with a sleep between requests.
  - Only the strictly needed fields are requested (id, project_id, created_at, duration).
  - Excludes conversations whose project is owned by an Administrator
    (filter[project_id][directus_user_id][role][name][_neq] = Administrator).

Reports: actual `conversation.duration` summed up (no estimation),
plus distinct project count and conversation count for each window.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests

# Gentle defaults — overridable via env
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "100"))
SLEEP_BETWEEN_BATCHES = float(os.environ.get("SLEEP_BETWEEN_BATCHES", "0.4"))

# Exclude conversations whose project is owned by an Administrator.
EXCLUDE_ADMIN_FILTER = {
    "filter[project_id][directus_user_id][role][name][_neq]": "Administrator",
}

TOTAL_STEPS = 4


# ---------------------------------------------------------------------------
# Progress UI
# ---------------------------------------------------------------------------

def step(n: int, msg: str) -> None:
    print(f"\n[Step {n}/{TOTAL_STEPS}] {msg}", file=sys.stderr, flush=True)


def progress_bar(current: int, total: int, prefix: str = "", width: int = 30) -> None:
    total = max(total, 1)
    pct = min(current / total, 1.0)
    filled = int(width * pct)
    bar = "█" * filled + "░" * (width - filled)
    line = f"\r  {prefix} [{bar}] {current}/{total} ({pct * 100:5.1f}%)"
    print(line, end="", flush=True, file=sys.stderr)
    if current >= total:
        print("", file=sys.stderr)


# ---------------------------------------------------------------------------
# Directus helpers
# ---------------------------------------------------------------------------

def login(base_url: str, email: str, password: str) -> str:
    r = requests.post(
        f"{base_url.rstrip('/')}/auth/login",
        json={"email": email, "password": password},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["data"]["access_token"]


def count_conversations(base_url: str, token: str, since: datetime) -> int:
    """Server-side count — single cheap aggregate query."""
    r = requests.get(
        f"{base_url.rstrip('/')}/items/conversation",
        params={
            "aggregate[count]": "id",
            "filter[created_at][_gte]": since.isoformat(),
            **EXCLUDE_ADMIN_FILTER,
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    if not data:
        return 0
    count_val = data[0].get("count")
    if isinstance(count_val, dict):
        count_val = count_val.get("id") or next(iter(count_val.values()), 0)
    return int(count_val or 0)


def fetch_metadata(
    base_url: str, token: str, since: datetime, expected_total: int
) -> List[Dict[str, Any]]:
    """Pass 1: id, created_at, duration, chunk count. No transcripts (cheap)."""
    headers = {"Authorization": f"Bearer {token}"}
    out: List[Dict[str, Any]] = []
    offset = 0

    while True:
        r = requests.get(
            f"{base_url.rstrip('/')}/items/conversation",
            params={
                "fields": "id,project_id,created_at,duration",
                "filter[created_at][_gte]": since.isoformat(),
                "sort": "created_at",
                "limit": BATCH_SIZE,
                "offset": offset,
                **EXCLUDE_ADMIN_FILTER,
            },
            headers=headers,
            timeout=120,
        )
        r.raise_for_status()
        batch = r.json().get("data", [])
        if not batch:
            break
        out.extend(batch)
        progress_bar(min(len(out), expected_total), expected_total, prefix="metadata")
        if len(batch) < BATCH_SIZE:
            break
        offset += BATCH_SIZE
        time.sleep(SLEEP_BETWEEN_BATCHES)

    # ensure bar shows complete
    progress_bar(len(out), max(len(out), expected_total), prefix="metadata")
    return out


def _project_id(row: Dict[str, Any]) -> str:
    p = row.get("project_id")
    if isinstance(p, dict):
        return str(p.get("id", ""))
    return str(p or "")


def summarise(label: str, rows: List[Dict[str, Any]]) -> None:
    actual = 0
    projects = set()
    for r in rows:
        d = r.get("duration")
        if d is not None and d > 0:
            actual += int(d)
        pid = _project_id(r)
        if pid:
            projects.add(pid)

    print(f"\n=== {label} ===")
    print(f"  Conversations:               {len(rows):>10,}")
    print(f"  Projects:                    {len(projects):>10,}")
    print(f"  Actual hours:                {actual / 3600:>10,.1f}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    url = os.environ.get("DIRECTUS_URL")
    email = os.environ.get("DIRECTUS_EMAIL")
    password = os.environ.get("DIRECTUS_PASSWORD")
    if not (url and email and password):
        print(
            "Missing env vars. Set DIRECTUS_URL, DIRECTUS_EMAIL, DIRECTUS_PASSWORD.",
            file=sys.stderr,
        )
        return 1

    now = datetime.now(timezone.utc)
    cutoff_1m = now - timedelta(days=30)
    cutoff_6m = now - timedelta(days=30 * 6)
    cutoff_1y = now - timedelta(days=365)

    print(
        f"Config: BATCH_SIZE={BATCH_SIZE}, SLEEP={SLEEP_BETWEEN_BATCHES}s",
        file=sys.stderr,
    )

    step(1, f"Logging in to {url} as {email}...")
    token = login(url, email, password)

    step(2, f"Counting conversations since {cutoff_1y.date()} (server aggregate)...")
    total = count_conversations(url, token, cutoff_1y)
    print(f"  → {total:,} conversations in 1-year window", file=sys.stderr)

    if total == 0:
        print("\nNothing to report.", file=sys.stderr)
        return 0

    step(3, f"Fetching conversation metadata (id, project, duration) in batches of {BATCH_SIZE}...")
    rows = fetch_metadata(url, token, cutoff_1y, expected_total=total)
    print(f"  → fetched {len(rows):,} rows", file=sys.stderr)

    step(4, "Computing hours...")

    def _in_window(r: Dict[str, Any], cutoff: datetime) -> bool:
        created = r.get("created_at")
        if not created:
            return False
        return datetime.fromisoformat(created.replace("Z", "+00:00")) >= cutoff

    last_1m = [r for r in rows if _in_window(r, cutoff_1m)]
    last_6m = [r for r in rows if _in_window(r, cutoff_6m)]

    summarise(f"Last 1 month  (since {cutoff_1m.date()})", last_1m)
    summarise(f"Last 6 months (since {cutoff_6m.date()})", last_6m)
    summarise(f"Last 1 year   (since {cutoff_1y.date()})", rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
