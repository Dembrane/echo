"""Seed a reviewed synthetic demo into a dembrane staging environment (echo-next).

The demo tooling's write, the way the local helper (`scripts/popcorn_demo.py
--seed-local`) does it, for one named staging environment: one synthetic
project per language in the demo's `session.json`, each with the invented
conversations from `corpus/`, a Popcorn session carrying the reviewed read
from `out/` (made by `run_demo.py`) and the synthetic marking only this
tooling writes. Plus the sales portal projects the QR opens, one per
language, words from `sales-portal.json`.

Demos about a real organisation live outside this repository; `--demo`
points at one.

Every id is deterministic, so a rerun updates this demo and nothing else.
The loop stays in manual mode: nothing reads until a host presses Refresh or
Rerun, and a Rerun reads the same conversations again on that environment.

Needs a Directus admin static token for the target, in DEMO_DIRECTUS_TOKEN:

    DEMO_DIRECTUS_TOKEN=... python3 seed_demo.py --demo <folder> \
        --directus-url https://directus.echo-next.dembrane.com \
        --portal-base-url https://portal.echo-next.dembrane.com \
        --api-base-url https://api.echo-next.dembrane.com \
        --workspace-id <workspace> --owner-id <directus user> [--dry-run]
"""

from __future__ import annotations

import os
import sys
import json
import secrets
import argparse
from uuid import NAMESPACE_URL, uuid5
from pathlib import Path
from datetime import datetime, timedelta
from urllib.parse import urlparse, urlencode

import httpx

TOOLS = Path(__file__).resolve().parent
PRODUCTION_HOSTS = {"directus.dembrane.com", "api.dembrane.com", "dashboard.dembrane.com"}
PARTICIPANT_CODES = {"en": "en-US", "es": "es-ES", "nl": "nl-NL"}
SUMMARY = {
    "en": "Synthetic demo. An invented conversation. No real participants.",
    "es": "Demo sintética. Una conversación inventada. Sin participantes reales.",
    "nl": "Synthetische demo. Een verzonnen gesprek. Geen echte deelnemers.",
}


def identity(slug: str, kind: str) -> str:
    # The same namespace as scripts/popcorn_demo.py, so the sales portals are
    # the ones the local helper writes.
    return str(uuid5(NAMESPACE_URL, f"dembrane:synthetic-demo:{slug}:{kind}"))


class Directus:
    def __init__(self, base_url: str, token: str, dry_run: bool) -> None:
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        self.dry_run = dry_run

    def find(self, collection: str, flt: dict) -> list[dict]:
        r = self.client.get(f"/items/{collection}", params={"filter": json.dumps(flt), "limit": 1})
        r.raise_for_status()
        return r.json()["data"]

    def upsert(self, collection: str, item_id: str, payload: dict) -> dict:
        existing = self.find(collection, {"id": {"_eq": item_id}})
        if self.dry_run:
            print(f"{'update' if existing else 'create'} {collection} {item_id}")
            return {"id": item_id, **payload}
        if existing:
            r = self.client.patch(f"/items/{collection}/{item_id}", json=payload)
        else:
            r = self.client.post(f"/items/{collection}", json={"id": item_id, **payload})
        if r.is_error:
            raise RuntimeError(f"{collection} {item_id}: {r.status_code} {r.text[:400]}")
        return r.json()["data"]

    def create(self, collection: str, payload: dict) -> dict:
        if self.dry_run:
            print(f"create {collection}")
            return {"id": "dry-run", **payload}
        r = self.client.post(f"/items/{collection}", json=payload)
        if r.is_error:
            raise RuntimeError(f"{collection}: {r.status_code} {r.text[:400]}")
        return r.json()["data"]


def portal_start(base: str, project_id: str, language: str, slug: str) -> str:
    code = PARTICIPANT_CODES[language]
    query = urlencode({"utm_source": "popcorn_demo", "utm_campaign": slug})
    return f"{base.rstrip('/')}/{code}/{project_id}/start?{query}"


def seed_sales_portals(
    d: Directus, args: argparse.Namespace, languages: list[str], slug: str
) -> dict[str, str]:
    words = json.loads((TOOLS / "sales-portal.json").read_text())
    urls = {}
    for language in languages:
        pid = identity("sales-portal", language)
        d.upsert(
            "project",
            pid,
            {
                **words[language],
                "language": language,
                "workspace_id": args.workspace_id,
                "directus_user_id": args.owner_id,
                "is_conversation_allowed": True,
            },
        )
        urls[language] = portal_start(args.portal_base_url, pid, language, slug)
    return urls


def remapped(state: dict, language: str, demo: Path, slug: str) -> dict:
    """The reviewed read, with its conversation ids moved to this project's
    conversations. Ids are UUIDs, so a whole-text swap touches nothing else."""
    text = json.dumps(state, ensure_ascii=False)
    for path in sorted((demo / "corpus").glob("[0-9][0-9]-*.json")):
        key = json.loads(path.read_text())["id"]
        text = text.replace(identity(slug, key), identity(slug, f"{language}:{key}"))
    return json.loads(text)


def seed_language(
    d: Directus, args: argparse.Namespace, language: str, portals: dict, demo: Path, session: dict
) -> dict:
    slug = session["slug"]
    research = (demo / "research.md").read_text()
    state = remapped(
        json.loads((demo / "out" / f"state-{language}.json").read_text()), language, demo, slug
    )
    settings = json.loads((demo / "out" / f"settings-{language}.json").read_text())
    state["demo"]["portal_url"] = portals[language]
    state["demo"]["portal_urls"] = portals
    title = session["title"][language]
    pid = identity(slug, f"project-{language}")
    d.upsert(
        "project",
        pid,
        {
            "name": f"[SYNTHETIC] {session['organisation']} · {title} ({language.upper()})",
            "language": language,
            "workspace_id": args.workspace_id,
            "directus_user_id": args.owner_id,
            "is_canvas_enabled": True,
            "is_conversation_allowed": False,
            "anonymize_transcripts": True,
            "context": research,
        },
    )
    summary = (session.get("summary") or {}).get(language) or SUMMARY.get(language, SUMMARY["en"])
    for path in sorted((demo / "corpus").glob("[0-9][0-9]-*.json")):
        conv = json.loads(path.read_text())
        cid = identity(slug, f"{language}:{conv['id']}")
        chunks = [c.strip() for c in conv["chunks"] if c.strip()]
        d.upsert(
            "conversation",
            cid,
            {
                "project_id": pid,
                "participant_name": conv["label"],
                "title": conv["label"],
                "source": "DASHBOARD_UPLOAD",
                "is_finished": True,
                "is_all_chunks_transcribed": True,
                "is_audio_processing_finished": True,
                "merged_transcript": "\n".join(chunks),
                "summary": summary,
            },
        )
        start = datetime.fromisoformat(conv["start"])
        for index, chunk in enumerate(chunks):
            d.upsert(
                "conversation_chunk",
                identity(slug, f"{language}:{conv['id']}:chunk:{index:03d}"),
                {
                    "conversation_id": cid,
                    "transcript": chunk,
                    "timestamp": (start + timedelta(seconds=20 * index)).isoformat(),
                },
            )
    found = d.find("project_report", {"project_id": {"_eq": pid}, "kind": {"_eq": "popcorn"}})
    report_data = {
        "project_id": pid,
        "kind": "popcorn",
        "status": "published",
        "user_instructions": title,
        "content": "",
        "public_token": (found[0].get("public_token") if found else None)
        or secrets.token_urlsafe(24),
        "user_created": args.owner_id,
    }
    if found:
        report = d.upsert("project_report", str(found[0]["id"]), report_data)
    else:
        report = d.create("project_report", report_data)
    rid = str(report["id"])
    d.upsert(
        "canvas_config_revision",
        identity(slug, f"config-{language}"),
        {
            "report_id": rid,
            "brief": research,
            "gather_spec": {"full_history": True},
            "popcorn_settings": settings,
            "cadence_minutes": 2,
            "created_by": args.owner_id,
            "note": f"Synthetic {session['organisation']} demo: read by the popcorn pipeline over invented transcripts.",
        },
    )
    d.upsert(
        "agent_loop",
        identity(slug, f"loop-{language}"),
        {
            "project_id": pid,
            "report_id": rid,
            "name": title,
            "status": "paused",
            "expires_at": datetime.now().astimezone().isoformat(),
            "cadence_minutes": 2,
            "acting_directus_user_id": args.owner_id,
            "failure_count": 0,
            "caps": {"kind": "popcorn"},
            "popcorn_state": state,
        },
    )
    return {
        "project_id": pid,
        "report_id": rid,
        "public_link": f"{args.api_base_url.rstrip('/')}/api/v2/popcorn/public/{report_data['public_token']}/",
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--demo", type=Path, required=True, help="the demo's folder")
    parser.add_argument("--directus-url", required=True)
    parser.add_argument("--portal-base-url", required=True)
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--workspace-id", required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    hosts = {
        urlparse(u).hostname for u in (args.directus_url, args.portal_base_url, args.api_base_url)
    }
    if hosts & PRODUCTION_HOSTS:
        sys.exit("This seed is for a staging environment; production waits for the MCP upsert.")
    token = os.environ.get("DEMO_DIRECTUS_TOKEN")
    if not token:
        sys.exit("Set DEMO_DIRECTUS_TOKEN to a Directus admin static token for the target.")
    demo: Path = args.demo.resolve()
    session = json.loads((demo / "session.json").read_text())
    languages = list(session["title"])
    d = Directus(args.directus_url, token, args.dry_run)
    portals = seed_sales_portals(d, args, languages, session["slug"])
    result: dict = {"sales_portals": portals}
    for language in languages:
        result[language] = seed_language(d, args, language, portals, demo, session)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not args.dry_run:
        (demo / "out" / f"seeded-{urlparse(args.directus_url).hostname}.json").write_text(
            json.dumps(result, indent=2, ensure_ascii=False)
        )


if __name__ == "__main__":
    main()
