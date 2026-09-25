"""Shared pieces for the flow-level tests in `test_flow_invariants*.py`.

- `WorkerDied` stands for a worker process that dies mid-step (killed by a
  deploy, the OOM killer, a time limit). It is a `BaseException`, so no
  `except Exception` in the executor records it as a failure: the run is left
  as a killed process leaves it, running under a lease nobody renews, with
  every step it finished saved.
- `generation_recipes` registers the fixture words recipe as `arguments` (the
  recipe a Map generation runs) and `PAIRS_ON_ARGUMENTS`, the fixture pairs
  recipe reading that output, so a dependant can wait on a Map generation.
- `parallel_recipe` runs one model step per conversation concurrently under a
  single model slot.
- `MapRoutes` drives the Map BFF routes over whichever stores a test hands it
  (in memory or Postgres), with access, rate limits and Redis nudges faked.
"""

from __future__ import annotations

import asyncio
from typing import Any, Mapping, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import replace

import pytest

import dembrane.map.events as map_events
import dembrane.api.v2.bff.map as map_bff
import dembrane.analysis.map_view as map_view
from dembrane.map import service
from tests.analysis.helpers import Recorder
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import StepResult, RecipeContext
from dembrane.analysis.registry import (
    Recipe,
    StepDef,
    Dependency,
    InputRequest,
    UnknownRecipe,
    get_recipe,
    register_recipe,
    unregister_recipe,
)
from dembrane.analysis.contracts import StepKind
from tests.analysis.map_v2_fakes import WRITE, Grants, Limiter, asgi_call
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

ARGUMENTS = map_view.ARGUMENTS_RECIPE_ID
PAIRS_ON_ARGUMENTS = "fixture.pairs_on_arguments"
PARALLEL = "fixture.parallel"
MAP_BASE = "/api/v2/bff/map"


class WorkerDied(BaseException):
    """The worker process went away in the middle of a step."""


class SetupFailed(RuntimeError):
    """A precondition of a flow test did not hold."""


def given(condition: bool, what: str) -> None:
    """A precondition, raised as a setup error rather than an assertion. The
    gap tests are `xfail(raises=AssertionError)`, so a broken setup surfaces
    as a failure instead of passing for the gap."""
    if not condition:
        raise SetupFailed(what)


def _on_arguments(_scope_key: str, _parameters: Mapping[str, Any]) -> Sequence[Dependency]:
    return (Dependency(recipe_id=ARGUMENTS, scope_key="project", name="arguments"),)


@contextmanager
def generation_recipes() -> Iterator[None]:
    """The fixture words recipe as `arguments`, and a pairs recipe on it.
    Needs the fixture recipes registered (the `world` fixture); the real
    `arguments` recipe comes back afterwards."""
    try:
        original = get_recipe(ARGUMENTS)
    except UnknownRecipe:
        original = None
    register_recipe(replace(get_recipe(WORDS), id=ARGUMENTS), replace=True)
    register_recipe(replace(get_recipe(PAIRS), id=PAIRS_ON_ARGUMENTS, dependencies=_on_arguments), replace=True)
    try:
        yield
    finally:
        unregister_recipe(PAIRS_ON_ARGUMENTS)
        if original is not None:
            register_recipe(original, replace=True)
        else:
            unregister_recipe(ARGUMENTS)


def parallel_recipe(world: FixtureWorld) -> Recipe:
    """Every conversation's model step at once, one model slot for the run."""

    async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
        conversations = world.conversations(request.project_id, request.scope_key)
        return {"sources": {cid: content_hash(texts) for cid, texts in sorted(conversations.items())}}

    async def execute(ctx: RecipeContext) -> None:
        conversations = world.conversations(ctx.project_id, ctx.scope_key)

        async def one(cid: str, texts: tuple[str, ...]) -> None:
            async def read() -> StepResult:
                world.model_calls[f"{PARALLEL}:extract"] += 1
                if world.during_model is not None:
                    await world.during_model(f"extract:{cid}")
                return StepResult(output={"items": list(texts)}, model_calls=1)

            await ctx.step("extract", read, instance=cid, inputs={"conversation": cid, "texts": content_hash(list(texts))})

        async with asyncio.TaskGroup() as group:
            for cid, texts in sorted(conversations.items()):
                group.create_task(one(cid, tuple(texts)))

    return Recipe(
        id=PARALLEL,
        version="1",
        name="Fixture parallel",
        purpose="Reads every conversation at once under one model slot.",
        input_types=(),
        steps=(
            StepDef("extract", "1", StepKind.MODEL, "Read one conversation", prompt_ref="fixture/extract", prompt_version="1"),
        ),
        output_types=("argument",),
        execute=execute,
        resolve_inputs=resolve_inputs,
        partitioned_inputs=("sources",),
        model_config=lambda: {"model": "fixture/model", "temperature": 0},
        model_concurrency=1,
    )


class MapRoutes:
    """The Map BFF over the stores a test hands it. Generation runs through
    the executor with the recorder's deps; the outbox's view hook reads with
    `reads`; Redis nudges land in `events`."""

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        *,
        project_id: str,
        store: Any,
        map_store: Any,
        reads: Any,
        rec: Recorder,
    ) -> None:
        self.project_id = project_id
        self.events: list[tuple[str, dict[str, Any]]] = []
        grants = Grants()
        grants.grant(project_id, *WRITE)

        async def publish(pid: str, event: dict[str, Any]) -> None:
            self.events.append((pid, event))

        monkeypatch.setattr(map_bff, "resolve_project_access", grants.resolve)
        monkeypatch.setattr(map_bff, "_generate_limiter", Limiter())
        monkeypatch.setattr(map_bff, "get_store", lambda: map_store)
        monkeypatch.setattr(map_bff, "get_analysis_store", lambda: store)
        monkeypatch.setattr(map_bff, "get_map_view_reads", lambda: reads)
        monkeypatch.setattr(
            service,
            "default_map_analysis",
            lambda: service.MapAnalysis(store=store, reads=reads, deps=rec.deps()),
        )
        monkeypatch.setattr(service, "publish_map_event", publish)
        monkeypatch.setattr(map_events, "publish_map_event", publish)
        monkeypatch.setattr(map_view, "default_reads", lambda: reads)

    async def generate(self) -> Any:
        return await asgi_call(map_bff.router, MAP_BASE, "POST", f"/projects/{self.project_id}/generate")

    async def graph(self, **params: str) -> Any:
        return await asgi_call(
            map_bff.router, MAP_BASE, "GET", f"/projects/{self.project_id}/graph", params=params or None
        )

    def event_types(self) -> list[str]:
        return [event["type"] for _pid, event in self.events]
