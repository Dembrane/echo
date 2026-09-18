from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from dembrane.api import feature_flags
from dembrane.popcorn import present, service
from dembrane.api.v2.bff import present as present_api


class _MemoryRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.renewals: list[tuple[str, ...]] = []

    async def set(self, key, value, *, ex=None, nx=False):  # noqa: ARG002
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)

    async def eval(self, script, _numkeys, key, token, *args):
        if self.values.get(key) != token:
            return 0
        if "expire" in script:
            self.renewals.append((key, *args))
            return 1
        self.values.pop(key, None)
        return 1


@pytest.fixture(autouse=True)
def _settings_lock_redis(monkeypatch):
    redis = _MemoryRedis()

    async def get_redis():
        return redis

    monkeypatch.setattr(service, "get_redis_client", get_redis)
    return redis


@pytest.mark.parametrize(
    "stored,code,reason",
    [
        ("nl", "nl", None),
        ("de-DE", "de", None),
        ("uk", "uk", None),
        ("cs_CZ", "cs", None),
        ("multi", "en", "multilingual"),
        (None, "en", "not_set"),
        ("invalid", "en", "not_set"),
    ],
)
def test_project_language_resolution(stored, code, reason):
    assert service.resolve_project_language(stored) == (code, reason)


def test_language_policy_does_not_overwrite_saved_settings():
    original = service.default_settings(title="Room")
    original["presentation"] = service.normalize_presentation({"language_policy": "project"})
    assert service.resolve_presentation_settings(original, {"language": "nl"})["language"] == {
        "ui": "nl",
        "translate_to": "nl",
    }
    assert original["language"]["translate_to"] == ""
    original["presentation"]["language_policy"] = "explicit"
    original["language"] = {"ui": "fr", "translate_to": "fr"}
    assert (
        service.resolve_presentation_settings(original, {"language": "nl"})["language"]["ui"]
        == "fr"
    )


class MemoryDirectus:
    def __init__(self):
        self.rows = {}
        self.next_report_id = 1

    async def get_item(self, collection, identity):
        await asyncio.sleep(0)
        return self.rows.get(collection, {}).get(identity)

    async def get_items(self, collection, params=None):
        await asyncio.sleep(0)
        rows = list(self.rows.get(collection, {}).values())
        filters = ((params or {}).get("query") or {}).get("filter") or {}
        report_id = (filters.get("report_id") or {}).get("_eq")
        if report_id is not None:
            rows = [row for row in rows if str(row.get("report_id")) == str(report_id)]
        return rows[-1:]

    async def create_item(self, collection, data):
        await asyncio.sleep(0)
        rows = self.rows.setdefault(collection, {})
        data = dict(data)
        if collection == "project_report":
            if "id" in data:
                raise AssertionError("project_report uses a database-generated bigint id")
            data["id"] = self.next_report_id
            self.next_report_id += 1
        if data["id"] in rows:
            raise ValueError("duplicate primary key")
        rows[data["id"]] = data
        return {"data": rows[data["id"]]}


def test_concurrent_default_creation_and_partial_retry(monkeypatch):
    fake = MemoryDirectus()
    monkeypatch.setattr(service, "async_directus", fake)

    async def existing(_):
        return next(iter(fake.rows.get("project_report", {}).values()), None)

    async def unexpected(*args, **kwargs):
        raise AssertionError("creation must not dispatch work")

    monkeypatch.setattr(service, "get_popcorn_report", existing)
    monkeypatch.setattr(service, "dispatch_popcorn_tick_now_with_safety", unexpected)

    async def run():
        rows = await asyncio.gather(
            *[
                present.ensure_default({"id": "p", "name": "", "language": "nl"}, "host")
                for _ in range(6)
            ]
        )
        assert len({row["id"] for row in rows}) == 1
        fake.rows["agent_loop"].clear()
        await present.ensure_default({"id": "p", "name": "", "language": "nl"}, "host")

    asyncio.run(run())
    assert all(
        len(fake.rows[name]) == 1
        for name in ("project_report", "canvas_config_revision", "agent_loop")
    )
    assert next(iter(fake.rows["project_report"])) == 1
    settings = next(iter(fake.rows["canvas_config_revision"].values()))["popcorn_settings"]
    assert settings["title"] == "Presentatie"
    assert settings["presentation"]["blocks"] == ["popcorn"]
    assert settings["presentation"]["language_policy"] == "project"
    assert settings["tabs"] == {"tensions": False, "stakeholders": False}
    assert settings["intro"] == {
        "enabled": True,
        "title": "Presentatie",
        "subtitle": "",
    }
    assert settings["data"] == {"enabled": True}
    assert not settings["public"]


def test_lock_holder_knows_when_another_writer_took_the_key(_settings_lock_redis) -> None:
    redis = _settings_lock_redis
    key = "popcorn:settings-write:presentation"

    async def run() -> None:
        async with service.settings_write_lock("presentation") as holder:
            assert await holder.still_held() is True
            # What an expired TTL looks like: the key is someone else's now.
            redis.values[key] = "another-writer"
            assert await holder.still_held() is False

    asyncio.run(run())
    assert redis.values[key] == "another-writer"


def test_legacy_creation_takes_the_presentation_create_lock(monkeypatch) -> None:
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from dembrane.api.v2.bff import popcorn as popcorn_api

    order: list[str] = []

    @asynccontextmanager
    async def lock(project_id: str):
        order.append(f"lock:{project_id}")
        try:
            yield None
        finally:
            order.append("unlock")

    async def existing(_project_id):
        order.append("read")
        return None

    async def create(**_kwargs):
        order.append("create")
        return {"report": {"id": "r"}}

    async def payload(_report):
        return {"id": "r"}

    monkeypatch.setattr(popcorn_api, "resolve_project_access", AsyncMock(return_value=_Access()))
    monkeypatch.setattr(popcorn_api, "require_project_popcorn_enabled", lambda _project: None)
    monkeypatch.setattr(popcorn_api, "presentation_create_lock", lock)
    monkeypatch.setattr(popcorn_api, "get_popcorn_report", existing)
    monkeypatch.setattr(popcorn_api, "create_popcorn", create)
    monkeypatch.setattr(popcorn_api, "popcorn_payload", payload)

    asyncio.run(
        popcorn_api.create_project_popcorn(
            popcorn_api.CreatePopcornBody(project_id="p", title="Room"),
            SimpleNamespace(user_id="host"),
        )
    )
    assert order == ["lock:p", "read", "create", "unlock"]


def test_existing_presentation_keeps_random_component_ids_and_settings(monkeypatch) -> None:
    fake = MemoryDirectus()
    report = {"id": 73, "project_id": "p", "user_instructions": "Existing"}
    original = service.default_settings(title="Existing")
    original["presentation"] = service.normalize_presentation(
        {"blocks": ["tensions"], "language_policy": "explicit"}
    )
    fake.rows = {
        "project_report": {73: report},
        "canvas_config_revision": {
            "random-config": {
                "id": "random-config",
                "report_id": 73,
                "popcorn_settings": original,
            }
        },
        "agent_loop": {"random-loop": {"id": "random-loop", "report_id": 73}},
    }
    monkeypatch.setattr(service, "async_directus", fake)
    monkeypatch.setattr(
        service, "get_popcorn_report", lambda _project_id: asyncio.sleep(0, result=report)
    )

    result = asyncio.run(
        present.ensure_default({"id": "p", "name": "Changed", "language": "nl"}, "host")
    )

    assert result is report
    assert set(fake.rows["canvas_config_revision"]) == {"random-config"}
    assert set(fake.rows["agent_loop"]) == {"random-loop"}
    assert fake.rows["canvas_config_revision"]["random-config"]["popcorn_settings"] == original


def test_empty_presentation_bundle_keeps_intro_and_data_before_results() -> None:
    settings = service.default_settings(title="Welcome")
    settings["intro"] = {
        "enabled": True,
        "title": "Welcome to the room",
        "subtitle": "We will listen together",
    }
    settings["data"] = {"enabled": True}

    bundle = service.build_bundle(
        state=service.fresh_state(),
        settings=settings,
        report={"id": "presentation", "date_created": None},
        project={
            "id": "project",
            "language": "en",
            "anonymize_transcripts": True,
            "legal_basis": "consent",
        },
        participant_base_url="https://participants.example",
    )

    assert set(bundle["files"]) == {"session.json"}
    session = bundle["files"]["session.json"]
    assert session["transcripts"] == []
    assert session["intro"]["title"] == "Welcome to the room"
    assert session["data"]["steps"][1]["image"] == "talk-anon"
    assert "tensions.json" not in bundle["files"]
    assert "stakeholders.json" not in bundle["files"]


def test_present_does_not_widen_canvas_gate(monkeypatch):
    flags = SimpleNamespace(enable_present=True, enable_canvas=False)
    monkeypatch.setattr(feature_flags, "get_settings", lambda: SimpleNamespace(feature_flags=flags))
    feature_flags.require_project_popcorn_enabled({"id": "p", "is_canvas_enabled": False})
    with pytest.raises(HTTPException):
        feature_flags.require_project_canvas_enabled({"id": "p", "is_canvas_enabled": True})
    flags.enable_present = False
    with pytest.raises(HTTPException):
        feature_flags.require_project_popcorn_enabled({"id": "p", "is_canvas_enabled": True})


def test_map_projection_excludes_host_fields():
    graph = {
        "version": 2,
        "nodes": [
            {
                "objectId": "o",
                "revisionId": "r",
                "type": "argument",
                "label": "Finding",
                "embedding": [1, 2],
                "attributes": {"valence": "neutral"},
                "detail": {
                    "evidence": ["secret"],
                    "consolidation": {"memberCount": 3, "members": ["secret"]},
                },
                "provenance": {"conversationId": "private"},
                "factCheck": {"eligible": True, "claimKey": "secret"},
            }
        ],
        "snapshot": {"id": "s", "stale": ["secret"]},
        "relations": [{"source": "secret"}],
        "related": ["secret"],
    }
    result = present.sanitize_map(graph)
    assert "secret" not in str(result) and "private" not in str(result)
    assert result["nodes"][0]["factCheck"] == {"eligible": False}
    assert result["nodes"][0]["detail"]["consolidation"] == {"memberCount": 3}
    assert result["nodes"][0]["label"] == "Finding"


def test_map_hiding_takes_the_departed_revisions_with_it():
    payload = {
        "nodes": [
            {"objectId": "keep", "revisionId": "r1"},
            {"objectId": "gone", "revisionId": "r2"},
        ],
        "unplaced": ["r1", "r2"],
    }
    assert present._curate_map(payload, None) is payload
    curated = present._curate_map(payload, {"presentation": {"hidden_items": ["gone"]}})
    assert [node["objectId"] for node in curated["nodes"]] == ["keep"]
    assert curated["unplaced"] == ["r1"]
    # Curation runs before the fact checks are attached, so it invents no key.
    assert "fact_checks" not in curated

    class _Withdrawn:
        async def current_revisions(self, project_id, scope_ids=None):  # noqa: ARG002
            extra = {"membershipExcluded": True}
            return {"gone": SimpleNamespace(provenance=SimpleNamespace(extra=extra))}

    curated["fact_checks"] = {"r1": {"verdict": "true"}, "r2": {"verdict": "false"}}
    withdrawn = asyncio.run(present._withdraw_map(curated, "p", _Withdrawn()))
    assert withdrawn["fact_checks"] == {"r1": {"verdict": "true"}}
    assert withdrawn["unplaced"] == ["r1"]


def test_curating_the_bundle_drops_hidden_objects_and_their_relations():
    from dembrane.popcorn.bundle import curate_presentation

    bundle = {
        "files": {
            "popcorn.json": {"items": [{"objectId": "gone"}, {"objectId": "stays"}]},
            "stakeholders.json": {
                "stakeholders": [{"id": "a"}, {"id": "gone"}],
                "relations": [{"between": ["a", "gone"]}, {"between": ["a", "a"]}],
            },
            "index.html": "<!doctype html>",
        }
    }
    assert curate_presentation(bundle, {}) is bundle
    files = curate_presentation(bundle, {"presentation": {"hidden_items": ["gone"]}})["files"]
    assert files["popcorn.json"]["items"] == [{"objectId": "stays"}]
    assert files["stakeholders.json"]["stakeholders"] == [{"id": "a"}]
    assert files["stakeholders.json"]["relations"] == [{"between": ["a", "a"]}]
    assert files["index.html"] == "<!doctype html>"
    # The bundle handed in is left as it was; the caller may still be holding it.
    assert len(bundle["files"]["popcorn.json"]["items"]) == 2


class _Access:
    project = {"id": "p", "language": "nl"}

    def __init__(self) -> None:
        self.required: list[str] = []

    def require(self, permission: str) -> None:
        self.required.append(permission)

    def allows(self, permission: str) -> bool:  # noqa: ARG002
        return False


@pytest.mark.parametrize(
    ("phrase_count", "run_count", "expected_prepares"),
    [(0, 0, ["popcorn"]), (0, 1, []), (2, 0, [])],
)
def test_start_only_prepares_missing_popcorn(
    monkeypatch, phrase_count: int, run_count: int, expected_prepares: list[str]
) -> None:
    access = _Access()
    prepared: list[str] = []

    async def resolve(*args, **kwargs):  # noqa: ARG001
        return access

    async def ensure(*args, **kwargs):  # noqa: ARG001
        return {"id": "presentation"}

    async def adopt(*args, **kwargs):  # noqa: ARG001
        return None

    async def payload(*args, **kwargs):  # noqa: ARG001
        return {
            "settings": {
                "tabs": {"tensions": False, "stakeholders": False},
                "presentation": service.normalize_presentation({"blocks": ["popcorn"]}),
            },
            "counts": {"phrases": phrase_count},
        }

    async def loop(*args, **kwargs):  # noqa: ARG001
        return {"popcorn_state": {"run": run_count}}

    async def readiness(*args, **kwargs):  # noqa: ARG001
        return {"conversations": 1}

    async def prepare(report, project_id, actor_id, block):  # noqa: ARG001
        prepared.append(block)

    monkeypatch.setattr(present_api, "resolve_project_access", resolve)
    monkeypatch.setattr(present_api.present, "ensure_default", ensure)
    monkeypatch.setattr(present_api.present, "adopt_results", adopt)
    monkeypatch.setattr(present_api.present, "payload", payload)
    monkeypatch.setattr(present_api.service, "get_loop_for_report", loop)
    monkeypatch.setattr(present_api.service, "readiness", readiness)
    monkeypatch.setattr(present_api, "_prepare_block", prepare)

    auth = SimpleNamespace(user_id="host")
    asyncio.run(present_api.start_presentation("p", auth))
    assert access.required == ["project:update"]
    assert prepared == expected_prepares


def test_opening_present_is_read_only(monkeypatch) -> None:
    access = _Access()

    async def resolve(*args, **kwargs):  # noqa: ARG001
        return access

    async def report(*args, **kwargs):  # noqa: ARG001
        return {"id": "presentation"}

    async def payload(*args, **kwargs):  # noqa: ARG001
        return {"id": "presentation"}

    async def must_not_run(*args, **kwargs):  # noqa: ARG001
        raise AssertionError("opening Present must not start model-backed work")

    monkeypatch.setattr(present_api, "resolve_project_access", resolve)
    monkeypatch.setattr(present_api.service, "get_popcorn_report", report)
    monkeypatch.setattr(
        present_api.service,
        "get_latest_config",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"id": "config"}),
    )
    monkeypatch.setattr(
        present_api.service,
        "get_loop_for_report",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"id": "loop"}),
    )
    monkeypatch.setattr(present_api.present, "payload", payload)
    monkeypatch.setattr(present_api.service, "dispatch_popcorn_tick_now_with_safety", must_not_run)
    monkeypatch.setattr(present_api.service, "readiness", must_not_run)

    auth = SimpleNamespace(user_id="host")
    result = asyncio.run(present_api.project_presentation("p", auth))
    assert access.required == ["project:read"]
    assert result == {"presentation": {"id": "presentation"}, "can_edit": False}


def test_incomplete_presentation_reads_as_missing_so_default_post_can_repair(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    access = _Access()
    monkeypatch.setattr(present_api, "resolve_project_access", AsyncMock(return_value=access))
    monkeypatch.setattr(
        present_api.service,
        "get_popcorn_report",
        AsyncMock(return_value={"id": 42}),
    )
    monkeypatch.setattr(present_api.service, "get_latest_config", AsyncMock(return_value=None))
    payload = AsyncMock(side_effect=AssertionError("partial report must not be exposed"))
    monkeypatch.setattr(present_api.present, "payload", payload)

    result = asyncio.run(present_api.project_presentation("p", SimpleNamespace(user_id="host")))

    assert result == {"presentation": None, "can_edit": False}
    payload.assert_not_called()


def test_malformed_presentation_containers_normalize_safely() -> None:
    settings = service.normalize_settings(
        {
            "presentation": {
                "blocks": 42,
                "hidden_items": "not-a-list",
                "result_bindings": ["not-a-mapping"],
            }
        },
        fallback_title="Presentation",
    )
    assert settings["presentation"] == {
        "version": 1,
        "blocks": ["popcorn"],
        "opening": "popcorn",
        "language_policy": "explicit",
        "hidden_items": [],
        "result_bindings": {},
    }


def test_presentation_blocks_always_follow_recipe_complexity_order() -> None:
    settings = service.normalize_settings(
        {
            "presentation": {
                "blocks": ["stakeholders", "map", "popcorn", "tensions", "map"],
                "opening": "map",
            }
        },
        fallback_title="Presentation",
    )
    assert settings["presentation"]["blocks"] == [
        "popcorn",
        "tensions",
        "map",
        "stakeholders",
    ]
    assert settings["presentation"]["opening"] == "map"


def test_presentation_opening_falls_back_to_canonical_first_and_allows_empty() -> None:
    normalized = service.normalize_presentation(
        {"blocks": ["stakeholders", "tensions"], "opening": "map"}
    )
    assert normalized is not None
    assert normalized["blocks"] == ["tensions", "stakeholders"]
    assert normalized["opening"] == "tensions"
    empty = service.normalize_presentation({"blocks": [], "opening": "popcorn"})
    assert empty is not None
    assert empty["blocks"] == []
    assert empty["opening"] is None


def test_audience_manifest_canonicalizes_existing_scrambled_settings() -> None:
    manifest = present.audience_manifest(
        {
            "presentation": {
                "version": 1,
                "blocks": ["stakeholders", "popcorn", "map", "tensions"],
                "opening": "stakeholders",
            }
        }
    )
    assert manifest == {
        "version": 1,
        "blocks": ["popcorn", "tensions", "map", "stakeholders"],
        "opening": "stakeholders",
    }


def test_settings_save_response_canonicalizes_selected_blocks(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    config = {
        "id": "config",
        "popcorn_settings": {
            "title": "Presentation",
            "presentation": {
                "blocks": ["stakeholders", "popcorn"],
                "opening": "stakeholders",
            },
        },
    }
    update_item = AsyncMock()
    monkeypatch.setattr(service, "get_latest_config", AsyncMock(return_value=config))
    monkeypatch.setattr(service.async_directus, "update_item", update_item)

    from dembrane.canvas import events

    monkeypatch.setattr(events, "publish_generation_nudge", AsyncMock())
    saved = asyncio.run(
        service.update_settings(
            report={"id": "presentation", "user_instructions": "Presentation"},
            patch={
                "presentation": {
                    "blocks": ["stakeholders", "map", "tensions", "popcorn"],
                    "opening": "map",
                }
            },
        )
    )
    assert saved["presentation"]["blocks"] == [
        "popcorn",
        "tensions",
        "map",
        "stakeholders",
    ]
    assert saved["presentation"]["opening"] == "map"
    persisted = update_item.await_args.args[2]["popcorn_settings"]
    assert persisted["presentation"] == saved["presentation"]


def test_present_draft_isolated_from_legacy_edits_until_publish(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    report = {"id": "presentation", "user_instructions": "Published"}
    config = {
        "id": "config",
        "popcorn_settings": service.default_settings(title="Published"),
    }

    async def latest(_report_id):
        return config

    async def update_item(collection, _identity, data):
        if collection == "canvas_config_revision":
            config.update(data)
        return {"data": data}

    monkeypatch.setattr(service, "get_latest_config", latest)
    monkeypatch.setattr(service.async_directus, "update_item", update_item)
    monkeypatch.setattr(service, "get_loop_for_report", AsyncMock(return_value=None))
    from dembrane.canvas import events

    monkeypatch.setattr(events, "publish_generation_nudge", AsyncMock())

    saved = asyncio.run(
        present.save_draft(
            report,
            patch={"title": "Draft", "show_qr": True},
            expected_revision=0,
        )
    )
    assert saved["revision"] == 1
    assert saved["settings"]["title"] == "Draft"
    assert (
        service.normalize_settings(config["popcorn_settings"], fallback_title="Published")["title"]
        == "Published"
    )

    asyncio.run(service.update_settings(report=report, patch={"public_labels": "names"}))
    assert config["popcorn_settings"]["public_labels"] == "names"
    assert config["popcorn_settings"]["_present_draft"]["settings"]["title"] == "Draft"

    published = asyncio.run(present.publish_draft(report, expected_revision=1))
    assert published["published"]["title"] == "Draft"
    assert published["revision"] == 2
    with pytest.raises(present.DraftConflict):
        asyncio.run(present.publish_draft(report, expected_revision=1))
    visible = service.normalize_settings(config["popcorn_settings"], fallback_title="Published")
    assert visible["title"] == "Draft"
    assert visible["show_qr"] is True
    assert "_present_draft" not in visible


def test_publish_drops_the_cached_bundle_before_the_nudge(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    from dembrane.canvas import events
    from dembrane.popcorn import bundle

    report = {"id": "presentation", "user_instructions": "Published"}
    config = {"id": "config", "popcorn_settings": service.default_settings(title="Published")}
    order: list[str] = []

    async def latest(_report_id):
        return config

    async def update_item(collection, _identity, data):
        order.append(f"write:{collection}")
        config.update(data)
        return {"data": data}

    async def nudge(report_id):
        order.append(f"nudge:{report_id}")

    monkeypatch.setattr(service, "get_latest_config", latest)
    monkeypatch.setattr(service.async_directus, "update_item", update_item)
    monkeypatch.setattr(service, "get_loop_for_report", AsyncMock(return_value=None))
    monkeypatch.setattr(events, "publish_generation_nudge", nudge)
    monkeypatch.setattr(
        bundle, "forget_bundle", lambda report_id: order.append(f"forget:{report_id}")
    )

    asyncio.run(present.publish_draft(report, expected_revision=0))

    # A viewer refetching on the nudge must not be served the pre-publish deck.
    assert order == [
        "write:canvas_config_revision",
        "forget:presentation",
        "nudge:presentation",
    ]


def test_present_draft_rejects_stale_revision(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    settings = service.default_settings(title="Published")
    settings["_present_draft"] = {
        "revision": 3,
        "saved_at": "now",
        "settings": service.default_settings(title="Draft"),
    }
    monkeypatch.setattr(
        service,
        "get_latest_config",
        AsyncMock(return_value={"id": "config", "popcorn_settings": settings}),
    )
    with pytest.raises(present.DraftConflict):
        asyncio.run(
            present.save_draft(
                {"id": "presentation", "user_instructions": "Published"},
                patch={"title": "Stale"},
                expected_revision=2,
            )
        )


def test_concurrent_draft_saves_with_same_revision_only_commit_once(monkeypatch) -> None:
    settings = service.default_settings(title="Published")
    config = {"id": "config", "popcorn_settings": settings}

    async def latest(_report_id):
        await asyncio.sleep(0)
        return config

    async def update_item(_collection, _identity, data):
        await asyncio.sleep(0)
        config.update(data)
        return {"data": data}

    monkeypatch.setattr(service, "get_latest_config", latest)
    monkeypatch.setattr(service.async_directus, "update_item", update_item)
    report = {"id": "presentation", "user_instructions": "Published"}

    async def save(title):
        return await present.save_draft(report, patch={"title": title}, expected_revision=0)

    async def run():
        return await asyncio.gather(save("First"), save("Second"), return_exceptions=True)

    results = asyncio.run(run())
    committed = [result for result in results if isinstance(result, dict)]
    conflicts = [result for result in results if isinstance(result, present.DraftConflict)]
    assert len(committed) == 1
    assert len(conflicts) == 1
    assert config["popcorn_settings"]["_present_draft"]["revision"] == 1


def test_concurrent_draft_and_legacy_settings_writes_preserve_both(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    config = {
        "id": "config",
        "popcorn_settings": service.default_settings(title="Published"),
    }

    async def latest(_report_id):
        await asyncio.sleep(0)
        return config

    async def update_item(_collection, _identity, data):
        await asyncio.sleep(0)
        config.update(data)
        return {"data": data}

    monkeypatch.setattr(service, "get_latest_config", latest)
    monkeypatch.setattr(service.async_directus, "update_item", update_item)
    from dembrane.canvas import events

    monkeypatch.setattr(events, "publish_generation_nudge", AsyncMock())
    report = {"id": "presentation", "user_instructions": "Published"}

    async def run():
        return await asyncio.gather(
            present.save_draft(report, patch={"title": "Draft"}, expected_revision=0),
            service.update_settings(report=report, patch={"public_labels": "names"}),
        )

    asyncio.run(run())
    assert config["popcorn_settings"]["public_labels"] == "names"
    draft = config["popcorn_settings"]["_present_draft"]
    assert draft["revision"] == 1
    assert draft["settings"]["title"] == "Draft"


def test_draft_preview_routes_use_a_separate_authenticated_namespace() -> None:
    paths = {route.path for route in present_api.router.routes}
    assert "/{presentation_id}/draft/audience" in paths
    assert "/{presentation_id}/draft/map" in paths
    assert "/{presentation_id}/draft/deck/" in paths
    assert "/{presentation_id}/draft/deck/data/bundle.json" in paths


@pytest.mark.parametrize("block", ["tensions", "stakeholders", "map"])
def test_start_reuses_adopted_results_without_legacy_state(monkeypatch, block):
    from unittest.mock import AsyncMock

    access = _Access()
    detail = {
        "settings": {
            "presentation": service.normalize_presentation(
                {
                    "blocks": [block],
                    "result_bindings": {block: "analysis:ready-snapshot"},
                }
            ),
        },
        "counts": {"phrases": 0},
    }
    monkeypatch.setattr(present_api, "resolve_project_access", AsyncMock(return_value=access))
    monkeypatch.setattr(present, "ensure_default", AsyncMock(return_value={"id": "room"}))
    monkeypatch.setattr(present, "adopt_results", AsyncMock())
    monkeypatch.setattr(present, "payload", AsyncMock(return_value=detail))
    monkeypatch.setattr(service, "get_loop_for_report", AsyncMock(return_value={}))
    readiness = AsyncMock(side_effect=AssertionError("A ready result must not start processing"))
    monkeypatch.setattr(service, "readiness", readiness)
    result = asyncio.run(present_api.start_presentation("p", SimpleNamespace(user_id="host")))
    assert result == detail
    readiness.assert_not_called()


def test_audience_assessments_only_carry_completed_visible_revisions():
    visible = {"nodes": [{"revisionId": "r"}, {"revisionId": "pending"}]}
    states = {
        "r": {
            "status": "done",
            "verdict": "contested",
            "justification": "Evidence differs.",
            "checkedAt": "now",
            "sources": [{"url": "private"}],
            "claimKey": "private",
        },
        "pending": {"status": "processing", "startedAt": "now"},
        "hidden": {"status": "done", "verdict": "true", "justification": "private"},
    }
    projected = present.audience_assessments(states, visible)
    assert list(projected) == ["r"]
    assert projected["r"]["verdict"] == "contested"
    assert "private" not in str(projected)


@pytest.mark.parametrize("language", ["en", "nl", "de", "fr", "es", "it", "uk", "cs"])
def test_data_explanation_follows_language_and_actual_policy(language):
    assert set(service.DATA_COPY[language]) == set(service.DATA_COPY["en"])
    assert set(service.DATA_COPY[language]["legal"]) == set(service.DATA_COPY["en"]["legal"])
    project = {
        "legal_basis": "consent",
        "anonymize_transcripts": True,
        "privacy_policy_url": "https://example.org/privacy",
    }
    screen = service.data_screen(project, language)
    assert screen["title"] == service.DATA_COPY[language]["title"]
    assert screen["steps"][1]["image"] == "talk-anon"
    assert screen["notes"][0] == service.DATA_COPY[language]["legal"]["consent"]
    assert screen["links"][0]["url"] == project["privacy_policy_url"]
    project.update(legal_basis="client-managed", anonymize_transcripts=False)
    screen = service.data_screen(project, language)
    assert screen["steps"][1]["image"] == "talk-public"
    assert screen["notes"][0] == service.DATA_COPY[language]["legal"]["client-managed"]
    assert screen["links"] == [service.DATA_COPY[language]["trust"]]


def test_settings_write_is_refused_once_the_lock_was_lost(monkeypatch, _settings_lock_redis):
    # A stall past the lease lets another writer in. The stalled writer must
    # not then write its older settings over theirs.
    from unittest.mock import AsyncMock

    settings = service.default_settings(title="Room")

    async def _config(report_id: str):  # noqa: ARG001
        # The lease ran out while this read was in flight; someone else holds it.
        _settings_lock_redis.values["popcorn:settings-write:room"] = "another-writer"
        return {"id": "config", "popcorn_settings": settings}

    update = AsyncMock()
    monkeypatch.setattr(service, "get_latest_config", _config)
    monkeypatch.setattr(service.async_directus, "update_item", update)

    with pytest.raises(service.SettingsWriteLockError):
        asyncio.run(
            service.update_settings(
                report={"id": "room", "user_instructions": "Room"}, patch={"show_qr": False}
            )
        )
    update.assert_not_called()
    # The other writer's lock is still theirs.
    assert _settings_lock_redis.values["popcorn:settings-write:room"] == "another-writer"


def test_lock_errors_are_a_retryable_503_not_a_500() -> None:
    from fastapi.testclient import TestClient

    from dembrane.main import app

    assert issubclass(service.SettingsWriteLockError, service.LockUnavailable)
    assert issubclass(service.PresentationCreateLockError, service.LockUnavailable)
    handler = app.exception_handlers[service.LockUnavailable]
    response = asyncio.run(
        handler(None, service.SettingsWriteLockError("Settings are busy; try again"))
    )
    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    assert b"Settings are busy" in response.body
    del TestClient


def test_a_bindings_patch_names_only_what_it_adopts() -> None:
    # Two adopters each send the block they found. Neither may drop the other's.
    current = service.default_settings(title="Room")
    current["presentation"] = service.normalize_presentation(
        {"blocks": ["popcorn", "tensions", "map"], "result_bindings": {"map": "M"}}
    )
    merged = service.merge_settings(
        current,
        {"presentation": {"result_bindings": {"tensions": "analysis:T"}}},
        fallback_title="Room",
    )
    assert merged["presentation"]["result_bindings"] == {"map": "M", "tensions": "analysis:T"}
    assert merged["presentation"]["blocks"] == ["popcorn", "tensions", "map"]


def test_initial_adoption_is_decided_under_the_lock(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    stored = service.default_settings(title="Room")
    stored["presentation"] = service.normalize_presentation(
        {"blocks": ["popcorn", "map"], "result_bindings": {}}
    )
    config = {"id": "config", "popcorn_settings": stored}

    async def _update(collection, item_id, payload):  # noqa: ARG001
        if collection == "canvas_config_revision":
            config["popcorn_settings"] = payload["popcorn_settings"]

    async def _available(_report, _project_id):
        # While this adopter was looking, the host adopted a newer map.
        config["popcorn_settings"]["presentation"]["result_bindings"] = {"map": "newer"}
        return {"map": "older"}

    monkeypatch.setattr(service, "get_latest_config", AsyncMock(side_effect=lambda _id: config))
    monkeypatch.setattr(service.async_directus, "update_item", _update)
    monkeypatch.setattr(service, "_invalidate_and_nudge", AsyncMock())
    monkeypatch.setattr(present, "available_bindings", _available)

    asyncio.run(
        present.adopt_results({"id": "room", "user_instructions": "Room"}, "p", initial_only=True)
    )
    assert config["popcorn_settings"]["presentation"]["result_bindings"] == {"map": "newer"}


def test_a_held_lock_renews_its_lease_and_notices_losing_it(_settings_lock_redis) -> None:
    async def scenario() -> tuple[bool, bool]:
        async with service._redis_lock(
            "popcorn:test-lock",
            ttl_seconds=0.03,
            wait_seconds=0.1,
            error=service.SettingsWriteLockError,
            busy_message="busy",
            unavailable_message="unavailable",
            log_label="test",
        ) as holder:
            await asyncio.sleep(0.05)
            renewed = await holder.still_held()
            _settings_lock_redis.values["popcorn:test-lock"] = "another-writer"
            await asyncio.sleep(0.03)
            return renewed, await holder.still_held()

    renewed, after_loss = asyncio.run(scenario())
    assert renewed is True
    assert _settings_lock_redis.renewals
    assert after_loss is False


def test_audience_map_answers_a_store_failure_with_503(monkeypatch) -> None:
    from dembrane.analysis.contracts import AnalysisStoreError

    async def _broken(*args, **kwargs):  # noqa: ARG001
        raise AnalysisStoreError("connection reset")

    monkeypatch.setattr(present, "_audience_map", _broken)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(present.audience_map("p"))
    assert caught.value.status_code == 503
