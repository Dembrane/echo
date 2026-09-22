from __future__ import annotations

import json
import asyncio
from pathlib import Path

import pytest

import dembrane.popcorn.ticks as ticks
import dembrane.popcorn.service as service
from scripts.popcorn_demo import prepare
from dembrane.popcorn.translate import (
    TRANSLATION_POLICY_VERSION,
    cache_key,
    missing_texts,
    popcorn_texts,
    target_languages,
    translated_bundle,
    translatable_texts,
)

FIXTURE = Path(__file__).resolve().parents[2] / "demos/example/fixture.json"


def _demo():
    fixture = json.loads(FIXTURE.read_text())
    return fixture, *prepare(fixture, "https://portal.example.test/nl-NL/sales/start")


def _bundle(state, settings, project=None):
    return service.build_bundle(
        state=state, settings=settings, report={}, project=project or {}, participant_base_url=""
    )


def test_language_settings_default_to_the_original_and_reject_unknown_codes():
    assert service.default_settings(title="S")["language"] == {
        "ui": "auto",
        "translate_to": "",
        "also": [],
    }
    settings = service.normalize_settings(
        {"language": {"ui": "xx", "translate_to": "klingon"}}, fallback_title="S"
    )
    assert settings["language"] == {"ui": "auto", "translate_to": "", "also": []}
    settings = service.normalize_settings(
        {"language": {"ui": "de", "translate_to": "en"}}, fallback_title="S"
    )
    assert settings["language"] == {"ui": "de", "translate_to": "en", "also": []}


def test_extra_popcorn_languages_are_deduplicated_capped_and_never_the_first():
    language = service.normalize_language(
        {"translate_to": "en", "also": ["fr", "fr", "en", "klingon", "de", "es", "it"]}
    )
    # In the host's order, without the one the results are already in, and no
    # more than the deck can pop through.
    assert language["also"] == ["fr", "de", "es"]
    assert service.MAX_ALSO_LANGUAGES == 3
    # A patch replaces the whole list and leaves the rest of the block alone.
    merged = service.merge_settings(
        service.normalize_settings(
            {"language": {"ui": "nl", "translate_to": "en", "also": ["fr", "de"]}},
            fallback_title="S",
        ),
        {"language": {"also": ["es"]}},
        fallback_title="S",
    )
    assert merged["language"] == {"ui": "nl", "translate_to": "en", "also": ["es"]}


def test_the_targets_are_the_first_language_then_the_extra_ones():
    assert target_languages({}) == []
    # Extra languages without one for the results have nothing to follow.
    assert target_languages({"language": {"translate_to": "", "also": ["fr"]}}) == []
    settings = service.normalize_settings(
        {"language": {"translate_to": "en", "also": ["fr", "de"]}}, fallback_title="S"
    )
    assert target_languages(settings) == ["en", "fr", "de"]
    # The project policy owns the first language; the extra ones pass through.
    settings["presentation"] = service.normalize_presentation({"language_policy": "project"})
    assert service.translation_targets(settings, {"language": "nl-NL"}) == ["nl", "fr", "de"]
    # And the project's own language is never asked for twice.
    assert service.translation_targets(settings, {"language": "fr"}) == ["fr", "de"]


def test_an_extra_language_is_asked_for_the_popcorn_phrases_alone():
    _, state, settings = _demo()
    files = _bundle(state, settings)["files"]
    phrases = popcorn_texts(files)
    assert "Geluk begint als je thuis op adem kunt komen" in phrases
    # Tensions, stakeholders and quotes stay with the first language.
    assert "Bewoners" not in phrases and "Vandaag betaalbaar wonen" not in phrases
    assert phrases == list(dict.fromkeys(phrases))
    assert set(phrases) <= set(translatable_texts(files))


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

    state["translations"] = {"en": {cache_key("Bewoners", "en"): "Residents"}}
    state = service.normalize_state(state)
    out = translated_bundle(bundle, state, settings)["files"]
    assert out["stakeholders.json"]["stakeholders"][0]["name"] == "Residents"
    assert out["session.json"]["translation"] == {
        "to": "en",
        "also": [],
        "policy": TRANSLATION_POLICY_VERSION,
        "pending": len(texts) - 1,
    }
    # The untranslated rest shows in the original, and the source bundle is untouched.
    assert out["tensions.json"]["tensions"][0]["poleA"] == "Vandaag betaalbaar wonen"
    assert files["stakeholders.json"]["stakeholders"][0]["name"] == "Bewoners"


def test_popcorn_keeps_original_and_attaches_translation_to_the_same_identity():
    _, state, settings = _demo()
    settings["language"] = {"ui": "auto", "translate_to": "en"}
    bundle = _bundle(state, settings)
    name = next(name for name in bundle["files"] if name.startswith("popcorn/"))
    source = bundle["files"][name]["items"][0]
    answer = "Happiness begins when you can breathe at home"
    state["translations"] = {
        "en": {cache_key(source["phrase"], "en"): answer},
    }

    item = translated_bundle(bundle, state, settings)["files"][name]["items"][0]
    assert item["id"] == source["id"]
    assert item["phrase"] == source["phrase"]
    assert item["translation"] == answer
    assert item["translation_language"] == "en"
    assert item["translation_policy"] == TRANSLATION_POLICY_VERSION
    assert item["translation_ref"]["item_id"] == source["id"]


def test_a_phrase_stacks_every_language_the_host_asked_for_in_order():
    _, state, settings = _demo()
    settings["language"] = {"ui": "auto", "translate_to": "en", "also": ["fr", "de"]}
    bundle = _bundle(state, settings)
    name = next(name for name in bundle["files"] if name.startswith("popcorn/"))
    source = bundle["files"][name]["items"][0]["phrase"]
    state["translations"] = {
        "en": {cache_key(source, "en"): "Happiness begins at home"},
        # French came back as the source wording, German has not landed yet.
        "fr": {cache_key(source, "fr"): source},
    }

    files = translated_bundle(bundle, state, settings)["files"]
    item = files[name]["items"][0]
    assert item["translations"] == [{"language": "en", "text": "Happiness begins at home"}]
    # The standalone deck's own fields stay the first language's, untouched.
    assert item["translation"] == "Happiness begins at home"
    assert item["translation_language"] == "en"
    assert item["translation_policy"] == TRANSLATION_POLICY_VERSION

    state["translations"]["fr"] = {cache_key(source, "fr"): "Le bonheur commence à la maison"}
    state["translations"]["de"] = {cache_key(source, "de"): "Glück beginnt zu Hause"}
    item = translated_bundle(bundle, state, settings)["files"][name]["items"][0]
    assert [t["language"] for t in item["translations"]] == ["en", "fr", "de"]
    assert item["translation"] == "Happiness begins at home"
    session = translated_bundle(bundle, state, settings)["files"]["session.json"]
    assert session["translation"]["to"] == "en"
    assert session["translation"]["also"] == ["fr", "de"]
    # One phrase answered in each extra language; the rest is still owed.
    phrases = popcorn_texts(bundle["files"])
    assert session["translation"]["pending"] == (
        len(missing_texts(bundle["files"], state["translations"]["en"], "en"))
        + 2 * (len(phrases) - 1)
    )


def test_a_tick_translates_what_the_room_sees_and_keeps_only_current_texts(monkeypatch):
    _, state, settings = _demo()
    settings["language"] = {"ui": "auto", "translate_to": "en"}
    state["translations"] = {"en": {"stale": "gone"}}

    async def room_bundle(**kwargs):
        return _bundle(kwargs["state"], kwargs["settings"])

    asked: list[list[str]] = []

    async def translate(texts, target, *, on_batch=None):
        asked.append(texts)
        assert target == "en"
        answers = [None if i == 0 else f"EN {t}" for i, t in enumerate(texts)]
        if on_batch:
            await on_batch(texts, answers)
        return answers

    monkeypatch.setattr(ticks, "_room_bundle", room_bundle)
    monkeypatch.setattr(ticks, "translate_texts", translate)
    detail = asyncio.run(ticks._translate_session(state, settings, report_id="r", project_id="p"))
    table = state["translations"]["en"]
    assert "stale" not in table
    assert detail == f"translated {len(asked[0]) - 1} of {len(asked[0])} texts into en"
    # The one the model left out is asked for again, and only that one.
    asyncio.run(ticks._translate_session(state, settings, report_id="r", project_id="p"))
    assert asked[1] == [asked[0][0]]


class _Flushes:
    """The tick's writer, counting what reached the room and when."""

    def __init__(self, state):
        self.state = state
        self.writes: list[dict[str, dict[str, str]]] = []

    async def flush(self) -> None:
        self.writes.append(
            {lang: dict(table) for lang, table in (self.state.get("translations") or {}).items()}
        )


def _stacked(monkeypatch, answer=lambda target, text: f"{target.upper()} {text}"):
    """A session translated into en and fr, one batch per two texts."""
    _, state, settings = _demo()
    settings["language"] = {"ui": "auto", "translate_to": "en", "also": ["fr"]}

    async def room_bundle(**kwargs):
        return _bundle(kwargs["state"], kwargs["settings"])

    asked: list[tuple[str, list[str]]] = []

    async def translate(texts, target, *, on_batch=None):
        asked.append((target, list(texts)))
        answers = [answer(target, text) for text in texts]
        if on_batch:
            for start in range(0, len(texts), 2):
                await on_batch(texts[start : start + 2], answers[start : start + 2])
        return answers

    monkeypatch.setattr(ticks, "_room_bundle", room_bundle)
    monkeypatch.setattr(ticks, "translate_texts", translate)
    return state, settings, asked


def test_an_extra_language_gets_the_phrases_only_and_lands_batch_by_batch(monkeypatch):
    state, settings, asked = _stacked(monkeypatch)
    writer = _Flushes(state)
    detail = asyncio.run(
        ticks._translate_session(state, settings, report_id="r", project_id="p", writer=writer)
    )
    everything, phrases = [texts for _target, texts in asked]
    assert [target for target, _texts in asked] == ["en", "fr"]
    assert phrases == popcorn_texts(_bundle(state, settings)["files"])
    assert len(phrases) < len(everything)
    assert detail == (
        f"translated {len(everything)} of {len(everything)} texts into en; "
        f"{len(phrases)} of {len(phrases)} texts into fr"
    )
    # Each batch is written as it lands, so the room reads French while the
    # rest is still on its way.
    assert len(writer.writes) == -(-len(everything) // 2) + -(-len(phrases) // 2)
    first_french = next(write for write in writer.writes if write.get("fr"))
    assert len(first_french["en"]) == len(everything)
    assert len(first_french["fr"]) <= 2
    assert set(state["translations"]) == {"en", "fr"}


def test_a_translation_job_names_the_language_that_came_up_short(monkeypatch):
    state, settings, asked = _stacked(
        monkeypatch, answer=lambda target, text: None if target == "fr" else f"EN {text}"
    )
    with pytest.raises(ticks.TranslationIncomplete) as raised:
        asyncio.run(
            ticks._translate_session(
                state, settings, report_id="r", project_id="p", require_complete=True
            )
        )
    phrases = popcorn_texts(_bundle(state, settings)["files"])
    assert f"0 of {len(phrases)} texts into fr" in str(raised.value)
    assert f"{len(phrases)} not translated into fr" in str(raised.value)
    assert "not translated into en" not in str(raised.value)
    # What did land is saved, so the retry asks each language for its own rest.
    asked.clear()

    async def translate(texts, target, *, on_batch=None):
        asked.append((target, list(texts)))
        answers = [f"{target.upper()} {text}" for text in texts]
        if on_batch:
            await on_batch(texts, answers)
        return answers

    monkeypatch.setattr(ticks, "translate_texts", translate)
    detail = asyncio.run(
        ticks._translate_session(
            state, settings, report_id="r", project_id="p", require_complete=True
        )
    )
    answered = dict(asked)
    assert "en" not in answered
    assert answered["fr"] == phrases
    assert detail == f"translated {len(phrases)} of {len(phrases)} texts into fr"


def test_a_new_extra_language_dispatches_the_translation_tick(monkeypatch):
    dispatched: list[tuple[str, str]] = []

    async def loop(report_id):  # noqa: ARG001
        return {"id": "loop1"}

    async def dispatch(loop_id, tick_kind):
        dispatched.append((loop_id, tick_kind))

    monkeypatch.setattr(service, "get_loop_for_report", loop)
    monkeypatch.setattr(service, "dispatch_popcorn_tick_now_with_safety", dispatch)

    def _settings(also):
        return service.normalize_settings(
            {"language": {"translate_to": "en", "also": also}}, fallback_title="S"
        )

    def _retarget(before, after):
        return asyncio.run(
            service.retarget_translation(
                {"id": "r"}, before=before, after=after, project={"id": "p", "language": "nl"}
            )
        )

    # Only the extra languages changed: the phrases still have to be asked for.
    assert _retarget(_settings([]), _settings(["fr"])) is True
    assert dispatched == [("loop1", "translation")]
    # Nothing changed, and a reorder asks for nothing new.
    assert _retarget(_settings(["fr"]), _settings(["fr"])) is False
    assert _retarget(_settings(["fr", "de"]), _settings(["de", "fr"])) is False
    assert dispatched == [("loop1", "translation")]


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
