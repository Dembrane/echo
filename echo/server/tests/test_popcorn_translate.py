from __future__ import annotations

import json
import asyncio
from pathlib import Path

import dembrane.popcorn.ticks as ticks
import dembrane.popcorn.service as service
from scripts.popcorn_demo import prepare
from dembrane.popcorn.translate import text_key, missing_texts, translated_bundle

FIXTURE = Path(__file__).resolve().parents[2] / "demos/deltawonen/fixture.json"


def _demo():
    fixture = json.loads(FIXTURE.read_text())
    return fixture, *prepare(fixture, "https://portal.example.test/nl-NL/sales/start")


def _bundle(state, settings, project=None):
    return service.build_bundle(
        state=state, settings=settings, report={}, project=project or {}, participant_base_url=""
    )


def test_language_settings_default_to_the_original_and_reject_unknown_codes():
    assert service.default_settings(title="S")["language"] == {"ui": "auto", "translate_to": ""}
    settings = service.normalize_settings(
        {"language": {"ui": "xx", "translate_to": "klingon"}}, fallback_title="S"
    )
    assert settings["language"] == {"ui": "auto", "translate_to": ""}
    settings = service.normalize_settings(
        {"language": {"ui": "de", "translate_to": "en"}}, fallback_title="S"
    )
    assert settings["language"] == {"ui": "de", "translate_to": "en"}


def test_screen_language_follows_the_project_unless_the_host_picks_one():
    settings = service.default_settings(title="S")
    state = service.fresh_state()
    session = _bundle(state, settings, {"language": "nl-NL"})["files"]["session.json"]
    assert session["language"] == "nl"
    assert session["date_iso"]
    assert _bundle(state, settings, {"language": "pt"})["files"]["session.json"]["language"] == "en"
    settings["language"] = {"ui": "fr", "translate_to": ""}
    assert _bundle(state, settings, {"language": "nl"})["files"]["session.json"]["language"] == "fr"
    _, demo_state, demo_settings = _demo()
    demo_session = _bundle(demo_state, demo_settings)["files"]["session.json"]
    assert demo_session["language"] == "nl"
    assert demo_session["data"]["title"] == service.DATA_COPY["nl"]["title"]
    # Automatic follows a requested translation, and the data screen with it.
    demo_settings["language"] = {"ui": "auto", "translate_to": "en"}
    demo_session = _bundle(demo_state, demo_settings)["files"]["session.json"]
    assert demo_session["language"] == "en"
    assert demo_session["data"]["title"] == service.DATA_COPY["en"]["title"]


def test_results_stay_original_until_translated_and_say_what_is_pending():
    _, state, settings = _demo()
    bundle = _bundle(state, settings)
    assert translated_bundle(bundle, state, settings) is bundle
    assert "translation" not in bundle["files"]["session.json"]

    settings["language"] = {"ui": "auto", "translate_to": "en"}
    files = bundle["files"]
    texts = missing_texts(files, {})
    assert "Geluk begint als je thuis op adem kunt komen" in texts
    assert "Bewoners" in texts and "Vandaag betaalbaar wonen" in texts
    # Conversation labels are names, not results.
    assert not any(t.startswith("Tafel ") for t in texts)

    state["translations"] = {"en": {text_key("Bewoners"): "Residents"}}
    state = service.normalize_state(state)
    out = translated_bundle(bundle, state, settings)["files"]
    assert out["stakeholders.json"]["stakeholders"][0]["name"] == "Residents"
    assert out["session.json"]["translation"] == {"to": "en", "pending": len(texts) - 1}
    # The untranslated rest shows in the original, and the source bundle is untouched.
    assert out["tensions.json"]["tensions"][0]["poleA"] == "Vandaag betaalbaar wonen"
    assert files["stakeholders.json"]["stakeholders"][0]["name"] == "Bewoners"


def test_a_tick_translates_what_the_room_sees_and_keeps_only_current_texts(monkeypatch):
    _, state, settings = _demo()
    settings["language"] = {"ui": "auto", "translate_to": "en"}
    state["translations"] = {"en": {"stale": "gone"}}

    async def room_bundle(**kwargs):
        return _bundle(kwargs["state"], kwargs["settings"])

    asked: list[list[str]] = []

    async def translate(texts, target):
        asked.append(texts)
        assert target == "en"
        return [None if i == 0 else f"EN {t}" for i, t in enumerate(texts)]

    monkeypatch.setattr(ticks, "_room_bundle", room_bundle)
    monkeypatch.setattr(ticks, "translate_texts", translate)
    detail = asyncio.run(ticks._translate_session(state, settings, report_id="r", project_id="p"))
    table = state["translations"]["en"]
    assert "stale" not in table
    assert detail == f"translated {len(asked[0]) - 1} of {len(asked[0])} texts into en"
    # The one the model left out is asked for again, and only that one.
    asyncio.run(ticks._translate_session(state, settings, report_id="r", project_id="p"))
    assert asked[1] == [asked[0][0]]


def test_the_demo_is_stamped_like_a_tick_so_a_read_leaves_it_alone():
    fixture, state, settings = _demo()
    host_note = service.voice_host_note(settings.get("voice"))
    prints = [
        ticks._fingerprint(c["transcript"].strip() + "\x1f" + host_note)
        for c in fixture["conversations"]
    ]
    assert [state["conversations"][cid]["fingerprint"] for cid in state["order"]] == prints
    read = ticks._fingerprint(
        "|".join(f"{cid}:{fp}" for cid, fp in zip(state["order"], prints, strict=True))
    )
    assert ticks._stale_views(state, read) == []
    transcripts = [
        {"id": cid, "fingerprint": fp} for cid, fp in zip(state["order"], prints, strict=True)
    ]
    assert ticks._pending_enrichment(state, transcripts) == []
