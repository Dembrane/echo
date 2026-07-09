from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta

import pytest

import dembrane.canvas.ticks as ticks
import dembrane.scheduled_tasks as scheduled_tasks


class _FakeDirectus:
    def __init__(self) -> None:
        self.items = {
            "agent_loop": {
                "loop1": {
                    "id": "loop1",
                    "project_id": "p1",
                    "report_id": "r1",
                    "status": "active",
                    "expires_at": "2099-01-01T00:00:00+00:00",
                    "cadence_minutes": 5,
                    "acting_directus_user_id": "du1",
                    "failure_count": 0,
                }
            }
        }
        self.created: dict[str, list[dict[str, Any]]] = {}
        self.updated: list[tuple[str, str, dict[str, Any]]] = []
        self.latest_generation = {
            "id": "g-old",
            "content_html": "<html><body>old</body></html>",
            "created_at": "2026-07-07T10:10:00+00:00",
        }
        self.scheduled_tasks: list[dict[str, Any]] = []

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.items.get(collection, {}).get(item_id)

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "canvas_generation":
            return [self.latest_generation]
        if collection == "agent_loop":
            rows = list(self.items.get("agent_loop", {}).values())
            status = ((params.get("query") or {}).get("filter") or {}).get("status") or {}
            expires_at = ((params.get("query") or {}).get("filter") or {}).get("expires_at") or {}
            if status.get("_eq"):
                rows = [row for row in rows if row.get("status") == status["_eq"]]
            if expires_at.get("_gt"):
                rows = [
                    row
                    for row in rows
                    if row.get("expires_at") and row["expires_at"] > expires_at["_gt"]
                ]
            return rows
        if collection == "scheduled_task":
            return self.scheduled_tasks
        return []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        self.created.setdefault(collection, []).append(data)
        return {"data": data}

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
        self.updated.append((collection, item_id, data))
        self.items.setdefault(collection, {}).setdefault(item_id, {}).update(data)
        return {"data": self.items[collection][item_id]}


@pytest.fixture(autouse=True)
def _claim_tick_window(monkeypatch) -> None:
    async def _claim(loop: dict[str, Any], started_at: datetime) -> bool:  # noqa: ARG001
        return True

    monkeypatch.setattr(ticks, "_claim_scheduled_tick_window", _claim)

    async def _host_guide(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "where_the_room_is": "The room is forming around receipts already accepted.",
            "what_to_ask_next": ["What should we test next?"],
            "under_heard": [],
            "updated_at": "2026-07-08T10:00:00+00:00",
        }

    monkeypatch.setattr(ticks, "_generate_host_guide", _host_guide)


@pytest.mark.asyncio
async def test_tick_no_op_when_no_new_content(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:00:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "no_op"
    assert fake.created["agent_loop_run"][0]["status"] == "no_op"
    assert "canvas_generation" not in fake.created


@pytest.mark.asyncio
async def test_tick_duplicate_window_exits_without_enqueuing(monkeypatch) -> None:
    fake = _FakeDirectus()
    enqueued: list[str] = []

    async def _claim(loop: dict[str, Any], started_at: datetime) -> bool:  # noqa: ARG001
        return False

    async def _enqueue(loop: dict[str, Any]) -> None:
        enqueued.append(str(loop["id"]))

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_claim_scheduled_tick_window", _claim)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "duplicate"
    assert fake.created["agent_loop_run"][0]["status"] == "no_op"
    assert fake.created["agent_loop_run"][0]["detail"] == "Duplicate tick for cadence window"
    assert "canvas_generation" not in fake.created
    assert enqueued == []


@pytest.mark.asyncio
async def test_tick_error_stores_error_generation_and_pauses_after_three(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["failure_count"] = 2
    fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"] = [
        {"id": "q-old", "quote": "Keep this.", "source": {}}
    ]

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _generate(**kwargs) -> str:  # noqa: ARG001
        return "garbage"

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_generate_html", _generate)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "error"
    assert fake.created["canvas_generation"][0]["status"] == "error"
    assert fake.created["agent_loop_run"][0]["status"] == "error"
    assert ("agent_loop", "loop1", {"failure_count": 3, "status": "paused"}) in fake.updated


@pytest.mark.asyncio
async def test_tick_model_failure_records_nonfatal_conversation_outcome(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"] = [
        {"id": "q-old", "quote": "Keep this.", "source": {}}
    ]

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [
                {
                    "id": "conv-1",
                    "label": "Maya",
                    "latest_transcript": "Keep the doorway open.",
                }
            ],
        }

    async def _extract(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        raise RuntimeError("model unavailable")

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_extract_living_canvas_update", _extract)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "ok"
    assert fake.created["agent_loop_run"][0]["status"] == "ok"
    assert "conv recent: model error: model unavailable" in result["generation"]["detail"]
    assert fake.created["canvas_generation"][0]["status"] == "ok"
    assert fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"] == [
        {"id": "q-old", "quote": "Keep this.", "source": {}}
    ]


@pytest.mark.asyncio
async def test_tick_uses_model_extraction_and_records_receipt_rejections(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {"name": "Room"},
            "conversations": [
                {
                    "id": "conv-1",
                    "label": "Maya",
                    "chunks": [
                        {
                            "id": "chunk-1",
                            "transcript": "Keep the doorway open.",
                            "created_at": "2026-07-07T10:20:00+00:00",
                        }
                    ],
                }
            ],
        }

    async def _extract(**kwargs) -> dict[str, Any]:
        assert kwargs["current_state"]["quotes_ledger"] == []
        return {
            "quotes": [
                {
                    "who": "Maya",
                    "quote": "Keep the doorway open.",
                    "conversation_id": "conv-1",
                    "chunk_id": "chunk-1",
                },
                {
                    "who": "Maya",
                    "quote": "Invented receipt.",
                    "conversation_id": "conv-1",
                    "chunk_id": "chunk-1",
                },
            ],
            "concepts": [
                {"phrase": "doorway open", "supporting_quote_indices": [0]},
                {"phrase": "invented", "supporting_quote_indices": [1]},
            ],
            "crux": {"question": "What first move keeps the doorway open?"},
            "story_slides": [
                {
                    "eyebrow": "Signal",
                    "heading": "Doorway",
                    "lede": "People want the doorway open.",
                    "quote_indices": [0, 1],
                }
            ],
        }

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_extract_living_canvas_update", _extract)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "ok"
    assert fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"][0]["quote"] == (
        "Keep the doorway open."
    )
    generation = result["generation"]
    assert "Keep the doorway open." in generation["content_html"]
    assert "not found verbatim" in generation["detail"]
    assert "no accepted supporting quote" in generation["detail"]
    assert "Open questions" in generation["content_html"]
    assert fake.items["agent_loop"]["loop1"]["canvas_host_guide"]["where_the_room_is"]


@pytest.mark.asyncio
async def test_extraction_prompt_includes_report_brief_and_zero_quote_instruction(
    monkeypatch,
) -> None:
    messages_seen: list[list[dict[str, str]]] = []

    async def _completion(model, messages, **kwargs):  # noqa: ANN001, ARG001
        messages_seen.append(messages)

        class _Message:
            content = '{"quotes":[],"concepts":[],"crux":null,"story_slides":[]}'

        class _Choice:
            message = _Message()

        class _Response:
            choices = [_Choice()]

        return _Response()

    monkeypatch.setattr(ticks, "arouter_completion", _completion)

    result = await ticks._extract_living_canvas_update(
        gather_bundle={
            "project": {"name": "Room"},
            "conversations": [{"id": "conv-1", "latest_transcript": "Off-topic room flavor."}],
        },
        current_state={},
        report_name="13th Week Retrospective Wall",
        brief="Focus on the 13th week. Do not pre-populate static transcript snippets.",
    )

    payload = messages_seen[0][1]["content"]
    assert result["quotes"] == []
    assert "13th Week Retrospective Wall" in payload
    assert "Focus on the 13th week" in payload
    assert "Extract ONLY material that serves it" in payload
    assert "returning nothing for them is correct" in payload


@pytest.mark.asyncio
async def test_cold_start_backfill_uses_full_history_then_delta(monkeypatch) -> None:
    fake = _FakeDirectus()
    gather_calls: list[dict[str, Any]] = []
    extraction_calls: list[list[str]] = []

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:
        gather_calls.append(kwargs)
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {"name": "Room"},
            "conversations": [
                {"id": "conv-1", "label": "Maya", "latest_transcript": "Keep the doorway open."},
                {
                    "id": "conv-2",
                    "label": "Noor",
                    "latest_transcript": "Make the next step visible.",
                },
            ],
        }

    async def _extract(**kwargs) -> dict[str, Any]:
        conversation_ids = [conv["id"] for conv in kwargs["gather_bundle"]["conversations"]]
        extraction_calls.append(conversation_ids)
        quote = kwargs["gather_bundle"]["conversations"][0]["latest_transcript"]
        conv_id = kwargs["gather_bundle"]["conversations"][0]["id"]
        return {
            "quotes": [{"who": None, "quote": quote, "conversation_id": conv_id, "chunk_id": None}],
            "concepts": [{"phrase": quote.split(".")[0], "supporting_quote_indices": [0]}],
            "crux": {"question": "What first move should we make visible?"},
            "story_slides": [],
        }

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_extract_living_canvas_update", _extract)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    first = await ticks.run_tick("loop1", "manual")
    second = await ticks.run_tick("loop1", "manual")

    assert first["status"] == "ok"
    assert second["status"] == "ok"
    assert gather_calls[0]["full_history"] is True
    assert gather_calls[1]["full_history"] is False
    assert extraction_calls[:2] == [["conv-1"], ["conv-2"]]
    assert extraction_calls[2] == ["conv-1", "conv-2"]
    assert "backfill: 2 conversations" in first["generation"]["detail"]
    assert "backfill: 2 conversations" in first["run"]["detail"]
    assert "backfill conv conv-1: 1 accepted / 0 rejected" in first["generation"]["detail"]


@pytest.mark.asyncio
async def test_empty_extraction_with_prior_generation_noops_without_storing_skeleton(
    monkeypatch,
) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [
                {"id": "conv-1", "label": "Maya", "latest_transcript": "Thin transcript."}
            ],
        }

    async def _extract(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {"quotes": [], "concepts": [], "crux": None, "story_slides": []}

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_extract_living_canvas_update", _extract)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "manual")

    assert result["status"] == "no_op"
    assert (
        "Empty extraction would replace a contentful previous generation" in result["run"]["detail"]
    )
    assert "canvas_generation" not in fake.created
    assert fake.updated == []
    assert fake.latest_generation["id"] == "g-old"


@pytest.mark.asyncio
async def test_backfill_long_transcript_is_windowed(monkeypatch) -> None:
    fake = _FakeDirectus()
    extraction_lengths: list[int] = []
    long_transcript = "A relevant retrospective receipt. " * 1800

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "retro brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {"name": "Room"},
            "conversations": [
                {"id": "conv-long", "label": "Retro", "latest_transcript": long_transcript}
            ],
        }

    async def _extract(**kwargs) -> dict[str, Any]:
        transcript = kwargs["gather_bundle"]["conversations"][0]["chunks"][0]["transcript"]
        extraction_lengths.append(len(transcript))
        quote = transcript.strip()[:120].strip()
        return {
            "quotes": [
                {"who": "Retro", "quote": quote, "conversation_id": "conv-long", "chunk_id": None}
            ],
            "concepts": [],
            "crux": None,
            "story_slides": [],
        }

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_extract_living_canvas_update", _extract)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "manual")

    assert result["status"] == "ok"
    assert len(extraction_lengths) > 1
    assert max(extraction_lengths) <= ticks.CANVAS_TRANSCRIPT_WINDOW_CHARS
    assert "backfill conv conv-lon window 1:" in result["generation"]["detail"]


@pytest.mark.asyncio
async def test_backfill_conversation_model_error_is_recorded_and_nonfatal(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "retro brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {"name": "Room"},
            "conversations": [
                {"id": "conv-fail", "label": "Retro", "latest_transcript": "This one errors."},
                {"id": "conv-ok", "label": "Design", "latest_transcript": "Keep this receipt."},
            ],
        }

    async def _extract(**kwargs) -> dict[str, Any]:
        conv = kwargs["gather_bundle"]["conversations"][0]
        if conv["id"] == "conv-fail":
            raise RuntimeError("context length")
        return {
            "quotes": [
                {
                    "who": "Design",
                    "quote": "Keep this receipt.",
                    "conversation_id": "conv-ok",
                    "chunk_id": None,
                }
            ],
            "concepts": [{"phrase": "this receipt", "supporting_quote_indices": [0]}],
            "crux": None,
            "story_slides": [],
        }

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_extract_living_canvas_update", _extract)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "manual")

    assert result["status"] == "ok"
    assert "backfill conv conv-fai: model error: context length" in result["generation"]["detail"]
    assert "backfill conv conv-ok: 1 accepted / 0 rejected" in result["generation"]["detail"]
    assert fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"][0]["quote"] == (
        "Keep this receipt."
    )


@pytest.mark.asyncio
async def test_tab_set_change_rerenders_despite_no_new_content(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["canvas_tabs"] = [{"kind": "crux"}]
    fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"] = [
        {"id": "q-old", "quote": "Keep this.", "who": "Maya", "source": {}}
    ]

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {
            "id": "cfg1",
            "brief": "Show a person-by-person board.",
            "tabs": [{"kind": "board", "grouping": "person"}],
            "gather_spec": {},
            "cadence_minutes": 5,
        }

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {"latest_content_at": None, "project": {}, "conversations": []}

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "manual")

    assert result["status"] == "ok"
    assert 'for="canvas-tab-board_person"' in result["generation"]["content_html"]
    assert fake.items["agent_loop"]["loop1"]["canvas_tabs"] == [
        {"kind": "board", "grouping": "person"}
    ]


@pytest.mark.asyncio
async def test_unsupported_shape_detail_recorded(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {
            "id": "cfg1",
            "brief": "Rebuild this as a timeline of the discussion.",
            "tabs": [{"kind": "crux"}],
            "gather_spec": {},
            "cadence_minutes": 5,
        }

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {"latest_content_at": None, "project": {}, "conversations": []}

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "manual")

    assert result["status"] == "ok"
    assert "brief asks for timeline; no tab primitive supports it" in result["generation"]["detail"]


@pytest.mark.asyncio
async def test_new_canvas_can_store_empty_skeleton(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.latest_generation = None

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {"latest_content_at": None, "project": {}, "conversations": []}

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "manual")

    assert result["status"] == "ok"
    assert (
        "Concepts will appear as transcript receipts arrive" in result["generation"]["content_html"]
    )
    assert fake.created["canvas_generation"][0]["status"] == "ok"


@pytest.mark.asyncio
async def test_tick_missing_ids_records_error_run_without_generation(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["report_id"] = None

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "error"
    assert "canvas_generation" not in fake.created
    assert fake.created["agent_loop_run"][0]["status"] == "error"
    assert fake.created["agent_loop_run"][0]["generation_id"] is None
    assert "missing required ids" in fake.created["agent_loop_run"][0]["detail"]


@pytest.mark.asyncio
async def test_enqueue_next_tick_uses_final_slot_before_expiry(monkeypatch) -> None:
    fake = _FakeDirectus()
    now = datetime(2026, 7, 7, 10, 0, 0, tzinfo=timezone.utc)
    fake.items["agent_loop"]["loop1"]["expires_at"] = (now + timedelta(minutes=3)).isoformat()
    enqueued: list[dict[str, Any]] = []

    async def _schedule_task(**kwargs) -> str:
        enqueued.append(kwargs)
        return "task1"

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    monkeypatch.setattr(scheduled_tasks, "schedule_task", _schedule_task)

    await ticks._enqueue_next_if_due(fake.items["agent_loop"]["loop1"])

    assert enqueued[0]["task_type"] == scheduled_tasks.TASK_CANVAS_TICK
    assert enqueued[0]["scheduled_at"] == now + timedelta(minutes=3, seconds=-5)


@pytest.mark.asyncio
async def test_tick_ok_records_banned_visible_copy_without_rewriting(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"] = [
        {"id": "q-old", "quote": "Keep this.", "source": {}}
    ]

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _generate(**kwargs) -> str:  # noqa: ARG001
        return '<div class="canvas-shell"><p>Real-time reflections — created successfully by AI.</p></div>'

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_generate_html", _generate)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "scheduled")

    generation = result["generation"]
    assert generation["status"] == "ok"
    assert "Real-time reflections" in generation["content_html"]
    assert generation["detail"].startswith(
        "banned visible copy: real-time, AI, successfully, em dash"
    )
    assert "ledger update:" in generation["detail"]


@pytest.mark.asyncio
async def test_tick_uses_applied_generation_as_previous_frame(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["canvas_quotes_ledger"] = [
        {"id": "q-old", "quote": "Keep this.", "source": {}}
    ]
    fake.latest_generation = {
        "id": "g-applied",
        "content_html": "<main>approved preview</main>",
        "created_at": "2026-07-07T10:10:00+00:00",
        "tick_kind": "applied",
    }
    previous_frames: list[str | None] = []

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _generate(**kwargs) -> str:
        previous_frames.append(kwargs["previous_html"])
        return '<div class="canvas-shell"><p>next</p></div>'

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_generate_html", _generate)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "ok"
    assert previous_frames == ["<main>approved preview</main>"]


@pytest.mark.asyncio
async def test_reconcile_missing_canvas_tick_tasks_enqueues_orphaned_active_loop(
    monkeypatch,
) -> None:
    fake = _FakeDirectus()
    now = datetime(2026, 7, 7, 10, 0, 0, tzinfo=timezone.utc)
    fake.items["agent_loop"]["covered"] = {
        **fake.items["agent_loop"]["loop1"],
        "id": "covered",
    }
    fake.scheduled_tasks = [
        {
            "payload": {"loop_id": "covered"},
            "status": scheduled_tasks.STATUS_SCHEDULED,
            "task_type": scheduled_tasks.TASK_CANVAS_TICK,
        }
    ]
    enqueued: list[str] = []

    async def _enqueue(loop: dict[str, Any]) -> None:
        enqueued.append(str(loop["id"]))

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    count = await ticks.reconcile_missing_canvas_tick_tasks()

    assert count == 1
    assert enqueued == ["loop1"]
