"""Export a fictional deck; optionally seed it into local Echo via Directus API.

Run from server with `PYTHONPATH=. uv run python scripts/popcorn_demo.py --help`.
The fixture is authored demo content, not the result of a model/extraction run.
"""

from __future__ import annotations

import re
import html
import json
import shutil
import asyncio
import secrets
import argparse
from uuid import NAMESPACE_URL, uuid5
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse, urlencode

from dembrane.popcorn.view import LOGO_PATH, ILLUSTRATIONS, render_popcorn_page
from dembrane.popcorn.ticks import ANALYSIS_VIEWS, _fingerprint
from dembrane.popcorn.service import (
    PARTICIPANT_LANGUAGE_CODES,
    fresh_state,
    build_bundle,
    default_settings,
)

SALES_PORTAL = Path(__file__).resolve().parents[2] / "demos/sales-portal.json"


def identity(slug: str, kind: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"dembrane:synthetic-demo:{slug}:{kind}"))


def sales_portal_url(portal_base_url: str, project_id: str, language: str) -> str:
    code = PARTICIPANT_LANGUAGE_CODES.get(language, "en-US")
    return f"{portal_base_url.rstrip('/')}/{code}/{project_id}/start"


def tagged_portal_url(portal_url: str, slug: str) -> str:
    parsed = urlparse(portal_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.fragment
        or parsed.username
    ):
        raise ValueError("Provide an HTTP(S) portal URL without credentials or fragment")
    query = urlencode({"utm_source": "popcorn_demo", "utm_campaign": slug})
    return f"{portal_url}{'&' if parsed.query else '?'}{query}"


def prepare(fixture: dict, portals: str | dict[str, str]) -> tuple[dict, dict]:
    """The demo's popcorn state and settings. Its QR opens the sales portal,
    one per language (a bare URL is the demo's language), tagged with the
    demo it was scanned from."""
    slug = fixture["slug"]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        raise ValueError("The demo slug must be lowercase words separated by hyphens")
    if fixture.get("synthetic") is not True:
        raise ValueError("Only explicitly synthetic fixtures can be exported")
    if isinstance(portals, str):
        portals = {fixture["language"]: portals}
    if fixture["language"] not in portals:
        raise ValueError("Provide a sales portal in the demo's own language")
    portal_urls = {lang: tagged_portal_url(url, slug) for lang, url in portals.items()}
    state = fresh_state()
    state["run"] = 1
    state["demo"] = {
        "synthetic": True,
        "public_sources_only": fixture.get("public_sources_only") is True,
        "language": fixture["language"],
        "portal_url": portal_urls[fixture["language"]],
        "portal_urls": portal_urls,
        # The demo's own words; a host cannot change them from the dashboard.
        "disclosure": {
            "text": fixture.get("disclosure", ""),
            "invitation_title": fixture.get("invitation_title", ""),
            "invitation_text": fixture.get("invitation_text", ""),
        },
        "notice": {"text": fixture.get("notice", "")},
    }
    # Every phrase is a sentence of its transcript, so it is rooted the way a
    # real second pass roots it: one quote per phrase, word for word. The
    # fixture's analysis cites phrase ids; they become the quote ids here.
    quote_ids: dict[str, str] = {}
    for conversation in fixture["conversations"]:
        cid = identity(slug, conversation["id"])
        lines = [line.split(": ", 1)[-1] for line in conversation["transcript"].splitlines()]
        items = []
        for item in conversation["items"]:
            sentence = next((line for line in lines if item["phrase"] in line), None)
            if sentence is None:
                raise ValueError(f"Phrase {item['id']} is not in its transcript")
            quote_id = f"q{len(state['quotes']) + 1}"
            quote_ids[item["id"]] = quote_id
            state["quotes"].append({"id": quote_id, "transcript": cid, "text": sentence})
            items.append({**item, "quoteId": quote_id, "verbatim": True, "rooted": True})
        # Stamped the way the tick stamps a read, so a refresh or a translation
        # request finds nothing to re-read and leaves the authored deck alone.
        fingerprint = _fingerprint(conversation["transcript"].strip() + "\x1f")
        state["order"].append(cid)
        state["conversations"][cid] = {
            "label": conversation["label"],
            "short": conversation["theme"],
            "items": items,
            "done": True,
            "revision": 1,
            "fingerprint": fingerprint,
            "validated_fingerprint": fingerprint,
        }

    def cite(entry: dict) -> dict:
        entry = dict(entry)
        if "quoteIds" in entry:
            entry["quoteIds"] = [quote_ids[ref] for ref in entry["quoteIds"]]
        if "aspects" in entry:
            entry["aspects"] = [cite(aspect) for aspect in entry["aspects"]]
        return entry

    analysis = fixture["analysis"]
    read = _fingerprint(
        "|".join(f"{cid}:{state['conversations'][cid]['fingerprint']}" for cid in state["order"])
    )
    state["analysis"] = {
        "fingerprints": {view: read for view in ANALYSIS_VIEWS},
        "tensions": {"tensions": [cite(t) for t in analysis["tensions"]["tensions"]]},
        "stakeholders": {
            "stakeholders": [cite(s) for s in analysis["stakeholders"]["stakeholders"]],
            "relations": [cite(r) for r in analysis["stakeholders"]["relations"]],
        },
    }
    settings = default_settings(title=fixture["title"], client=fixture["organisation"])
    settings.update(
        {
            "show_qr": True,
            "public_labels": "names",
            "public": True,
            "intro": {"enabled": True, "title": fixture["title"], "subtitle": fixture["subtitle"]},
            "data": {"enabled": True},
        }
    )
    return state, settings


def export(fixture: dict, state: dict, settings: dict, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    deck = output / fixture["slug"]
    (deck / "data").mkdir(parents=True, exist_ok=True)
    # No project row behind an export: the data screen reads the fixture's.
    project = {"anonymize_transcripts": fixture.get("anonymize_transcripts") is True}
    bundle = build_bundle(
        state=state, settings=settings, report={}, project=project, participant_base_url=""
    )
    page = render_popcorn_page(embed={"mode": "sample"})
    page = page.replace('<html lang="en">', '<html lang="nl">').replace(
        '<meta charset="utf-8">',
        '<meta charset="utf-8"><meta name="robots" content="noindex,nofollow">',
    )
    (deck / "index.html").write_text(page)
    (deck / "data/bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2))
    shutil.copyfile(LOGO_PATH, deck / "logo.png")
    (deck / "illustrations").mkdir(exist_ok=True)
    for name, path in ILLUSTRATIONS.items():
        shutil.copyfile(path, deck / "illustrations" / f"{name}.webp")
    # Update a small catalogue without removing other exported organisations.
    catalogue_path = output / "catalogue.json"
    catalogue = json.loads(catalogue_path.read_text()) if catalogue_path.exists() else {}
    catalogue[fixture["slug"]] = {
        "organisation": fixture["organisation"],
        "synthetic": True,
        "language": fixture["language"],
    }
    catalogue_path.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2))
    cards = "".join(
        f'<li><a href="{html.escape(slug)}/">{html.escape(item["organisation"])}</a> · synthetische demo</li>'
        for slug, item in catalogue.items()
    )
    (output / "index.html").write_text(
        f'<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>popcorn voorbeelden</title><style>body{{font:20px/1.5 system-ui;background:#F6F4F1;color:#2D2D2C;margin:3em}}a{{color:#4169E1}}</style><h1>popcorn voorbeelden</h1><p>Verzonnen perspectieven. Een voorproefje van echt luisteren.</p><ul>{cards}</ul></html>'
    )
    (output / "robots.txt").write_text("User-agent: *\nDisallow: /\n")


def require_local_directus() -> None:
    from dembrane.settings import get_settings

    if urlparse(get_settings().directus.base_url).hostname not in {
        "localhost",
        "127.0.0.1",
        "directus",
        "::1",
    }:
        raise ValueError("Seeding is restricted to the local development Directus")


async def upsert(collection: str, item_id: str, payload: dict) -> dict:
    from dembrane.directus_async import async_directus

    rows = await async_directus.get_items(
        collection, {"query": {"filter": {"id": {"_eq": item_id}}, "limit": 1}}
    )
    if not isinstance(rows, list):
        raise RuntimeError(f"Could not read {collection} before writing the demo")
    if rows:
        return (await async_directus.update_item(collection, item_id, payload))["data"]
    return (await async_directus.create_item(collection, {"id": item_id, **payload}))["data"]


async def seed_sales_portal(language: str, workspace_id: str, owner_id: str) -> str:
    """The local stand-in for dembrane's sales portal: a real project, open to
    recordings, whose page says the demo will not change and asks for
    feedback. One per language; the same words go to production through
    `dembrane_update_project`."""
    copy = json.loads(SALES_PORTAL.read_text())[language if language == "nl" else "en"]
    pid = identity("sales-portal", language)
    await upsert(
        "project",
        pid,
        {
            **copy,
            "language": language,
            "workspace_id": workspace_id,
            "directus_user_id": owner_id,
            "is_conversation_allowed": True,
        },
    )
    return pid


async def seed(
    fixture: dict, state: dict, settings: dict, workspace_id: str, owner_id: str, research: str
) -> dict:
    from dembrane.directus_async import async_directus

    slug = fixture["slug"]
    pid, config_id, loop_id = [identity(slug, key) for key in ("project", "config", "loop")]

    await upsert(
        "project",
        pid,
        {
            "name": f"[SYNTHETISCH] {fixture['organisation']} · Bondgenotendag",
            "language": "nl",
            "workspace_id": workspace_id,
            "directus_user_id": owner_id,
            "is_canvas_enabled": True,
            "is_conversation_allowed": False,
            "anonymize_transcripts": fixture.get("anonymize_transcripts") is True,
            "context": research,
        },
    )
    for conv in fixture["conversations"]:
        cid = identity(slug, conv["id"])
        await upsert(
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
                "merged_transcript": conv["transcript"],
                "summary": f"Synthetische demo. Verzonnen gesprek over {conv['theme']}. Geen echte deelnemers.",
            },
        )
        await upsert(
            "conversation_chunk",
            identity(slug, conv["id"] + ":chunk"),
            {
                "conversation_id": cid,
                "transcript": conv["transcript"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
    existing = await async_directus.get_items(
        "project_report",
        {"query": {"filter": {"project_id": {"_eq": pid}, "kind": {"_eq": "popcorn"}}, "limit": 1}},
    )
    if not isinstance(existing, list):
        raise RuntimeError("Could not read the local demo report")
    token = existing[0].get("public_token") if existing else None
    token = token or secrets.token_urlsafe(24)
    report_data = {
        "project_id": pid,
        "kind": "popcorn",
        "status": "published",
        "user_instructions": fixture["title"],
        "content": "Synthetische demo. Geen echte gespreksuitkomsten.",
        "public_token": token,
        "user_created": owner_id,
    }
    if existing:
        rid = str(existing[0]["id"])
        await upsert("project_report", rid, report_data)
    else:
        report = (await async_directus.create_item("project_report", report_data))["data"]
        rid = str(report["id"])
    await upsert(
        "canvas_config_revision",
        config_id,
        {
            "report_id": rid,
            "brief": research,
            "gather_spec": {"full_history": True},
            "popcorn_settings": settings,
            "cadence_minutes": 2,
            "created_by": owner_id,
            "note": "Authored synthetic demo fixture. No model run claimed.",
        },
    )
    await upsert(
        "agent_loop",
        loop_id,
        {
            "project_id": pid,
            "report_id": rid,
            "name": fixture["title"],
            "status": "paused",
            "expires_at": datetime.now(timezone.utc).isoformat(),
            "cadence_minutes": 2,
            "acting_directus_user_id": owner_id,
            "failure_count": 0,
            "caps": {"kind": "popcorn"},
            "popcorn_state": state,
        },
    )
    return {
        "project_id": pid,
        "report_id": rid,
        "public_token": token,
        "workspace_id": workspace_id,
    }


async def seed_local(args: argparse.Namespace, fixture: dict) -> dict:
    require_local_directus()
    portals = {}
    for language in dict.fromkeys((fixture["language"], "en")):
        portal_id = await seed_sales_portal(language, args.workspace_id, args.owner_id)
        portals[language] = sales_portal_url(args.portal_base_url, portal_id, language)
    state, settings = prepare(fixture, portals)
    export(fixture, state, settings, args.output)
    seeded = await seed(
        fixture,
        state,
        settings,
        args.workspace_id,
        args.owner_id,
        args.fixture.with_name("research.md").read_text(),
    )
    return {"qr": state["demo"]["portal_urls"], **seeded}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=Path("../demos/deltawonen/fixture.json"))
    parser.add_argument(
        "--base-url",
        default="http://localhost:5190",
        help="Where the exported deck is served, for the printed preview link",
    )
    parser.add_argument(
        "--portal-url",
        action="append",
        default=[],
        help=(
            "The sales portal's start link, for an export without --seed-local: a bare "
            "URL for the demo's language, or LANG=URL, repeatable"
        ),
    )
    parser.add_argument(
        "--portal-base-url",
        default="http://localhost:5174",
        help="Local participant portal origin for --seed-local; use the LAN IP for phones",
    )
    parser.add_argument("--output", type=Path, default=Path("../demos/.preview"))
    parser.add_argument("--seed-local", action="store_true")
    parser.add_argument("--workspace-id")
    parser.add_argument("--owner-id")
    args = parser.parse_args()
    if args.seed_local and not (args.workspace_id and args.owner_id):
        parser.error("--seed-local requires --workspace-id and --owner-id")
    if not (args.seed_local or args.portal_url):
        parser.error("Provide --portal-url, or --seed-local to seed a local sales portal")
    fixture = json.loads(args.fixture.read_text())
    result = {
        "preview": f"{args.base_url.rstrip('/')}/{fixture['slug']}/",
        "output": str(args.output.resolve()),
    }
    if args.seed_local:
        result.update(asyncio.run(seed_local(args, fixture)))
        (args.output.parent / ".local-session.json").write_text(json.dumps(result, indent=2))
    else:
        portals = dict(
            item.split("=", 1) if re.match(r"^[a-z]{2}=", item) else (fixture["language"], item)
            for item in args.portal_url
        )
        state, settings = prepare(fixture, portals)
        export(fixture, state, settings, args.output)
        result["qr"] = state["demo"]["portal_urls"]
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
