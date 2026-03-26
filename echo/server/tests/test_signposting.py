from __future__ import annotations

from typing import Any

import dembrane.signposting as signposting


class FakeSignpostingService:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.updated: list[tuple[str, dict[str, Any]]] = []
        self.processed: list[str] = []

    def create_signpost(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.created.append(payload)
        return payload

    def update_signpost(self, signpost_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.updated.append((signpost_id, payload))
        return {"id": signpost_id, **payload}

    def mark_chunks_signpost_processed(self, chunk_ids: list[str]) -> None:
        self.processed.extend(chunk_ids)


def test_apply_signpost_operations_reuses_existing_signpost_for_duplicate_create() -> None:
    service = FakeSignpostingService()

    result = signposting.apply_signpost_operations(
        conversation_id="conv-1",
        ready_chunks=[{"id": "chunk-1"}],
        active_signposts=[
            {
                "id": "sp-1",
                "category": "theme",
                "title": "Transit costs",
                "summary": "Existing summary",
                "evidence_quote": "Existing quote",
            }
        ],
        operations={
            "create": [
                {
                    "category": "theme",
                    "title": "Transit costs",
                    "summary": "People keep returning to the price of transit.",
                    "evidence_quote": "Transit is getting too expensive.",
                    "confidence": 0.82,
                    "evidence_chunk_id": "chunk-1",
                }
            ],
            "resolve": [],
            "update": [],
        },
        service=service,
    )

    assert result == {"created": 0, "resolved": 0, "updated": 1}
    assert service.created == []
    assert service.updated == [
        (
            "sp-1",
            {
                "category": "theme",
                "title": "Transit costs",
                "summary": "People keep returning to the price of transit.",
                "evidence_quote": "Transit is getting too expensive.",
                "confidence": 0.82,
                "evidence_chunk_id": "chunk-1",
                "status": "active",
            },
        )
    ]


def test_apply_signpost_operations_updates_and_resolves_signposts() -> None:
    service = FakeSignpostingService()

    result = signposting.apply_signpost_operations(
        conversation_id="conv-2",
        ready_chunks=[{"id": "chunk-2"}],
        active_signposts=[
            {
                "id": "sp-2",
                "category": "agreement",
                "title": "Safer streets",
            },
            {
                "id": "sp-3",
                "category": "tension",
                "title": "Night buses",
            },
        ],
        operations={
            "create": [],
            "resolve": [{"id": "sp-3"}],
            "update": [
                {
                    "id": "sp-2",
                    "category": "agreement",
                    "title": "Safer streets",
                    "summary": "Several people agree that traffic calming is overdue.",
                    "evidence_quote": "We all want slower traffic in the center.",
                    "confidence": 0.74,
                    "evidence_chunk_id": "chunk-2",
                }
            ],
        },
        service=service,
    )

    assert result == {"created": 0, "resolved": 1, "updated": 1}
    assert service.updated == [
        (
            "sp-2",
            {
                "category": "agreement",
                "title": "Safer streets",
                "summary": "Several people agree that traffic calming is overdue.",
                "evidence_quote": "We all want slower traffic in the center.",
                "confidence": 0.74,
                "evidence_chunk_id": "chunk-2",
                "status": "active",
            },
        ),
        ("sp-3", {"status": "resolved"}),
    ]


def test_refresh_conversation_signposts_processes_batch_and_reports_more(
    monkeypatch,
) -> None:
    captured: dict[str, Any] = {}

    ready_chunks = [
        {
            "id": f"chunk-{index}",
            "created_at": f"2026-03-18T12:0{index}:00Z",
            "timestamp": f"2026-03-18T12:0{index}:00Z",
            "transcript": f"Transcript {index}",
        }
        for index in range(signposting.MAX_READY_CHUNKS + 1)
    ]

    class RefreshService(FakeSignpostingService):
        def get_signposting_context(self, conversation_id: str) -> dict[str, Any]:
            assert conversation_id == "conv-3"
            return {
                "project_id": {
                    "context": "Urban mobility workshop",
                    "is_signposting_enabled": True,
                    "signposting_focus_terms": "bikes\nbuses",
                }
            }

        def list_ready_chunks_for_signposting(
            self,
            conversation_id: str,
            limit: int = 10,
        ) -> list[dict[str, Any]]:
            assert conversation_id == "conv-3"
            assert limit == signposting.MAX_READY_CHUNKS + 1
            return ready_chunks

        def list_signposts(
            self,
            conversation_id: str,
            status: str = "active",
            limit: int = 12,
        ) -> list[dict[str, Any]]:
            assert conversation_id == "conv-3"
            assert status == "active"
            del limit
            return [{"id": "sp-4", "category": "theme", "title": "Bike lanes"}]

    def apply_operations_stub(
        conversation_id: str,
        ready_chunks: list[dict[str, Any]],
        active_signposts: list[dict[str, Any]],
        operations: dict[str, list[dict[str, Any]]],
        service: Any = None,
    ) -> dict[str, int]:
        del conversation_id
        del ready_chunks
        del active_signposts
        del operations
        del service
        return {
            "created": 1,
            "resolved": 0,
            "updated": 0,
        }

    refresh_service = RefreshService()

    monkeypatch.setattr(
        signposting,
        "generate_signpost_operations",
        lambda project_context, focus_terms, active_signposts, ready_chunks: captured.update(
            {
                "project_context": project_context,
                "focus_terms": focus_terms,
                "active_signposts": active_signposts,
                "ready_chunks": ready_chunks,
            }
        )
        or {"create": [], "resolve": [], "update": []},
    )
    monkeypatch.setattr(
        signposting,
        "apply_signpost_operations",
        apply_operations_stub,
    )

    result = signposting.refresh_conversation_signposts(
        "conv-3",
        service=refresh_service,
    )

    assert captured["project_context"] == "Urban mobility workshop"
    assert captured["focus_terms"] == ["bikes", "buses"]
    assert len(captured["ready_chunks"]) == signposting.MAX_READY_CHUNKS
    assert result == {
        "processed_chunk_ids": [f"chunk-{index}" for index in range(signposting.MAX_READY_CHUNKS)],
        "has_more": True,
        "operations": {"created": 1, "resolved": 0, "updated": 0},
    }
    assert refresh_service.processed == [
        f"chunk-{index}" for index in range(signposting.MAX_READY_CHUNKS)
    ]


def test_refresh_conversation_signposts_skips_disabled_projects() -> None:
    state = {"listed": False, "processed": False}

    class DisabledService:
        def get_signposting_context(self, conversation_id: str) -> dict[str, Any]:
            assert conversation_id == "conv-4"
            return {"project_id": {"is_signposting_enabled": False}}

        def list_ready_chunks_for_signposting(
            self,
            *_args: Any,
            **_kwargs: Any,
        ) -> list[dict[str, Any]]:
            state["listed"] = True
            return []

        def mark_chunks_signpost_processed(self, _chunk_ids: list[str]) -> None:
            state["processed"] = True

    result = signposting.refresh_conversation_signposts(
        "conv-4",
        service=DisabledService(),
    )

    assert result == {
        "processed_chunk_ids": [],
        "has_more": False,
        "operations": {"created": 0, "updated": 0, "resolved": 0},
    }
    assert state == {"listed": False, "processed": False}
