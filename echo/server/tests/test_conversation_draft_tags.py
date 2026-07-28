from types import SimpleNamespace

from dembrane.api import conversation
from dembrane.api.stateless import _select_valid_tag_ids_from_response


def test_select_valid_tag_ids_filters_unknown_duplicates_and_limits() -> None:
    selected = _select_valid_tag_ids_from_response(
        '{"tag_ids":["tag-1","unknown","tag-1","tag-2","tag-3","tag-4"]}',
        {"tag-1", "tag-2", "tag-3", "tag-4"},
        max_tags=3,
    )

    assert selected == ["tag-1", "tag-2", "tag-3"]


def test_select_valid_tag_ids_accepts_fenced_json() -> None:
    selected = _select_valid_tag_ids_from_response(
        '```json\n{"tag_ids":["tag-2"]}\n```',
        {"tag-1", "tag-2"},
    )

    assert selected == ["tag-2"]


def test_select_valid_tag_ids_returns_empty_for_invalid_json() -> None:
    assert _select_valid_tag_ids_from_response("tag-1, tag-2", {"tag-1", "tag-2"}) == []


def test_add_conversation_tags_skips_existing_junctions(monkeypatch) -> None:
    created: list[dict[str, str]] = []

    def get_items(collection: str, _params: dict) -> list[dict]:
        assert collection == "conversation_project_tag"
        return [
            {
                "id": "row-1",
                "project_tag_id": {"id": "tag-1"},
            }
        ]

    def create_item(collection: str, payload: dict[str, str]) -> dict:
        assert collection == "conversation_project_tag"
        created.append(payload)
        return {"data": payload}

    monkeypatch.setattr(
        conversation,
        "directus",
        SimpleNamespace(get_items=get_items, create_item=create_item),
    )

    added = conversation._add_conversation_tags("conv-1", ["tag-1", "tag-2"])

    assert added == ["tag-2"]
    assert created == [
        {
            "conversation_id": "conv-1",
            "project_tag_id": "tag-2",
        }
    ]
