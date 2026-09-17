"""The participant API feeds the concurrent recording meter: initiate and
recording pings record presence and observe the count, finishing refreshes,
left/finished/finish/delete close, text never counts. Nothing is refused."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks

import dembrane.api.participant as participant
from dembrane.free_tier import BillingContext

CTX = BillingContext(account_id="b1", account_name="Acme", tier="free", cap=10, workspace_id="w1")


def _run(coro: Any) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


class _FakeRequest:
    def __init__(self) -> None:
        self.headers: dict[str, str] = {}
        self.client = SimpleNamespace(host="203.0.113.1")


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    async def _allow(_id: str) -> bool:
        return True

    monkeypatch.setattr(participant._conversation_ping_rate_limiter, "allow", _allow)

    async def _noop(*a: Any, **k: Any) -> None:
        return None

    monkeypatch.setattr(participant, "mark_conversation_seen", _noop)
    monkeypatch.setattr(participant, "register_active_conversation", _noop)
    monkeypatch.setattr(participant, "link_visitor_conversation", _noop)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _noop)


@pytest.fixture
def meter(monkeypatch):
    calls = {
        "presence": [],
        "refresh": [],
        "close": [],
        "observe": [],
        "registered": [],
        "negative": [],
        "looked_up": [],
        "ctx": CTX,
        "count": 3,
        "known": "b1",
        # The conversation row _verify_and_register would find, None to raise.
        "conversation": None,
    }

    async def resolve(project_id: str) -> Optional[BillingContext]:
        return calls["ctx"]

    async def presence(account_id: str, conversation_id: str) -> int:
        calls["presence"].append((account_id, conversation_id))
        return calls["count"]

    async def refresh(account_id: str, conversation_id: str) -> None:
        calls["refresh"].append((account_id, conversation_id))

    async def close(account_id: str, conversation_id: str) -> None:
        calls["close"].append((account_id, conversation_id))

    async def observe(ctx, count, conversation_id, project_id) -> None:
        calls["observe"].append((ctx.account_id, count, conversation_id, project_id))

    async def register(account_id: str, conversation_id: str) -> None:
        calls["registered"].append((account_id, conversation_id))

    async def account_for(conversation_id: str) -> Optional[str]:
        return calls["known"]

    monkeypatch.setattr(participant, "resolve_project_billing_context", resolve)
    monkeypatch.setattr(participant, "record_presence", presence)
    monkeypatch.setattr(participant, "refresh_if_present", refresh)
    monkeypatch.setattr(participant, "close_session", close)
    monkeypatch.setattr(participant, "observe", observe)
    monkeypatch.setattr(participant, "register_conversation", register)

    async def register_negative(conversation_id: str) -> None:
        calls["negative"].append(conversation_id)

    def get_by_id_or_raise(conversation_id: str, **_k: Any) -> dict:
        calls["looked_up"].append(conversation_id)
        if calls["conversation"] is None:
            raise ValueError("conversation not found")
        return calls["conversation"]

    monkeypatch.setattr(participant, "account_for_conversation", account_for)
    monkeypatch.setattr(participant, "register_negative", register_negative)
    monkeypatch.setattr(participant.conversation_service, "get_by_id_or_raise", get_by_id_or_raise)
    return calls


def _body(**o: Any) -> participant.InitiateConversationRequestBodySchema:
    d = {"name": "Ada", "pin": "", "source": "PORTAL_AUDIO"}
    d.update(o)
    return participant.InitiateConversationRequestBodySchema(**d)


@pytest.fixture
def created(monkeypatch):
    calls: list[dict] = []

    def create(**kwargs: Any) -> dict:
        calls.append(kwargs)
        return {"id": "conv-1", "project_id": kwargs["project_id"]}

    monkeypatch.setattr(participant.conversation_service, "create", create)
    import dembrane.api.conversation as conv_api

    async def _inv(_cid: str) -> None:
        return None

    monkeypatch.setattr(conv_api, "_invalidate_usage_cache_for_conversation", _inv)
    return calls


def test_initiate_creates_then_records_and_observes(meter, created) -> None:
    bg = BackgroundTasks()
    out = _run(participant.initiate_conversation(_body(), "p1", bg))
    assert out["id"] == "conv-1"
    assert "conversation_id" not in created[0]
    # Metering runs after the response, not during it.
    assert meter["presence"] == []
    _run(bg())
    assert meter["registered"] == [("b1", "conv-1")]
    assert meter["presence"] == [("b1", "conv-1")]
    assert meter["observe"] == [("b1", 3, "conv-1", "p1")]


def test_initiate_registers_before_recording_presence(meter, created) -> None:
    # An unknown conversation stays unknown until initiate claims it.
    meter["known"] = None
    bg = BackgroundTasks()
    _run(participant.initiate_conversation(_body(), "p1", bg))
    _run(bg())
    assert meter["registered"] == [("b1", "conv-1")]
    assert meter["presence"] == [("b1", "conv-1")]


def test_initiate_text_never_counts(meter, created) -> None:
    bg = BackgroundTasks()
    _run(participant.initiate_conversation(_body(source="PORTAL_TEXT"), "p1", bg))
    assert bg.tasks == []
    _run(bg())
    assert meter["presence"] == [] and meter["observe"] == []


def test_initiate_without_billing_context_is_not_measured(meter, created) -> None:
    meter["ctx"] = None
    bg = BackgroundTasks()
    _run(participant.initiate_conversation(_body(), "p1", bg))
    _run(bg())
    assert meter["presence"] == [] and meter["registered"] == []


def test_initiate_closed_project_still_403(meter, created, monkeypatch) -> None:
    from fastapi import HTTPException

    from dembrane.service.conversation import ConversationNotOpenForParticipationException

    def boom(**kwargs: Any) -> dict:
        raise ConversationNotOpenForParticipationException()

    monkeypatch.setattr(participant.conversation_service, "create", boom)
    with pytest.raises(HTTPException) as exc:
        _run(participant.initiate_conversation(_body(), "p1", BackgroundTasks()))
    assert exc.value.status_code == 403
    assert meter["presence"] == []


def _ping(**f: Any) -> participant.ConversationPingRequest:
    return participant.ConversationPingRequest(**f)


def test_recording_ping_records_and_observes(meter) -> None:
    out = _run(
        participant.ping_conversation(
            "c1", _FakeRequest(), _ping(project_id="p1", mode="voice", state="recording")
        )
    )
    assert out == {"ok": True}
    assert meter["presence"] == [("b1", "c1")]
    assert meter["observe"] == [("b1", 3, "c1", "p1")]


def test_ping_for_an_unregistered_conversation_records_nothing(meter) -> None:
    meter["known"] = None
    out = _run(
        participant.ping_conversation(
            "ghost", _FakeRequest(), _ping(project_id="p1", mode="voice", state="recording")
        )
    )
    assert out == {"ok": True}
    assert meter["presence"] == [] and meter["observe"] == []


def _recording_ping(conversation_id: str = "c1") -> Any:
    return _run(
        participant.ping_conversation(
            conversation_id,
            _FakeRequest(),
            _ping(project_id="p1", mode="voice", state="recording"),
        )
    )


def test_ping_recovers_a_lost_mapping(meter) -> None:
    # The mapping expired or its write failed; the conversation is genuine.
    meter["known"] = None
    meter["conversation"] = {
        "id": "c1",
        "project_id": "p1",
        "deleted_at": None,
        "source": "PORTAL_AUDIO",
    }
    assert _recording_ping() == {"ok": True}
    assert meter["registered"] == [("b1", "c1")]
    assert meter["presence"] == [("b1", "c1")]
    assert meter["observe"] == [("b1", 3, "c1", "p1")]
    assert meter["negative"] == []


@pytest.mark.parametrize("source", ["PORTAL_TEXT", "DASHBOARD_UPLOAD", None])
def test_ping_only_recovers_portal_audio_conversations(meter, source) -> None:
    # Initiate registers audio only, so nothing else is a recording we metered.
    meter["known"] = None
    row = {"id": "c1", "project_id": "p1", "deleted_at": None}
    if source is not None:
        row["source"] = source
    meter["conversation"] = row
    assert _recording_ping() == {"ok": True}
    assert meter["negative"] == ["c1"]
    assert meter["registered"] == [] and meter["presence"] == []
    assert meter["observe"] == []


def test_ping_for_a_conversation_in_another_project_is_marked_absent(meter) -> None:
    meter["known"] = None
    meter["conversation"] = {"id": "c1", "project_id": "p2", "deleted_at": None}
    assert _recording_ping() == {"ok": True}
    assert meter["negative"] == ["c1"]
    assert meter["registered"] == [] and meter["presence"] == []


def test_ping_for_a_deleted_conversation_is_marked_absent(meter) -> None:
    meter["known"] = None
    meter["conversation"] = {"id": "c1", "project_id": "p1", "deleted_at": "2026-09-01"}
    _recording_ping()
    assert meter["negative"] == ["c1"] and meter["presence"] == []


def test_ping_for_a_fabricated_id_is_marked_absent(meter) -> None:
    meter["known"] = None  # lookup raises: the id does not exist
    assert _recording_ping("ghost") == {"ok": True}
    assert meter["negative"] == ["ghost"]
    assert meter["presence"] == [] and meter["observe"] == []


def test_negative_mapping_costs_no_lookup(meter) -> None:
    meter["known"] = participant.NEGATIVE_MARKER
    assert _recording_ping("ghost") == {"ok": True}
    assert meter["looked_up"] == []
    assert meter["presence"] == [] and meter["negative"] == []


def test_ping_for_another_accounts_conversation_records_nothing(meter) -> None:
    meter["known"] = "other-account"
    _run(
        participant.ping_conversation(
            "c1", _FakeRequest(), _ping(project_id="p1", mode="voice", state="recording")
        )
    )
    assert meter["presence"] == [] and meter["observe"] == []


def test_finishing_ping_for_an_unregistered_conversation_does_not_refresh(meter) -> None:
    meter["known"] = None
    _run(
        participant.ping_conversation(
            "ghost", _FakeRequest(), _ping(project_id="p1", state="finishing")
        )
    )
    assert meter["refresh"] == []


def test_terminal_ping_closes_even_without_a_mapping(meter) -> None:
    meter["known"] = None
    _run(participant.ping_conversation("c1", _FakeRequest(), _ping(project_id="p1", state="left")))
    assert meter["close"] == [("b1", "c1")]


@pytest.mark.parametrize("state", ["left", "finished"])
def test_terminal_ping_closes(meter, state) -> None:
    _run(participant.ping_conversation("c1", _FakeRequest(), _ping(project_id="p1", state=state)))
    assert meter["close"] == [("b1", "c1")] and meter["presence"] == []


def test_finishing_ping_only_refreshes(meter) -> None:
    _run(
        participant.ping_conversation(
            "c1", _FakeRequest(), _ping(project_id="p1", state="finishing")
        )
    )
    assert meter["refresh"] == [("b1", "c1")] and meter["presence"] == [] and meter["close"] == []


def test_text_ping_never_counts(meter) -> None:
    _run(participant.ping_conversation("c1", _FakeRequest(), _ping(project_id="p1", mode="text")))
    assert meter["presence"] == []


def test_ping_without_project_or_body(meter) -> None:
    assert _run(participant.ping_conversation("c1", _FakeRequest())) == {"ok": True}
    assert _run(participant.ping_conversation("c1", _FakeRequest(), _ping())) == {"ok": True}
    assert meter["presence"] == []


def test_ping_meters_even_when_monitor_is_off(meter, monkeypatch) -> None:
    monkeypatch.setattr(participant.settings.feature_flags, "enable_monitor", False)
    out = _run(
        participant.ping_conversation("c1", _FakeRequest(), _ping(project_id="p1", mode="voice"))
    )
    assert out == {"ok": True} and meter["presence"] == [("b1", "c1")]


def test_rate_limited_ping_does_not_meter(meter, monkeypatch) -> None:
    async def deny(_id: str) -> bool:
        return False

    monkeypatch.setattr(participant._conversation_ping_rate_limiter, "allow", deny)
    out = _run(
        participant.ping_conversation("c1", _FakeRequest(), _ping(project_id="p1", mode="voice"))
    )
    assert out == {"ok": True} and meter["presence"] == []


def _patch_create_chunk(monkeypatch) -> None:
    def create_chunk(**kwargs: Any) -> dict:
        return {"id": "chunk-1", "conversation_id": kwargs["conversation_id"]}

    monkeypatch.setattr(participant.conversation_service, "create_chunk", create_chunk)


def _upload(conversation_id: str = "c1") -> Any:
    from datetime import datetime

    return _run(
        participant.upload_conversation_chunk(
            conversation_id, MagicMock(), datetime.now(), "PORTAL_AUDIO"
        )
    )


def test_upload_chunk_refreshes_only(meter, monkeypatch) -> None:
    _patch_create_chunk(monkeypatch)
    _upload()
    assert meter["refresh"] == [("b1", "c1")] and meter["presence"] == []


def test_upload_chunk_reads_no_conversation(meter, monkeypatch) -> None:
    # The mapping is the whole proof: no Directus on the chunk hot path.
    _patch_create_chunk(monkeypatch)

    def forbidden(conversation_id: str, **_k: Any) -> dict:
        # Record before raising: a swallowed exception must still be caught.
        meter["looked_up"].append(conversation_id)
        raise AssertionError("upload must not read the conversation")

    monkeypatch.setattr(participant.conversation_service, "get_by_id_or_raise", forbidden)
    _upload()
    assert meter["refresh"] == [("b1", "c1")]
    assert meter["looked_up"] == []


def test_upload_chunk_without_a_mapping_refreshes_nothing(meter, monkeypatch) -> None:
    # Uploads never create or recover; pings do that every 3 seconds.
    meter["known"] = None
    _patch_create_chunk(monkeypatch)
    _upload()
    assert meter["refresh"] == [] and meter["registered"] == []
    assert meter["presence"] == [] and meter["looked_up"] == []


def test_upload_chunk_with_a_negative_marker_refreshes_nothing(meter, monkeypatch) -> None:
    meter["known"] = participant.NEGATIVE_MARKER
    _patch_create_chunk(monkeypatch)
    _upload()
    assert meter["refresh"] == [] and meter["registered"] == []
    assert meter["presence"] == [] and meter["looked_up"] == []


def test_upload_chunk_refreshes_the_mapped_account(meter, monkeypatch) -> None:
    # The mapping is the account, so whichever account it holds is refreshed.
    meter["known"] = "other-account"
    _patch_create_chunk(monkeypatch)
    _upload()
    assert meter["refresh"] == [("other-account", "c1")]
    assert meter["registered"] == [] and meter["presence"] == []


def test_upload_chunk_fails_open_when_the_mapping_lookup_raises(meter, monkeypatch) -> None:
    _patch_create_chunk(monkeypatch)

    async def boom(_cid: str) -> Optional[str]:
        raise RuntimeError("redis down")

    monkeypatch.setattr(participant, "account_for_conversation", boom)
    assert _upload() == {"id": "chunk-1", "conversation_id": "c1"}
    assert meter["refresh"] == [] and meter["presence"] == []


def test_finish_closes(meter, monkeypatch) -> None:
    import dembrane.tasks as tasks

    def _send(_cid: str) -> None:
        return None

    monkeypatch.setattr(tasks.task_finish_conversation_hook, "send", _send)

    # The real helper reads the project from the fixture's conversation row.
    meter["conversation"] = {"id": "c1", "project_id": "p1"}
    _run(participant.run_when_conversation_is_finished("c1"))
    assert meter["looked_up"] == ["c1"]
    assert meter["close"] == [("b1", "c1")]


def test_meter_failure_does_not_break_the_ping(meter, monkeypatch) -> None:
    async def boom(*a: Any, **k: Any) -> None:
        raise RuntimeError("redis down")

    monkeypatch.setattr(participant, "observe", boom)
    out = _run(
        participant.ping_conversation(
            "c1", _FakeRequest(), _ping(project_id="p1", mode="voice", state="recording")
        )
    )
    assert out == {"ok": True}
