from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from dembrane.canvas import events
from dembrane.popcorn import bundle, service
from dembrane.api.v2.bff import tags


class _Directus:
    async def update_item(self, collection, identity, payload):
        assert collection == "project"
        return {"data": {"id": identity, **payload}}


@pytest.mark.parametrize(
    ("policy", "old_language", "new_language", "expected"),
    [
        ("project", "nl", "de", True),
        ("explicit", "nl", "de", False),
        ("project", "nl", "nl", False),
    ],
)
def test_project_language_change_only_wakes_following_presentation(
    monkeypatch, policy: str, old_language: str, new_language: str, expected: bool
) -> None:
    calls: list[tuple[str, ...]] = []
    access = SimpleNamespace(
        project={"id": "p1", "language": old_language},
        workspace_id=None,
        role="owner",
        require=lambda permission: calls.append(("require", permission)),
    )

    async def resolve(*args, **kwargs):  # noqa: ARG001
        return access

    async def report(*args, **kwargs):  # noqa: ARG001
        return {"id": "present1"}

    async def settings(*args, **kwargs):  # noqa: ARG001
        value = service.default_settings(title="Presentation")
        value["presentation"] = service.normalize_presentation(
            {"language_policy": policy}
        )
        return value

    async def loop(*args, **kwargs):  # noqa: ARG001
        return {"id": "loop1"}

    async def dispatch(loop_id, tick_kind):
        calls.append(("dispatch", loop_id, tick_kind))

    async def nudge(report_id):
        calls.append(("nudge", report_id))

    monkeypatch.setattr(tags, "resolve_project_access", resolve)
    monkeypatch.setattr(tags, "async_directus", _Directus())
    monkeypatch.setattr(service, "get_popcorn_report", report)
    monkeypatch.setattr(service, "load_settings_for", settings)
    monkeypatch.setattr(service, "get_loop_for_report", loop)
    monkeypatch.setattr(service, "dispatch_popcorn_tick_now_with_safety", dispatch)
    monkeypatch.setattr(events, "publish_generation_nudge", nudge)
    monkeypatch.setattr(bundle, "forget_bundle", lambda report_id: calls.append(("forget", report_id)))

    result = asyncio.run(
        tags.update_project(
            "p1", tags.ProjectUpdate(language=new_language), SimpleNamespace(user_id="host")
        )
    )
    assert result["language"] == new_language
    lifecycle = [call for call in calls if call[0] in {"forget", "nudge", "dispatch"}]
    if expected:
        assert lifecycle == [
            ("forget", "present1"),
            ("nudge", "present1"),
            ("dispatch", "loop1", "translation"),
        ]
    else:
        assert lifecycle == []


def test_unrelated_project_save_does_not_read_presentation(monkeypatch) -> None:
    access = SimpleNamespace(
        project={"id": "p1", "language": "nl"},
        workspace_id=None,
        role="owner",
        require=lambda _permission: None,
    )

    async def resolve(*args, **kwargs):  # noqa: ARG001
        return access

    async def unexpected(*args, **kwargs):  # noqa: ARG001
        raise AssertionError("an unrelated save must not inspect or wake Present")

    monkeypatch.setattr(tags, "resolve_project_access", resolve)
    monkeypatch.setattr(tags, "async_directus", _Directus())
    monkeypatch.setattr(service, "get_popcorn_report", unexpected)

    result = asyncio.run(
        tags.update_project(
            "p1", tags.ProjectUpdate(context="New context"), SimpleNamespace(user_id="host")
        )
    )
    assert result["context"] == "New context"
