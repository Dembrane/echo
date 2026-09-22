"""Run the real popcorn pipeline over the invented MozFest corpus, in process.

The same functions the tick calls (first pass, gates, grounding, second pass,
tensions pipeline, stakeholders, translation), with no Directus row behind
them: a pilot and QA pass before the corpus is seeded into an environment,
where that environment's own tick reads it again. Writes the session state and
a static export of the real presenter for review.

From echo/server, inside the dev container:
    PYTHONPATH=.:scripts uv run python ../demos/mozfest-2026/run_local.py \
        --portal-url http://LAN-IP:5174/en-US/<sales-portal>/start
"""

from __future__ import annotations

import sys
import json
import asyncio
import argparse
from typing import Any
from pathlib import Path

from dembrane.popcorn import ticks as T
from dembrane.popcorn.flags import known_shingles, introduced_names
from dembrane.popcorn.model import translate_texts
from dembrane.popcorn.service import fresh_state, build_bundle, default_settings
from dembrane.popcorn.analysis import QuoteBook
from dembrane.popcorn.view import LOGO_PATH, ILLUSTRATIONS, render_popcorn_page
from dembrane.popcorn.translate import (
    cache_key,
    popcorn_texts,
    missing_texts,
    target_languages,
    translatable_texts,
    translated_bundle,
)

from popcorn_demo import identity, tagged_portal_url

HERE = Path(__file__).resolve().parent
SLUG = "mozfest-2026"


class Writer:
    """The tick's writer without a row: the state lives in memory."""

    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state

    async def flush(self) -> None:
        return None


def load_corpus() -> list[dict[str, Any]]:
    out = []
    for path in sorted((HERE / "corpus").glob("[0-9][0-9]-*.json")):
        conv = json.loads(path.read_text())
        text = "\n".join(c.strip() for c in conv["chunks"] if c.strip())
        out.append(
            {
                "id": identity(SLUG, conv["id"]),
                "key": conv["id"],
                "label": conv["label"],
                "short": conv["track"] if len(conv["track"]) <= 24 else conv["track"][:23] + "…",
                "created_at": conv["start"],
                "duration": None,
                "language": conv["language"],
                "text": text,
            }
        )
    return out


def settings_for(fixture: dict[str, Any], language: str) -> dict[str, Any]:
    settings = default_settings(title=fixture["title"][language], client=fixture["organisation"])
    other = "es" if language == "en" else "en"
    settings.update(
        {
            "show_qr": True,
            "public_labels": "names",
            "public": True,
            "intro": {
                "enabled": True,
                "title": fixture["title"][language],
                "subtitle": fixture["subtitle"][language],
            },
            "data": {"enabled": True},
            "language": {"ui": language, "translate_to": language, "also": [other]},
        }
    )
    return settings


def demo_marking(fixture: dict[str, Any], language: str, portals: dict[str, str]) -> dict[str, Any]:
    copy = fixture["copy"][language]
    return {
        "synthetic": True,
        "public_sources_only": fixture.get("public_sources_only") is True,
        "language": language,
        "portal_url": portals[language],
        "portal_urls": portals,
        "disclosure": {
            "text": copy["disclosure"],
            "invitation_title": copy["invitation_title"],
            "invitation_text": copy["invitation_text"],
        },
        "notice": {"text": copy["notice"]},
    }


async def read_session(transcripts: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """One full tick's worth of reading, as `run_popcorn_tick` does it."""
    state = fresh_state()
    state["run"] = 1
    for t in transcripts:
        t["fingerprint"] = T._fingerprint(t["text"] + "\x1f")
        t["window"] = T.model_window(t["text"])
        state["conversations"][t["id"]] = {
            "id": t["id"],
            "revision": 0,
            "done": False,
            "items": [],
            "label": t["label"],
            "short": t["short"],
            "created_at": t["created_at"],
            "duration": None,
        }
        state["order"].append(t["id"])
    writer = Writer(state)
    outcomes: list[str] = []
    known_all = known_shingles(state)
    semaphore = asyncio.Semaphore(T.MAX_PARALLEL_EXTRACTORS)
    await asyncio.gather(
        *(T._extract_one(writer, semaphore, t, outcomes, "", known_all) for t in transcripts)
    )
    book = QuoteBook(
        {t["id"]: t["text"] for t in transcripts},
        names=set().union(*(introduced_names(t["text"]) for t in transcripts)),
        existing=state.get("quotes"),
    )

    async def second_pass() -> None:
        pending = T._pending_enrichment(state, transcripts)
        enrich = asyncio.Semaphore(T.MAX_PARALLEL_ENRICHMENT)
        await asyncio.gather(*(T._enrich_one(writer, enrich, t, outcomes, book) for t in pending))

    async def analysis_pass() -> dict[str, Any]:
        return await T._run_analysis_pass(transcripts, outcomes, book)

    _, fresh = await asyncio.gather(second_pass(), analysis_pass())
    state["quotes"] = list(book.quotes)
    analysis_fingerprint = T._fingerprint(
        "|".join(f"{t['id']}:{t['fingerprint']}" for t in transcripts)
    )
    T._commit_views(
        state,
        fresh,
        analysis_fingerprint=analysis_fingerprint,
        held_quotes={q["id"] for q in state["quotes"]},
        outcomes=outcomes,
    )
    return state, outcomes


async def translate(state: dict[str, Any], settings: dict[str, Any], project: dict) -> list[str]:
    """`_translate_session` over the bundle the room reads, without a row."""
    files = build_bundle(
        state=state, settings=settings, report={}, project=project, participant_base_url=""
    )["files"]
    translations = state.setdefault("translations", {})
    lines = []
    for index, target in enumerate(target_languages(settings)):
        texts = translatable_texts(files) if index == 0 else popcorn_texts(files)
        table = translations.setdefault(target, {})
        gaps = missing_texts(files, table, target, texts)
        if not gaps:
            continue
        answers = await translate_texts(gaps, target)
        for source, text in zip(gaps, answers, strict=True):
            if text:
                table[cache_key(source, target)] = text
        left = len(missing_texts(files, table, target, texts))
        lines.append(f"{target}: {sum(1 for a in answers if a)} of {len(gaps)} ({left} left)")
    return lines


def export_deck(slug: str, language: str, state: dict, settings: dict, output: Path) -> Path:
    """The real presenter as a static page, with the translations swapped in
    the way the room's bundle swaps them in."""
    import shutil

    deck = output / slug
    (deck / "data").mkdir(parents=True, exist_ok=True)
    bundle = build_bundle(
        state=state,
        settings=settings,
        report={},
        project={"anonymize_transcripts": True},
        participant_base_url="",
    )
    bundle = translated_bundle(bundle, state, settings)
    page = render_popcorn_page(embed={"mode": "sample"})
    page = page.replace('<html lang="en">', f'<html lang="{language}">').replace(
        '<meta charset="utf-8">',
        '<meta charset="utf-8"><meta name="robots" content="noindex,nofollow">',
    )
    (deck / "index.html").write_text(page)
    (deck / "data/bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2))
    shutil.copyfile(LOGO_PATH, deck / "logo.png")
    (deck / "illustrations").mkdir(exist_ok=True)
    for name, path in ILLUSTRATIONS.items():
        shutil.copyfile(path, deck / "illustrations" / f"{name}.webp")
    return deck


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--portal-url", action="append", default=[], help="LANG=URL, repeatable")
    parser.add_argument("--reuse", action="store_true", help="translate and export the saved read")
    parser.add_argument(
        "--reanalyse",
        action="store_true",
        help="read the analysis views again over the saved read, into out/analysis-N.json",
    )
    parser.add_argument("--output", type=Path, default=HERE.parent / ".preview")
    args = parser.parse_args()
    fixture = json.loads((HERE / "session.json").read_text())
    portals = {k: tagged_portal_url(v, SLUG) for k, v in (p.split("=", 1) for p in args.portal_url)}
    transcripts = load_corpus()
    read_path = HERE / "out" / "read.json"
    read_path.parent.mkdir(exist_ok=True)
    if args.reanalyse:
        state = json.loads(read_path.read_text())
        by_id = {t["id"]: t for t in transcripts}
        for t in transcripts:
            t["fingerprint"] = T._fingerprint(t["text"] + "\x1f")
            t["window"] = T.model_window(t["text"])
        book = QuoteBook(
            {t["id"]: t["text"] for t in transcripts},
            names=set().union(*(introduced_names(t["text"]) for t in transcripts)),
            existing=state.get("quotes"),
        )
        outcomes: list[str] = []
        fresh = await T._run_analysis_pass([by_id[c] for c in state["order"]], outcomes, book)
        n = len(list((HERE / "out").glob("analysis-*.json"))) + 1
        (HERE / "out" / f"analysis-{n}.json").write_text(
            json.dumps({"fresh": fresh, "quotes": list(book.quotes)}, ensure_ascii=False, indent=1)
        )
        print("\n".join(outcomes))
        return
    if args.reuse and read_path.exists():
        state = json.loads(read_path.read_text())
    else:
        state, outcomes = await read_session(transcripts)
        read_path.write_text(json.dumps(state, ensure_ascii=False, indent=1))
        print("\n".join(outcomes))
    project = {"anonymize_transcripts": True}
    for language in ("en", "es"):
        session = json.loads(json.dumps(state))
        settings = settings_for(fixture, language)
        print(language, "; ".join(await translate(session, settings, project)) or "nothing owed")
        session["demo"] = demo_marking(fixture, language, portals)
        (HERE / "out" / f"state-{language}.json").write_text(
            json.dumps(session, ensure_ascii=False, indent=1)
        )
        (HERE / "out" / f"settings-{language}.json").write_text(
            json.dumps(settings, ensure_ascii=False, indent=1)
        )
        deck = export_deck(f"{SLUG}-{language}", language, session, settings, args.output)
        print(f"exported {deck}/")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
