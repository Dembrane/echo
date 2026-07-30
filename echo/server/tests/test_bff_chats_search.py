import pytest

from dembrane.api.v2.bff.chats import list_chats


class _RecordingDirectus:
    """Captures the query each call receives so the test can assert on the
    filter shape rather than on Directus behavior."""

    def __init__(self) -> None:
        self.queries: list[dict] = []

    async def get_items(self, collection: str, payload: dict):
        self.queries.append({"collection": collection, "payload": payload})
        query = payload.get("query", {})
        if "aggregate" in query:
            return [{"count": {"id": 2}}]
        return [{"id": "chat-1", "name": "Budget questions"}]


class _Access:
    workspace_id = "ws-1"
    tier = "pro"

    def require(self, _scope: str) -> None:
        return None


@pytest.fixture
def patched(monkeypatch):
    directus = _RecordingDirectus()
    monkeypatch.setattr("dembrane.api.v2.bff.chats.async_directus", directus)

    async def _resolve(_project_id: str, _auth):
        return _Access()

    monkeypatch.setattr("dembrane.api.v2.bff.chats.resolve_project_access", _resolve)
    return directus


# Every parameter is passed explicitly on these direct calls. Bypassing the
# router means FastAPI never resolves the `Query(...)` defaults, and a leftover
# `Query(False)` sentinel is a truthy object: letting `has_messages` default
# here would silently add the has-messages clause to every test.
_DEFAULTS = {"limit": 15, "offset": 0, "has_messages": False}


@pytest.mark.asyncio
async def test_search_filters_page_and_total(patched) -> None:
    result = await list_chats(auth=None, project_id="p-1", q="budget", **_DEFAULTS)

    assert result["total"] == 2
    page_filter = patched.queries[0]["payload"]["query"]["filter"]
    count_filter = patched.queries[1]["payload"]["query"]["filter"]
    assert page_filter["name"] == {"_icontains": "budget"}
    # The count must use the same filter, or the header number disagrees with
    # the list the host is looking at.
    assert count_filter == page_filter


@pytest.mark.asyncio
async def test_blank_search_is_ignored(patched) -> None:
    await list_chats(auth=None, project_id="p-1", q="   ", **_DEFAULTS)

    page_filter = patched.queries[0]["payload"]["query"]["filter"]
    assert "name" not in page_filter


@pytest.mark.asyncio
async def test_absent_search_is_ignored(patched) -> None:
    await list_chats(auth=None, project_id="p-1", q=None, **_DEFAULTS)

    page_filter = patched.queries[0]["payload"]["query"]["filter"]
    assert "name" not in page_filter


@pytest.mark.asyncio
async def test_search_composes_with_has_messages(patched) -> None:
    await list_chats(
        auth=None,
        project_id="p-1",
        q="budget",
        limit=15,
        offset=0,
        has_messages=True,
    )

    page_filter = patched.queries[0]["payload"]["query"]["filter"]
    assert page_filter["name"] == {"_icontains": "budget"}
    assert page_filter["count(project_chat_messages)"] == {"_gt": 0}
