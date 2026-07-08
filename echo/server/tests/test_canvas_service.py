from __future__ import annotations

from typing import Any

import pytest

import dembrane.canvas.service as canvas_service


class _FakeDirectus:
    def __init__(self) -> None:
        self.created: dict[str, list[dict[str, Any]]] = {
            "canvas_generation": [
                {
                    "id": "g-old",
                    "report_id": "r1",
                    "content_html": "<main>old</main>",
                    "status": "ok",
                    "tick_kind": "scheduled",
                    "created_at": "2026-07-07T10:00:00+00:00",
                }
            ]
        }
        self.items: dict[str, dict[str, dict[str, Any]]] = {
            "canvas_config_revision": {
                "cfg1": {
                    "id": "cfg1",
                    "report_id": "r1",
                    "brief": "Show the room pulse.",
                    "gather_spec": {"window_minutes": 60},
                    "cadence_minutes": 5,
                    "created_by": "user-1",
                    "created_at": "2026-07-07T10:00:00+00:00",
                }
            },
            "agent_loop": {
                "loop1": {
                    "id": "loop1",
                    "report_id": "r1",
                    "name": "Pulse wall",
                    "status": "active",
                    "cadence_minutes": 5,
                    "created_at": "2026-07-07T10:00:00+00:00",
                }
            },
        }
        self.updated: list[tuple[str, str, dict[str, Any]]] = []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        row = dict(data)
        if collection == "canvas_generation":
            row["created_at"] = "2026-07-07T10:05:00+00:00"
        if collection == "canvas_config_revision":
            row["created_at"] = "2026-07-07T10:06:00+00:00"
            self.items.setdefault(collection, {})[str(row["id"])] = row
        self.created.setdefault(collection, []).append(row)
        return {"data": row}

    async def get_items(self, collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = params.get("query") or {}
        if collection == "canvas_generation":
            source = self.created["canvas_generation"]
        else:
            source = list(self.items.get(collection, {}).values())
        report_filter = ((query.get("filter") or {}).get("report_id") or {}).get("_eq")
        rows = [row for row in source if not report_filter or row.get("report_id") == report_filter]
        return sorted(rows, key=lambda row: row.get("created_at") or "", reverse=True)[
            : query.get("limit", 50)
        ]

    async def update_item(
        self, collection: str, item_id: str, data: dict[str, Any]
    ) -> dict[str, Any]:
        self.updated.append((collection, item_id, data))
        row = self.items.setdefault(collection, {}).setdefault(item_id, {"id": item_id})
        row.update(data)
        return {"data": row}


@pytest.mark.asyncio
async def test_store_applied_preview_sanitizes_and_returns_as_latest(monkeypatch) -> None:
    fake = _FakeDirectus()
    nudges: list[str] = []

    async def _publish(report_id: str) -> None:
        nudges.append(report_id)

    monkeypatch.setattr(canvas_service, "async_directus", fake)
    monkeypatch.setattr(canvas_service, "publish_generation_nudge", _publish)

    generation = await canvas_service.store_applied_preview_generation(
        report_id="r1",
        config_revision_id="cfg1",
        loop_id="loop1",
        applied_preview_html="""
            <html>
              <body>
                <main>
                  <script src="https://example.com/app.js"></script>
                  <img src="https://example.com/cat.png">
                  <p style="background:url(https://example.com/bg.png)">approved</p>
                </main>
              </body>
            </html>
        """,
        applied_from_chat_id="chat-1",
    )
    latest = await canvas_service.get_latest_generation("r1")

    assert generation["tick_kind"] == "applied"
    assert generation["status"] == "ok"
    assert 'src="#"' in generation["content_html"]
    assert "url('')" in generation["content_html"]
    assert "https://example.com" not in generation["content_html"]
    assert generation["detail"] == (
        "applied from chat preview; chat_id=chat-1; stripped 3 external reference(s)"
    )
    assert latest["id"] == generation["id"]
    assert fake.created["agent_loop_run"][0]["generation_id"] == generation["id"]
    assert nudges == ["r1"]


@pytest.mark.asyncio
async def test_apply_direct_canvas_edit_stores_edited_generation_and_standing_constraint(
    monkeypatch,
) -> None:
    fake = _FakeDirectus()
    nudges: list[str] = []

    async def _publish(report_id: str) -> None:
        nudges.append(report_id)

    monkeypatch.setattr(canvas_service, "async_directus", fake)
    monkeypatch.setattr(canvas_service, "publish_generation_nudge", _publish)

    result = await canvas_service.apply_direct_canvas_edit(
        report_id="r1",
        edited_html='<div class="canvas-shell"><p>No dividers</p></div>',
        instruction="no section dividers; no freshly compiled footer line",
        chat_id="chat-1",
        created_by="user-1",
    )

    config = result["config_revision"]
    generation = result["generation"]
    assert config["note"] == "direct edit"
    assert "Standing edits:" in config["brief"]
    assert "- no section dividers; no freshly compiled footer line" in config["brief"]
    assert generation["tick_kind"] == "edited"
    assert generation["detail"] == (
        "direct edit: no section dividers; no freshly compiled footer line; chat_id=chat-1"
    )
    assert fake.created["agent_loop_run"][-1]["generation_id"] == generation["id"]
    assert ("agent_loop", "loop1", {"failure_count": 0}) in fake.updated
    assert nudges == ["r1"]
