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

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        row = dict(data)
        if collection == "canvas_generation":
            row["created_at"] = "2026-07-07T10:05:00+00:00"
        self.created.setdefault(collection, []).append(row)
        return {"data": row}

    async def get_items(self, collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if collection != "canvas_generation":
            return []
        query = params.get("query") or {}
        report_filter = ((query.get("filter") or {}).get("report_id") or {}).get("_eq")
        rows = [
            row
            for row in self.created["canvas_generation"]
            if not report_filter or row.get("report_id") == report_filter
        ]
        return sorted(rows, key=lambda row: row.get("created_at") or "", reverse=True)[
            : query.get("limit", 50)
        ]


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
