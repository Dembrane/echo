"""Token-AND wiring in the global search fetchers.

Verifies each fetcher hands Directus an order-independent filter so a
multi-word query matches in any word order, while transcript search stays a
contiguous phrase match. The filter builder itself is unit-tested in
tests/test_search_filters.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from dembrane.api.search import (
    _fetch_chats,
    _fetch_chunks,
    _fetch_projects,
    _all_tokens_filter,
    _fetch_conversations,
)


def _capture_client() -> MagicMock:
    """A Directus client stub that records the query it was handed and
    returns an empty list (we assert on the query, not the results)."""
    client = MagicMock()
    client.get_items.return_value = []
    return client


def _filter_of(client: MagicMock) -> dict:
    # client.get_items(collection, {"query": {...}})
    _collection, params = client.get_items.call_args.args
    return params["query"]["filter"]


def test_fetch_projects_uses_token_and_over_name():
    client = _capture_client()
    _fetch_projects(client, "Annual Budget Review", 15)
    assert _filter_of(client) == {
        "_and": [
            _all_tokens_filter(["name"], "Annual Budget Review"),
            {"deleted_at": {"_null": True}},
        ]
    }


def test_fetch_conversations_uses_token_and_over_text_fields():
    client = _capture_client()
    _fetch_conversations(client, "alice budget", 15)
    filt = _filter_of(client)
    # membership checks avoid coupling to the order of _and clauses
    assert {"deleted_at": {"_null": True}} in filt["_and"]
    # `id` is excluded: Directus rejects _icontains on uuid fields.
    assert (
        _all_tokens_filter(
            ["participant_name", "participant_email", "summary"], "alice budget"
        )
        in filt["_and"]
    )


def test_fetch_chats_uses_token_and_over_name():
    client = _capture_client()
    _fetch_chats(client, "weekly sync", 15)
    filt = _filter_of(client)
    # membership checks avoid coupling to the order of _and clauses
    assert {"deleted_at": {"_null": True}} in filt["_and"]
    # `id` is excluded: Directus rejects _icontains on uuid fields.
    assert _all_tokens_filter(["name"], "weekly sync") in filt["_and"]


def test_fetch_chunks_stays_phrase_match():
    # Transcripts intentionally keep a single contiguous _icontains per field.
    client = _capture_client()
    _fetch_chunks(client, "exact spoken phrase", 15)
    filt = _filter_of(client)
    assert filt == {
        "_or": [
            {"transcript": {"_icontains": "exact spoken phrase"}},
            {"raw_transcript": {"_icontains": "exact spoken phrase"}},
        ]
    }
