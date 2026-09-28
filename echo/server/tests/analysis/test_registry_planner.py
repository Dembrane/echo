from __future__ import annotations

import json
from typing import Any, Iterator
from dataclasses import replace

import pytest
from pydantic import BaseModel

from dembrane.analysis.planner import PlanConflict, DependencyCycle, build_plan
from dembrane.analysis.registry import (
    Recipe,
    StepDef,
    Dependency,
    UnknownRecipe,
    InvalidRecipeRequest,
    get_recipe,
    register_recipe,
    recipes_metadata,
    unregister_recipe,
)
from dembrane.analysis.contracts import StepKind
from tests.analysis.fixture_recipes import PAIRS, WORDS, CYCLE_A, CYCLE_B, FixtureWorld


async def _nothing(_ctx: Any) -> None:
    return None


def _recipe(recipe_id: str, **overrides: Any) -> Recipe:
    base: dict[str, Any] = dict(
        id=recipe_id,
        version="1",
        name=recipe_id,
        purpose="test",
        input_types=(),
        steps=(StepDef("only", "1", StepKind.DETERMINISTIC, "Does nothing"),),
        output_types=("argument",),
        execute=_nothing,
    )
    base.update(overrides)
    return Recipe(**base)


@pytest.fixture
def temporary() -> Iterator[list[str]]:
    ids: list[str] = []
    yield ids
    for recipe_id in ids:
        unregister_recipe(recipe_id)


def test_unknown_recipes_and_invalid_requests_fail(world: FixtureWorld) -> None:  # noqa: ARG001
    with pytest.raises(UnknownRecipe):
        get_recipe("fixture.nothing_here")
    recipe = get_recipe(WORDS)
    with pytest.raises(InvalidRecipeRequest, match="does not accept scope"):
        recipe.validate_scope_key("everything")
    with pytest.raises(InvalidRecipeRequest, match="takes no parameters"):
        recipe.validate_parameters({"threshold": 1})
    assert recipe.validate_scope_key("conversation:11111111-1111-4111-8111-111111111111")


def test_parameters_validate_through_their_model(temporary: list[str]) -> None:
    class Params(BaseModel):
        threshold: float = 0.5

    register_recipe(_recipe("fixture.params", parameters_model=Params))
    temporary.append("fixture.params")
    recipe = get_recipe("fixture.params")
    assert recipe.validate_parameters({}) == {"threshold": 0.5}
    with pytest.raises(InvalidRecipeRequest, match="threshold"):
        recipe.validate_parameters({"threshold": "high"})


def test_metadata_is_json_and_lists_ordered_steps_and_schemas(world: FixtureWorld) -> None:  # noqa: ARG001
    metadata = {m["id"]: m for m in recipes_metadata()}
    words = metadata[WORDS]
    json.dumps(metadata)
    assert [s["key"] for s in words["steps"]] == ["extract", "check"]
    assert words["steps"][0] == {
        "key": "extract",
        "version": "1",
        "kind": "model",
        "description": "Read one conversation's statements",
        "promptRef": "fixture/extract",
        "promptVersion": "1",
        "checkVersion": None,
    }
    assert words["outputSchemas"]["argument"]["payloadSchema"]["required"] == ["statement", "epistemicKind"]
    assert words["embeddingProjections"] == {"argument": "statement-v1"}


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"steps": (StepDef("read", "1", StepKind.MODEL, "no prompt"),)}, "needs a prompt ref"),
        ({"steps": (StepDef("a", "1", StepKind.DETERMINISTIC, "x"), StepDef("a", "1", StepKind.CHECK, "x"))}, "repeats a step key"),
        ({"output_types": ("opinion",)}, "unknown object type"),
        ({"embedding_projections": ("fact_check_assessment",)}, "has no Map projection"),
        ({"version": ""}, "has no version"),
    ],
)
def test_invalid_definitions_are_refused_at_registration(overrides: dict[str, Any], message: str) -> None:
    with pytest.raises(Exception, match=message):
        register_recipe(_recipe("fixture.invalid", **overrides))
    with pytest.raises(UnknownRecipe):
        get_recipe("fixture.invalid")


def test_a_plan_orders_dependencies_before_dependants(world: FixtureWorld) -> None:  # noqa: ARG001
    plan = build_plan(PAIRS, "project")
    assert [node.key for node in plan.nodes] == [f"{WORDS}@project", f"{PAIRS}@project"]
    assert plan.root_node.dependencies == (("arguments", f"{WORDS}@project"),)


def test_a_cycle_is_rejected_with_its_path(world: FixtureWorld) -> None:  # noqa: ARG001
    with pytest.raises(DependencyCycle) as cycle:
        build_plan(CYCLE_A, "project")
    assert cycle.value.path == [f"{CYCLE_A}@project", f"{CYCLE_B}@project", f"{CYCLE_A}@project"]
    assert str(cycle.value) == f"recipe dependency cycle: {CYCLE_A}@project -> {CYCLE_B}@project -> {CYCLE_A}@project"


def test_a_shared_dependency_with_two_parameter_sets_is_a_conflict(temporary: list[str]) -> None:
    class Params(BaseModel):
        level: int = 1

    register_recipe(_recipe("fixture.base", parameters_model=Params))
    register_recipe(_recipe("fixture.left", dependencies=lambda _k, _p: (Dependency("fixture.base", "project", {"level": 1}),)))
    register_recipe(_recipe("fixture.right", dependencies=lambda _k, _p: (Dependency("fixture.base", "project", {"level": 2}),)))
    register_recipe(
        _recipe(
            "fixture.top",
            dependencies=lambda _k, _p: (
                Dependency("fixture.left", "project", name="left"),
                Dependency("fixture.right", "project", name="right"),
            ),
        )
    )
    temporary.extend(["fixture.base", "fixture.left", "fixture.right", "fixture.top"])
    with pytest.raises(PlanConflict, match="two different parameter sets"):
        build_plan("fixture.top", "project")
    register_recipe(replace(get_recipe("fixture.right"), dependencies=lambda _k, _p: (Dependency("fixture.base", "project", {"level": 1}),)), replace=True)
    assert [n.recipe_id for n in build_plan("fixture.top", "project").nodes] == ["fixture.base", "fixture.left", "fixture.right", "fixture.top"]
