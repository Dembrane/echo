from __future__ import annotations

import pytest

from dembrane.api.agentic import (
    _memory_read_or_filter,
    _memory_scope_owner_ids,
)


def test_owner_ids_user_scope_sets_only_the_host():
    assert _memory_scope_owner_ids(
        "user",
        directus_user_id="user-1",
        workspace_id="ws-1",
        project_id="project-1",
    ) == {"directus_user_id": "user-1"}


def test_owner_ids_workspace_scope_sets_only_the_workspace():
    assert _memory_scope_owner_ids(
        "workspace",
        directus_user_id="user-1",
        workspace_id="ws-1",
        project_id="project-1",
    ) == {"workspace_id": "ws-1"}


def test_owner_ids_project_scope_includes_workspace_boundary():
    assert _memory_scope_owner_ids(
        "project",
        directus_user_id="user-1",
        workspace_id="ws-1",
        project_id="project-1",
    ) == {"project_id": "project-1", "workspace_id": "ws-1"}


def test_owner_ids_rejects_unknown_scope():
    with pytest.raises(ValueError):
        _memory_scope_owner_ids(
            "global",
            directus_user_id="user-1",
            workspace_id="ws-1",
            project_id="project-1",
        )


def test_read_or_filter_covers_the_three_readable_scopes():
    assert _memory_read_or_filter(
        directus_user_id="user-1",
        workspace_id="ws-1",
        project_id="project-1",
    ) == {
        "_or": [
            {
                "_and": [
                    {"scope": {"_eq": "user"}},
                    {"directus_user_id": {"_eq": "user-1"}},
                ]
            },
            {
                "_and": [
                    {"scope": {"_eq": "workspace"}},
                    {"workspace_id": {"_eq": "ws-1"}},
                ]
            },
            {
                "_and": [
                    {"scope": {"_eq": "project"}},
                    {"project_id": {"_eq": "project-1"}},
                ]
            },
        ]
    }
