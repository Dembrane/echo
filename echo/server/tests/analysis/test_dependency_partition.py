"""A recipe that consumes a dependency's output one revision at a time can
declare that dependency partitioned: a step's cache key then carries only the
dependency revisions that step names, while the run's work identity and
publication still carry the whole dependency output."""

from __future__ import annotations

from typing import Any, Mapping, Iterator, Sequence
from collections import Counter

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import (
    RunRequest,
    StepResult,
    RecipeContext,
    request_run,
    execute_inline,
)
from dembrane.analysis.registry import (
    Recipe,
    StepDef,
    Dependency,
    register_recipe,
    unregister_recipe,
)
from dembrane.analysis.contracts import StepKind, RunStatus
from tests.analysis.fixture_recipes import WORDS, FixtureWorld

PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
PARTITIONED = "fixture.judge_partitioned"
WHOLE = "fixture.judge_whole"


def _judge(recipe_id: str, partitioned: tuple[str, ...], calls: Counter[str]) -> Recipe:
    def dependencies(_scope_key: str, _parameters: Mapping[str, Any]) -> Sequence[Dependency]:
        return (Dependency(recipe_id=WORDS, scope_key="project", name="arguments"),)

    async def execute(ctx: RecipeContext) -> None:
        for argument in await ctx.input_revisions("arguments"):

            async def judge(statement: str = argument.payload["statement"]) -> StepResult:
                calls[recipe_id] += 1
                return StepResult(output={"length": len(statement)}, model_calls=1)

            await ctx.step("judge", judge, instance=argument.object_id, inputs={"revision": argument.id})

    return Recipe(
        id=recipe_id,
        version="1",
        name=recipe_id,
        purpose="Judges each pinned argument on its own.",
        input_types=("argument",),
        steps=(StepDef("judge", "1", StepKind.MODEL, "Judge one argument", prompt_ref="fixture/judge-one", prompt_version="1"),),
        output_types=("argument",),
        execute=execute,
        dependencies=dependencies,
        partitioned_inputs=partitioned,
    )


@pytest.fixture
def calls(world: FixtureWorld) -> Iterator[Counter[str]]:
    counter: Counter[str] = Counter()
    register_recipe(_judge(PARTITIONED, ("revisionIds", "dependencies.arguments"), counter), replace=True)
    register_recipe(_judge(WHOLE, ("revisionIds",), counter), replace=True)
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}
    try:
        yield counter
    finally:
        unregister_recipe(PARTITIONED)
        unregister_recipe(WHOLE)


def _request(recipe: str, key: str) -> RunRequest:
    return RunRequest(project_id=PROJECT, recipe_id=recipe, scope_key="project", idempotency_key=key)


async def _ready(store: FakeAnalysisStore, recipe: str, key: str) -> None:
    outcome = await execute_inline(_request(recipe, key), store=store, deps=Recorder().deps())
    assert outcome.run.status == RunStatus.READY


@pytest.mark.asyncio
async def test_a_partitioned_dependency_recomputes_only_the_steps_whose_revisions_changed(
    world: FixtureWorld, calls: Counter[str]
) -> None:
    store = FakeAnalysisStore()
    await _ready(store, PARTITIONED, "p1")
    await _ready(store, WHOLE, "w1")
    assert calls == {PARTITIONED: 3, WHOLE: 3}

    # One statement changes: one new argument revision, two reused.
    world.sources[PROJECT][C2] = ["Bikes are healthy and quick."]
    await _ready(store, WORDS, "words-2")
    await _ready(store, PARTITIONED, "p2")
    await _ready(store, WHOLE, "w2")

    assert calls[PARTITIONED] == 4  # only the changed argument is judged again
    assert calls[WHOLE] == 6  # the safe default: the whole dependency output keys every step


@pytest.mark.asyncio
async def test_a_partitioned_dependency_still_belongs_to_the_run_identity(world: FixtureWorld, calls: Counter[str]) -> None:
    store = FakeAnalysisStore()
    await _ready(store, PARTITIONED, "p1")
    unchanged = await request_run(_request(PARTITIONED, "p2"), store=store, deps=Recorder().deps())
    assert unchanged.outcome == "reused"

    world.sources[PROJECT][C2] = ["Bikes are healthy and quick."]
    await _ready(store, WORDS, "words-2")
    changed = await request_run(_request(PARTITIONED, "p3"), store=store, deps=Recorder().deps())
    assert changed.outcome == "created"
    pinned = changed.run.input_manifest["dependencies"]["arguments"]  # type: ignore[index]
    assert pinned["outputFingerprint"] and calls[PARTITIONED] == 3
