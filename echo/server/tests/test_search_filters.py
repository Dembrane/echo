"""Shared order-independent search filter helpers.

Search must match query words in any order: "review annual budget" should find
a project titled "Annual Budget Review". These cover the token splitter, the
token-AND filter builder, and the merge helper used by the workspace project
list to combine token-AND name search with an existing access filter.
"""

from __future__ import annotations

from dembrane.search_filters import tokens, all_tokens_filter, merge_search_filter


def test_tokens_splits_on_whitespace_and_drops_empties():
    assert tokens("annual budget review") == ["annual", "budget", "review"]
    assert tokens("  multiple   spaces\tand\ntabs ") == [
        "multiple",
        "spaces",
        "and",
        "tabs",
    ]
    assert tokens("") == []
    assert tokens("   ") == []


def test_all_tokens_filter_ands_every_token_over_fields():
    assert all_tokens_filter(["name"], "annual budget") == {
        "_and": [
            {"_or": [{"name": {"_icontains": "annual"}}]},
            {"_or": [{"name": {"_icontains": "budget"}}]},
        ]
    }


def test_all_tokens_filter_empty_term_returns_empty():
    assert all_tokens_filter(["name"], "") == {}
    assert all_tokens_filter(["name"], "   ") == {}


def test_merge_search_filter_ands_base_with_token_filter():
    base = {"workspace_id": {"_eq": "ws-1"}, "deleted_at": {"_null": True}}
    merged = merge_search_filter(base, "annual budget review", ["name"])
    assert merged == {
        "_and": [
            base,
            {
                "_and": [
                    {"_or": [{"name": {"_icontains": "annual"}}]},
                    {"_or": [{"name": {"_icontains": "budget"}}]},
                    {"_or": [{"name": {"_icontains": "review"}}]},
                ]
            },
        ]
    }


def test_merge_search_filter_blank_term_is_noop():
    base = {"workspace_id": {"_eq": "ws-1"}, "deleted_at": {"_null": True}}
    assert merge_search_filter(base, "", ["name"]) is base
    assert merge_search_filter(base, "   ", ["name"]) is base


def test_merge_search_filter_defaults_to_name_field():
    base = {"deleted_at": {"_null": True}}
    merged = merge_search_filter(base, "budget")
    assert merged == {
        "_and": [
            base,
            {"_and": [{"_or": [{"name": {"_icontains": "budget"}}]}]},
        ]
    }
