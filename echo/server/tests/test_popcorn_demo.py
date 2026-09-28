from __future__ import annotations

import json
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

import dembrane.popcorn.service as service
from scripts.popcorn_demo import export, prepare

FIXTURE = Path(__file__).resolve().parents[2] / "demos/example/fixture.json"


def test_default_intro_off_and_bounded_plain_text():
    settings = service.normalize_settings(
        {"intro": {"enabled": True, "title": "a" * 200, "subtitle": "b" * 700}},
        fallback_title="Session",
    )
    assert settings["intro"] == {"enabled": True, "title": "a" * 160, "subtitle": "b" * 600}
    assert not service.default_settings(title="Real session")["intro"]["enabled"]


def test_disclosure_and_notice_default_off_and_bounded():
    defaults = service.default_settings(title="Real session")
    assert defaults["disclosure"] == {
        "enabled": False,
        "text": "",
        "invitation_title": "",
        "invitation_text": "",
    }
    assert defaults["notice"] == {"enabled": False, "text": ""}
    settings = service.normalize_settings(
        {
            "disclosure": {"enabled": True, "text": "x" * 700, "invitation_title": "t" * 200},
            "notice": {"enabled": True, "text": "n" * 200},
        },
        fallback_title="Session",
    )
    assert settings["disclosure"]["text"] == "x" * 600
    assert settings["disclosure"]["invitation_title"] == "t" * 160
    assert settings["notice"] == {"enabled": True, "text": "n" * 160}


def _session(settings, state=None):
    bundle = service.build_bundle(
        state=service.normalize_state(state or service.fresh_state()),
        settings=settings,
        report={},
        project={},
        participant_base_url="",
    )
    return bundle["files"]["session.json"]


def test_any_session_can_show_a_disclosure_and_notice():
    settings = service.default_settings(title="Pilot")
    session = _session(settings)
    assert "disclosure" not in session and "notice" not in session
    settings["disclosure"] = {
        "enabled": True,
        "text": "Recorded and summarised by AI.\nAsk the host to leave anything out.",
        "invitation_title": "",
        "invitation_text": "",
    }
    settings["notice"] = {"enabled": True, "text": "Pilot session"}
    session = _session(settings)
    assert session["disclosure"]["text"].startswith("Recorded and summarised by AI.")
    assert session["notice"] == {"text": "Pilot session"}
    # A switch without words shows nothing.
    settings["notice"] = {"enabled": True, "text": ""}
    settings["disclosure"]["enabled"] = False
    session = _session(settings)
    assert "disclosure" not in session and "notice" not in session


def test_synthetic_demo_shows_its_own_disclosure_and_notice_whatever_the_settings_say():
    state = service.fresh_state()
    state["demo"] = {"synthetic": True, "language": "en"}
    settings = service.default_settings(title="Demo")
    session = _session(settings, state)
    copy = service.SYNTHETIC_COPY["en"]
    assert session["disclosure"] == {
        "text": copy["disclosure"],
        "invitation_title": copy["invitation_title"],
        "invitation_text": copy["invitation_text"],
    }
    assert session["notice"] == {"text": copy["notice"]}
    # The demo's words win; the host's settings are not read for these.
    state["demo"]["disclosure"] = {
        "text": "Invented for this preview.",
        "invitation_title": "Listen with us",
    }
    state["demo"]["notice"] = {"text": "Fictional example"}
    settings["disclosure"] = {
        "enabled": False,
        "text": "Nothing to see here.",
        "invitation_title": "",
        "invitation_text": "",
    }
    settings["notice"] = {"enabled": False, "text": ""}
    session = _session(settings, state)
    assert session["disclosure"] == {
        "text": "Invented for this preview.",
        "invitation_title": "Listen with us",
        "invitation_text": "",
    }
    assert session["notice"] == {"text": "Fictional example"}


def test_a_host_cannot_edit_a_synthetic_demos_disclosure_or_frame(monkeypatch):
    import fastapi

    import dembrane.api.v2.bff.popcorn as bff

    fixture = json.loads(FIXTURE.read_text())
    state, _settings = prepare(fixture, "https://portal.example.test/nl-NL/sales/start")
    updates = []

    class Access:
        tier = "changemaker"

        def require(self, _scope):
            pass

    async def require_popcorn(_popcorn_id, _auth):
        return {"id": "r"}, Access()

    async def loop_for(_report_id):
        return {"popcorn_state": state}

    async def update(**kwargs):
        updates.append(kwargs["patch"])

    monkeypatch.setattr(bff, "_require_popcorn", require_popcorn)
    monkeypatch.setattr(bff, "get_loop_for_report", loop_for)
    monkeypatch.setattr(bff, "update_settings", update)
    for body in ({"notice": {"text": "real"}}, {"disclosure": {"enabled": False}}):
        try:
            asyncio.run(bff.patch_popcorn_settings("r", bff.PopcornSettingsBody(**body), auth=None))
        except fastapi.HTTPException as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("a synthetic demo's wording was editable")
    assert updates == []


def test_intro_partial_patch_keeps_copy(monkeypatch):
    saved = service.default_settings(title="Session")
    saved["intro"] = {"enabled": True, "title": "Welcome", "subtitle": "Listen together"}
    writes = []

    async def config(_report_id):
        return {"id": "c", "popcorn_settings": saved}

    async def update(collection, item_id, payload):
        writes.append(payload)
        return {"data": payload}

    async def publish(_report_id):
        pass

    class _Held:
        async def still_held(self) -> bool:
            return True

    @asynccontextmanager
    async def settings_lock(_report_id):
        yield _Held()

    monkeypatch.setattr(service, "get_latest_config", config)
    monkeypatch.setattr(service, "settings_write_lock", settings_lock)
    monkeypatch.setattr(service.async_directus, "update_item", update)
    import dembrane.canvas.events as events

    monkeypatch.setattr(events, "publish_generation_nudge", publish)
    asyncio.run(
        service.update_settings(
            report={"id": "r", "user_instructions": "Session"},
            patch={"intro": {"enabled": False}, "notice": {"enabled": True}},
        )
    )
    assert writes[0]["popcorn_settings"]["intro"] == {
        "enabled": False,
        "title": "Welcome",
        "subtitle": "Listen together",
    }
    assert writes[0]["popcorn_settings"]["notice"] == {"enabled": True, "text": ""}


def test_synthetic_provenance_survives_normalisation_and_hidden_intro():
    fixture = json.loads(FIXTURE.read_text())
    state, settings = prepare(fixture, "https://portal.example.test/nl-NL/sales/start")
    settings["intro"]["enabled"] = False
    bundle = service.build_bundle(
        state=service.normalize_state(state),
        settings=settings,
        report={},
        project={"id": "real", "is_conversation_allowed": True},
        participant_base_url="https://portal.example.test",
    )
    files = bundle["files"]
    session = files["session.json"]
    assert session["disclosure"]["text"] == fixture["disclosure"]
    assert session["disclosure"]["invitation_text"] == fixture["invitation_text"]
    assert session["notice"] == {"text": fixture["notice"]}
    assert session["demo"]["synthetic"] is True
    assert session["demo"]["public_sources_only"] is True
    # The QR opens the sales portal, never the real project's own portal.
    assert session["qr"]["url"] == (
        "https://portal.example.test/nl-NL/sales/start"
        "?utm_source=popcorn_demo&utm_campaign=voorbeeldwonen"
    )
    assert len(session["transcripts"]) == 5
    phrases = [
        item for key, file in files.items() if key.startswith("popcorn/") for item in file["items"]
    ]
    assert len(phrases) == 30
    # Provenance stays in the data; the deck itself reads like a real run.
    assert all(item["synthetic"] and item["verbatim"] for item in phrases)
    quotes = {q["id"] for q in files["quotes.json"]["quotes"]}
    assert {item["quoteId"] for item in phrases} == quotes
    assert all(files[f"popcorn/{t['id']}.json"]["validated"] for t in session["transcripts"])
    tensions = files["tensions.json"]
    stakeholders = files["stakeholders.json"]
    assert tensions["synthetic"] and stakeholders["synthetic"]
    cited = [q for t in tensions["tensions"] for q in t["quoteIds"]]
    cited += [q for s in stakeholders["stakeholders"] for q in s["quoteIds"]]
    cited += [q for r in stakeholders["relations"] for a in r["aspects"] for q in a["quoteIds"]]
    assert cited and set(cited) <= quotes
    assert all(s["evidence"]["rung"] != "inferred" for s in stakeholders["stakeholders"])
    assert service.room_files(files, neutral_labels=True)["session.json"]["demo"] == session["demo"]


def test_export_is_read_only_and_does_not_publish_raw_transcripts(tmp_path):
    fixture = json.loads(FIXTURE.read_text())
    state, settings = prepare(
        fixture,
        {
            "nl": "https://portal.example.test/nl-NL/sales/start",
            "en": "https://portal.example.test/en-US/sales/start?x=1",
        },
    )
    assert state["demo"]["portal_urls"]["en"].endswith(
        "?x=1&utm_source=popcorn_demo&utm_campaign=voorbeeldwonen"
    )
    # The QR speaks the screen's language: the English portal for an English screen.
    for ui, lang, label in (
        ("auto", "nl", "Feedback voor dembrane"),
        ("en", "en", "Feedback for dembrane"),
    ):
        settings["language"] = {"ui": ui, "translate_to": ""}
        qr = service.build_bundle(
            state=state, settings=settings, report={}, project={}, participant_base_url=""
        )["files"]["session.json"]["qr"]
        assert qr == {**qr, "url": state["demo"]["portal_urls"][lang], "label": label}
    settings["language"] = {"ui": "auto", "translate_to": ""}
    export(fixture, state, settings, tmp_path)
    deck = tmp_path / "voorbeeldwonen"
    assert not (deck / "join").exists()
    page = (deck / "index.html").read_text()
    assert '"mode": "sample"' in page
    assert "noindex,nofollow" in page
    assert (
        "SYNTHETISCHE DEMO. Volledig verzonnen gesprek."
        not in (deck / "data/bundle.json").read_text()
    )
    assert not (tmp_path / "local-session.json").exists()


def test_sales_portal_is_an_open_project_that_asks_for_feedback(monkeypatch):
    import scripts.popcorn_demo as demo

    writes = []

    async def upsert(collection, item_id, payload):
        writes.append((collection, item_id, payload))
        return payload

    monkeypatch.setattr(demo, "upsert", upsert)
    pid = asyncio.run(demo.seed_sales_portal("nl", "ws", "owner"))
    [(collection, item_id, payload)] = writes
    assert (collection, item_id) == ("project", pid)
    assert payload["is_conversation_allowed"] is True
    assert payload["language"] == "nl"
    # dembrane collects this feedback itself.
    assert payload["legal_basis"] == "dembrane-events"
    assert "demo" in payload["default_conversation_title"]
    assert "feedback" in payload["default_conversation_description"]
    assert demo.sales_portal_url("http://localhost:5174/", pid, "nl") == (
        f"http://localhost:5174/nl-NL/{pid}/start"
    )


def test_data_screen_follows_anonymisation_and_legal_basis():
    settings = service.default_settings(title="Session")
    assert "data" not in _session(settings)
    settings["data"] = {"enabled": True}

    def data_for(project):
        return service.build_bundle(
            state=service.fresh_state(),
            settings=settings,
            report={},
            project=project,
            participant_base_url="",
        )["files"]["session.json"]["data"]

    anon = data_for({"anonymize_transcripts": True, "language": "nl", "legal_basis": "consent"})
    copy = service.DATA_COPY["nl"]
    assert [step["image"] for step in anon["steps"]] == ["scan", "talk-anon", "understand"]
    assert anon["steps"][1]["text"] == copy["talk-anon"]
    assert anon["notes"][0] == copy["legal"]["consent"]
    # A consent session without a valid policy link names no policy.
    assert [link["url"] for link in anon["links"]] == ["https://dembrane.com/nl/trust"]

    public = data_for(
        {
            "language": "en-US",
            "legal_basis": "consent",
            "privacy_policy_url": "https://example.org/privacy",
        }
    )
    assert public["steps"][1]["image"] == "talk-public"
    assert public["links"][0] == {
        "url": "https://example.org/privacy",
        "label": service.DATA_COPY["en"]["policy"],
    }
    # An unresolved project reads as the platform default.
    assert data_for({})["notes"][0] == service.DATA_COPY["en"]["legal"]["client-managed"]
    events = data_for({"legal_basis": "dembrane-events", "privacy_policy_url": "https://x.test"})
    assert events["notes"][0] == service.DATA_COPY["en"]["legal"]["dembrane-events"]
    assert len(events["links"]) == 1


def test_effective_legal_basis_is_resolved_only_for_the_data_screen(monkeypatch):
    import dembrane.popcorn.bundle as bundle
    from dembrane.legal_basis import CascadeRows

    calls = []

    async def rows(project):
        calls.append(project["id"])
        return CascadeRows(
            workspace={"legal_basis": "consent", "privacy_policy_url": "https://w.test/p"},
            org=None,
            owner=None,
        )

    monkeypatch.setattr(bundle, "fetch_cascade_rows", rows)
    project = {"id": "p1", "legal_basis": None}
    off = asyncio.run(bundle.with_effective_legal_basis(project, {"data": {"enabled": False}}))
    assert off is project and calls == []
    on = asyncio.run(bundle.with_effective_legal_basis(project, {"data": {"enabled": True}}))
    assert on["legal_basis"] == "consent" and on["privacy_policy_url"] == "https://w.test/p"


def test_a_demo_needs_a_sales_portal_in_its_own_language():
    import pytest

    fixture = json.loads(FIXTURE.read_text())
    with pytest.raises(ValueError, match="own language"):
        prepare(fixture, {"en": "https://portal.example.test/en-US/sales/start"})
    with pytest.raises(ValueError, match="portal URL"):
        prepare(fixture, "javascript:alert(1)")
