"""Recipe dependency plans: which producer scopes a request needs, in order.

The plan is over execution dependencies (tensions need arguments), not content
relations (a stakeholder may hold a position on a tension that cites that
stakeholder's argument; that cycle is fine). A cycle in execution dependencies
is rejected with its path before anything is written or any model is called.
"""

from __future__ import annotations

from typing import Any, Mapping, Callable
from dataclasses import field, dataclass

from dembrane.analysis.hashing import canonical_json
from dembrane.analysis.registry import Recipe, get_recipe
from dembrane.analysis.contracts import AnalysisValidationError

MAX_PLAN_NODES = 64


class DependencyCycle(AnalysisValidationError):
    def __init__(self, path: list[str]) -> None:
        super().__init__("recipe dependency cycle: " + " -> ".join(path))
        self.path = path


class PlanConflict(AnalysisValidationError):
    pass


def node_key(recipe_id: str, scope_key: str) -> str:
    return f"{recipe_id}@{scope_key}"


@dataclass(frozen=True)
class PlanNode:
    key: str
    recipe_id: str
    scope_key: str
    parameters: Mapping[str, Any]
    # (input name, node key) for each direct dependency.
    dependencies: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Plan:
    root: str
    # Dependencies before their dependants; the root is last.
    nodes: tuple[PlanNode, ...] = field(default_factory=tuple)

    def node(self, key: str) -> PlanNode:
        for node in self.nodes:
            if node.key == key:
                return node
        raise KeyError(key)

    @property
    def root_node(self) -> PlanNode:
        return self.nodes[-1]


def build_plan(
    recipe_id: str,
    scope_key: str,
    parameters: Mapping[str, Any] | None = None,
    *,
    lookup: Callable[[str], Recipe] = get_recipe,
) -> Plan:
    ordered: list[PlanNode] = []
    done: dict[str, PlanNode] = {}
    stack: list[str] = []

    def visit(rid: str, skey: str, params: Mapping[str, Any]) -> str:
        key = node_key(rid, skey)
        if key in stack:
            raise DependencyCycle([*stack[stack.index(key) :], key])
        recipe = lookup(rid)
        recipe.validate_scope_key(skey)
        validated = recipe.validate_parameters(params)
        if key in done:
            if canonical_json(dict(done[key].parameters)) != canonical_json(validated):
                raise PlanConflict(f"{key} is needed with two different parameter sets")
            return key
        if len(done) >= MAX_PLAN_NODES:
            raise PlanConflict(f"the plan for {recipe_id} needs more than {MAX_PLAN_NODES} scopes")
        stack.append(key)
        edges: list[tuple[str, str]] = []
        names: set[str] = set()
        for dependency in recipe.dependencies(skey, validated):
            if dependency.input_name in names:
                raise PlanConflict(f"{key} names two dependencies {dependency.input_name!r}")
            names.add(dependency.input_name)
            edges.append(
                (
                    dependency.input_name,
                    visit(dependency.recipe_id, dependency.scope_key, dependency.parameters),
                )
            )
        stack.pop()
        node = PlanNode(
            key=key,
            recipe_id=rid,
            scope_key=skey,
            parameters=validated,
            dependencies=tuple(edges),
        )
        done[key] = node
        ordered.append(node)
        return key

    root = visit(recipe_id, scope_key, parameters or {})
    return Plan(root=root, nodes=tuple(ordered))
