"""Unit tests for anonymized usage-insight capture.

Covers:
- generate_chat_insight: parses canned strict JSON from the (mocked) model,
  returns None on unparseable output, and skips chats with no host turn.
- The prompt builder carries the anonymization + brand-voice guardrails.
- task_capture_chat_insights idempotency: an existing insight newer than the
  chat's date_updated skips; an older one proceeds and writes a new insight.
- Scheduler registration: the */15 cron job exists.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest


# ── generate_chat_insight ────────────────────────────────────────────


def _mock_completion(content: str) -> MagicMock:
    """Build a mock arouter_completion return value carrying `content`."""
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    return resp


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_generate_chat_insight_parses_canned_json():
    from dembrane import insight_utils

    canned = (
        '{"insight_type": "friction", "summary": "the host wanted to compare '
        'themes across interviews and struggled to narrow the topic"}'
    )
    messages = [
        {"message_from": "user", "text": "help me compare themes"},
        {"message_from": "assistant", "text": "sure, which ones?"},
    ]

    async def _go():
        with patch.object(
            insight_utils, "arouter_completion", return_value=_mock_completion(canned)
        ):
            return await insight_utils.generate_chat_insight(messages)

    result = _run(_go())
    assert result == {
        "insight_type": "friction",
        "summary": (
            "the host wanted to compare themes across interviews and struggled "
            "to narrow the topic"
        ),
    }


def test_generate_chat_insight_strips_code_fence():
    from dembrane import insight_utils

    fenced = '```json\n{"insight_type": "intent", "summary": "the host explored a topic"}\n```'
    messages = [{"message_from": "user", "text": "what can I do here"}]

    async def _go():
        with patch.object(
            insight_utils, "arouter_completion", return_value=_mock_completion(fenced)
        ):
            return await insight_utils.generate_chat_insight(messages)

    result = _run(_go())
    assert result == {"insight_type": "intent", "summary": "the host explored a topic"}


def test_generate_chat_insight_returns_none_on_unparseable():
    from dembrane import insight_utils

    messages = [{"message_from": "user", "text": "hello there"}]

    async def _go():
        with patch.object(
            insight_utils,
            "arouter_completion",
            return_value=_mock_completion("this is not json at all"),
        ):
            return await insight_utils.generate_chat_insight(messages)

    assert _run(_go()) is None


def test_generate_chat_insight_returns_none_on_unknown_type():
    from dembrane import insight_utils

    messages = [{"message_from": "user", "text": "hello there"}]
    bad = '{"insight_type": "banana", "summary": "something"}'

    async def _go():
        with patch.object(
            insight_utils, "arouter_completion", return_value=_mock_completion(bad)
        ):
            return await insight_utils.generate_chat_insight(messages)

    assert _run(_go()) is None


def test_generate_chat_insight_returns_none_when_model_answers_null():
    from dembrane import insight_utils

    messages = [{"message_from": "user", "text": "hi"}]

    async def _go():
        with patch.object(
            insight_utils, "arouter_completion", return_value=_mock_completion("null")
        ):
            return await insight_utils.generate_chat_insight(messages)

    assert _run(_go()) is None


def test_generate_chat_insight_skips_without_host_turn():
    """No host (user) turn => nothing meaningful; must not call the model."""
    from dembrane import insight_utils

    messages = [{"message_from": "assistant", "text": "welcome"}]

    async def _go():
        with patch.object(insight_utils, "arouter_completion") as mock_llm:
            result = await insight_utils.generate_chat_insight(messages)
            mock_llm.assert_not_called()
            return result

    assert _run(_go()) is None


# ── Anonymization guardrails in the prompt ───────────────────────────


def test_prompt_carries_anonymization_and_brand_guardrails():
    from dembrane.insight_utils import _build_insight_prompt

    prompt = _build_insight_prompt(
        [{"message_from": "user", "text": "compare themes"}], "en"
    )

    # Anonymization guardrails.
    assert "No participant or host names" in prompt
    assert "No verbatim quotes" in prompt
    assert "No conversation, project, workspace, or chat ids" in prompt
    assert "No numbers or specific details that could identify" in prompt
    # Example of generic phrasing.
    assert "compare themes across interviews" in prompt
    # Brand voice.
    assert 'Never use the word "AI"' in prompt
    assert 'Write "dembrane" in lowercase' in prompt
    assert "no em dashes" in prompt.lower()
    assert '"participants" and "hosts", never "users"' in prompt
    # Strict JSON contract + the allowed labels.
    assert "STRICT JSON" in prompt
    for label in ("intent", "friction", "feature_request", "success", "other"):
        assert label in prompt


def test_module_constants():
    from dembrane import insight_utils

    assert insight_utils.INSIGHT_IDLE_MINUTES == 20
    assert insight_utils.INSIGHT_SWEEP_BATCH == 25


# ── task_capture_chat_insights idempotency ───────────────────────────


def _match(row: dict, flt: dict) -> bool:
    for field, cond in flt.items():
        val = row.get(field)
        for op, expected in cond.items():
            if op == "_eq" and str(val) != str(expected):
                return False
            if op == "_lt" and not (val is not None and val < expected):
                return False
            if op == "_null":
                if expected and val is not None:
                    return False
                if not expected and val is None:
                    return False
            if op == "_nnull" and expected and val is None:
                return False
    return True


class FakeClient:
    """In-memory stand-in for the sync DirectusClient (collection -> rows)."""

    def __init__(self, data: dict[str, list[dict]] | None = None):
        self.data: dict[str, list[dict]] = {k: [dict(r) for r in v] for k, v in (data or {}).items()}
        self.created: list[tuple[str, dict]] = []

    def get_items(self, collection: str, params: dict | None = None) -> list[dict]:
        q = (params or {}).get("query", {})
        rows = [dict(r) for r in self.data.get(collection, [])]
        rows = [r for r in rows if _match(r, q.get("filter", {}))]
        sort = q.get("sort")
        if sort:
            field = sort[0].lstrip("-")
            rows.sort(key=lambda x: (x.get(field) or ""), reverse=sort[0].startswith("-"))
        limit = q.get("limit")
        if isinstance(limit, int) and limit >= 0:
            rows = rows[:limit]
        return rows

    def get_item(self, collection: str, item_id: str) -> dict | None:
        for r in self.data.get(collection, []):
            if str(r.get("id")) == str(item_id):
                return dict(r)
        return None

    def create_item(self, collection: str, payload: dict) -> dict:
        self.created.append((collection, payload))
        self.data.setdefault(collection, []).append(dict(payload))
        return {"data": payload}


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _fake_ctx(client: FakeClient):
    @contextmanager
    def _ctx(*_a, **_k):
        yield client

    return _ctx


def _base_data(insight_created: datetime) -> tuple[FakeClient, datetime]:
    now = datetime.now(timezone.utc)
    chat_updated = now - timedelta(minutes=30)  # idle (older than 20m cutoff)
    client = FakeClient(
        {
            "project_chat": [
                {
                    "id": "chat-1",
                    "chat_mode": "agentic",
                    "deleted_at": None,
                    "date_updated": _iso(chat_updated),
                    "project_id": "proj-1",
                    "user_created": "user-1",
                }
            ],
            "project_chat_message": [
                {"project_chat_id": "chat-1", "message_from": "user", "text": "compare themes", "date_created": _iso(now - timedelta(minutes=35))},
                {"project_chat_id": "chat-1", "message_from": "assistant", "text": "which ones?", "date_created": _iso(now - timedelta(minutes=34))},
            ],
            "usage_insight": [
                {"id": "ins-1", "project_chat_id": "chat-1", "created_at": _iso(insight_created)},
            ],
            "project": [{"id": "proj-1", "workspace_id": "ws-1"}],
        }
    )
    return client, chat_updated


def test_capture_skips_when_recent_insight_covers_idle_window():
    """Existing insight newer than chat.date_updated => no new insight."""
    import dembrane.tasks as T

    now = datetime.now(timezone.utc)
    # Insight created AFTER the chat went idle => no fresh activity => skip.
    client, _ = _base_data(insight_created=now - timedelta(minutes=25))

    with (
        patch.object(T, "directus_client_context", _fake_ctx(client)),
        patch("dembrane.insight_utils.generate_chat_insight") as mock_gen,
    ):
        T.task_capture_chat_insights()
        mock_gen.assert_not_called()

    assert client.created == []


def test_capture_writes_insight_when_fresh_activity_since_last():
    """Newest insight OLDER than chat.date_updated => proceed and write one."""
    import dembrane.tasks as T

    now = datetime.now(timezone.utc)
    # Insight created BEFORE the chat's last activity => fresh activity => proceed.
    client, _ = _base_data(insight_created=now - timedelta(minutes=90))

    fake_insight = {"insight_type": "friction", "summary": "the host struggled to narrow a topic"}

    async def _fake_gen(messages, language="en"):
        return fake_insight

    with (
        patch.object(T, "directus_client_context", _fake_ctx(client)),
        patch("dembrane.insight_utils.generate_chat_insight", side_effect=_fake_gen),
    ):
        T.task_capture_chat_insights()

    created = [c for c in client.created if c[0] == "usage_insight"]
    assert len(created) == 1
    payload = created[0][1]
    assert payload["project_chat_id"] == "chat-1"
    assert payload["workspace_id"] == "ws-1"
    assert payload["project_id"] == "proj-1"
    assert payload["directus_user_id"] == "user-1"
    assert payload["insight_type"] == "friction"
    assert payload["status"] == "new"


# ── Scheduler registration ───────────────────────────────────────────


class TestInsightScheduler:
    def test_scheduler_has_insight_job(self):
        from dembrane.scheduler import scheduler

        jobs = {j.id: j for j in scheduler.get_jobs()}
        assert "task_capture_chat_insights" in jobs

    def test_insight_job_every_15_minutes(self):
        from dembrane.scheduler import scheduler

        jobs = {j.id: j for j in scheduler.get_jobs()}
        job = jobs["task_capture_chat_insights"]
        field_map = {f.name: f for f in job.trigger.fields}
        assert str(field_map["minute"]) == "*/15"

    def test_insight_job_target(self):
        from dembrane.scheduler import scheduler

        jobs = {j.id: j for j in scheduler.get_jobs()}
        job = jobs["task_capture_chat_insights"]
        assert "task_capture_chat_insights" in str(job.func_ref)
