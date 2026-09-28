"""The recipe registry: code-owned recipe definitions, looked up by id.

A recipe declares what analysis happens and in which order, what it accepts
and produces, how its output is checked and how its objects keep their
identity. It does not run itself: `executor` runs every recipe the same way.
Registration is code-owned for now; the metadata is JSON so a Recipes tab can
list, explain and later author recipes through the same definitions.

Unknown recipe ids and invalid requests fail here, before anything is written
or dispatched.
"""

from __future__ import annotations

import re
import importlib
import threading
from typing import TYPE_CHECKING, Any, Mapping, Callable, Sequence, Awaitable
from dataclasses import field, dataclass

from pydantic import BaseModel, ValidationError

from dembrane.analysis import types
from dembrane.analysis.hashing import HASH_VERSION, content_hash
from dembrane.analysis.contracts import StepKind, CheckOutcome, AnalysisValidationError

if TYPE_CHECKING:
    from dembrane.analysis.executor import RecipeContext

RECIPE_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$")
# Declared step keys; a run's step rows add `:<instance>` for repeated steps
# (one extraction per conversation).
STEP_KEY = re.compile(r"^[a-z][a-z0-9_-]*$")
STEP_INSTANCE = re.compile(r"^[A-Za-z0-9_.:@-]{1,96}$")
# `project`, `conversation:<uuid>`, `report:<id>`; recipes narrow it further.
DEFAULT_SCOPE_KEY = re.compile(r"^(project|conversation:[0-9a-f-]{36}|report:[A-Za-z0-9_-]+)$")


class UnknownRecipe(AnalysisValidationError):
    pass


class InvalidRecipeRequest(AnalysisValidationError):
    pass


@dataclass(frozen=True)
class StepDef:
    key: str
    version: str
    kind: StepKind
    description: str
    prompt_ref: str | None = None
    prompt_version: str | None = None
    check_version: str | None = None

    def definition(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "version": self.version,
            "kind": str(self.kind),
            "description": self.description,
            "promptRef": self.prompt_ref,
            "promptVersion": self.prompt_version,
            "checkVersion": self.check_version,
        }


@dataclass(frozen=True)
class Dependency:
    """Another recipe's ready output this recipe consumes, by scope. `name` is
    how the consuming recipe finds the pinned output in its context."""

    recipe_id: str
    scope_key: str
    parameters: Mapping[str, Any] = field(default_factory=dict)
    name: str | None = None

    @property
    def input_name(self) -> str:
        return self.name or self.recipe_id


@dataclass(frozen=True)
class IdentityPolicy:
    """How output objects keep identity across runs. The only policy today is
    producer lineage keys: an object keeps its identity when the producer can
    name the same source item, never because its content looks similar."""

    kind: str = "lineage-key"
    description: str = "Identity follows the producer's lineage key; content similarity never merges identities."

    def definition(self) -> dict[str, Any]:
        return {"kind": self.kind, "description": self.description}


def output_fingerprint(manifest: Mapping[str, Any]) -> str:
    """What a ready output is, whichever run recorded it: its exact revisions
    and its relations' content. A reuse run's copy of a manifest has the same
    output fingerprint as the run it reuses."""
    return content_hash(
        {
            "objects": sorted(str(o["revisionId"]) for o in manifest.get("objects") or []),
            "relations": sorted(
                [str(r.get("type")), str(r.get("from")), str(r.get("to")), str(r.get("contentHash") or r.get("relationId"))]
                for r in manifest.get("relations") or []
            ),
        }
    )


@dataclass(frozen=True)
class PinnedOutput:
    """A dependency's exact ready output, pinned before the consumer runs.
    Objects a host excluded when it was pinned are withdrawn: the consumer
    never sees them."""

    name: str
    recipe_id: str
    scope_key: str
    scope_id: str
    run_id: str
    manifest: Mapping[str, Any]
    withdrawn: tuple[str, ...] = ()

    @property
    def manifest_hash(self) -> str:
        return str(self.manifest.get("contentHash") or content_hash(dict(self.manifest)))

    @property
    def revision_ids(self) -> list[str]:
        withdrawn = set(self.withdrawn)
        return [
            str(item["revisionId"])
            for item in self.manifest.get("objects") or []
            if str(item["objectId"]) not in withdrawn
        ]

    def as_json(self) -> dict[str, Any]:
        return {
            "recipeId": self.recipe_id,
            "scopeKey": self.scope_key,
            "scopeId": self.scope_id,
            "runId": self.run_id,
            "manifestHash": self.manifest_hash,
            "outputFingerprint": output_fingerprint(self.manifest),
            "revisionIds": self.revision_ids,
            **({"withdrawnObjectIds": sorted(self.withdrawn)} if self.withdrawn else {}),
        }


@dataclass(frozen=True)
class InputRequest:
    """What a recipe's input resolver sees. It reads (never writes) and returns
    a JSON input manifest whose hash is the run's input fingerprint."""

    project_id: str
    scope_key: str
    parameters: Mapping[str, Any]
    selected_revision_ids: tuple[str, ...]
    dependencies: Mapping[str, PinnedOutput]
    services: Mapping[str, Any]


def _no_dependencies(_scope_key: str, _parameters: Mapping[str, Any]) -> Sequence[Dependency]:
    return ()


@dataclass(frozen=True)
class Recipe:
    id: str
    version: str
    name: str
    purpose: str
    input_types: tuple[str, ...]
    steps: tuple[StepDef, ...]
    output_types: tuple[str, ...]
    execute: Callable[[RecipeContext], Awaitable[None]]
    dependencies: Callable[[str, Mapping[str, Any]], Sequence[Dependency]] = _no_dependencies
    resolve_inputs: Callable[[InputRequest], Awaitable[dict[str, Any]]] | None = None
    validate: Callable[[RecipeContext], Awaitable[list[CheckOutcome]]] | None = None
    validation_rules: tuple[str, ...] = ()
    identity_policy: IdentityPolicy = field(default_factory=IdentityPolicy)
    # Object types whose Map embedding projection this recipe computes.
    embedding_projections: tuple[str, ...] = ()
    parameters_model: type[BaseModel] | None = None
    scope_key_pattern: re.Pattern[str] = DEFAULT_SCOPE_KEY
    # The model deployment identity, part of every model step's cache key.
    model_config: Callable[[], Mapping[str, Any]] = lambda: {}
    # Backpressure: runs of this recipe running at once across workers (None:
    # unbounded) and model calls at once within one run.
    max_running: int | None = None
    model_concurrency: int = 4
    # Input manifest keys whose parts a step names in its own `inputs` (one
    # conversation's source, say). Every other key is part of every step's
    # cache key, so a step is reused across a change to these keys only by
    # declaring the part it read. `dependencies.<name>` (or `dependencies` for
    # all of them) partitions a dependency's output: its steps name the exact
    # dependency revision ids they consume, and `revisionIds`, which lists
    # them all, is usually partitioned alongside. The run's work identity and
    # publication checks still carry every dependency's whole output.
    partitioned_inputs: tuple[str, ...] = ()

    def step(self, key: str) -> StepDef:
        for step in self.steps:
            if step.key == key:
                return step
        raise InvalidRecipeRequest(f"recipe {self.id} has no step {key!r}")

    def definition(self) -> dict[str, Any]:
        """The immutable definition captured with every run."""
        return {
            "id": self.id,
            "version": self.version,
            "hashVersion": HASH_VERSION,
            "inputTypes": list(self.input_types),
            "outputTypes": list(self.output_types),
            "steps": [step.definition() for step in self.steps],
            "validationRules": list(self.validation_rules),
            "identityPolicy": self.identity_policy.definition(),
            "embeddingProjections": {
                type_id: types.get_object_type(type_id).map.projection_version  # type: ignore[union-attr]
                for type_id in self.embedding_projections
            },
        }

    def metadata(self) -> dict[str, Any]:
        """What a Recipes tab shows: the definition, readable, plus schemas."""
        return {
            **self.definition(),
            "name": self.name,
            "purpose": self.purpose,
            "parametersSchema": self.parameters_model.model_json_schema()
            if self.parameters_model
            else None,
            "outputSchemas": {
                type_id: types.get_object_type(type_id).metadata() for type_id in self.output_types
            },
            "scopeKeyPattern": self.scope_key_pattern.pattern,
            "maxRunning": self.max_running,
            "modelConcurrency": self.model_concurrency,
        }

    def validate_parameters(self, parameters: Mapping[str, Any] | None) -> dict[str, Any]:
        raw = dict(parameters or {})
        if self.parameters_model is None:
            if raw:
                raise InvalidRecipeRequest(f"recipe {self.id} takes no parameters")
            return {}
        try:
            return self.parameters_model.model_validate(raw).model_dump(mode="json")
        except ValidationError as exc:
            first = exc.errors()[0]
            where = ".".join(str(p) for p in first.get("loc", ())) or "(parameters)"
            raise InvalidRecipeRequest(f"invalid parameters for {self.id}: {where}: {first.get('msg')}") from None

    def validate_scope_key(self, scope_key: str) -> str:
        if not isinstance(scope_key, str) or not self.scope_key_pattern.fullmatch(scope_key):
            raise InvalidRecipeRequest(f"recipe {self.id} does not accept scope {scope_key!r}")
        return scope_key


_lock = threading.Lock()
_recipes: dict[str, Recipe] = {}


def _check_definition(recipe: Recipe) -> None:
    if not RECIPE_ID.fullmatch(recipe.id):
        raise ValueError(f"recipe id {recipe.id!r} is not a lowercase dotted name")
    if not recipe.version:
        raise ValueError(f"recipe {recipe.id} has no version")
    if not recipe.steps:
        raise ValueError(f"recipe {recipe.id} declares no steps")
    keys = [step.key for step in recipe.steps]
    if len(set(keys)) != len(keys):
        raise ValueError(f"recipe {recipe.id} repeats a step key")
    for step in recipe.steps:
        if not STEP_KEY.fullmatch(step.key) or not step.version:
            raise ValueError(f"recipe {recipe.id} step {step.key!r} needs a key and a version")
        if step.kind == StepKind.MODEL and not (step.prompt_ref and step.prompt_version):
            raise ValueError(f"recipe {recipe.id} model step {step.key} needs a prompt ref and version")
    for type_id in (*recipe.input_types, *recipe.output_types):
        types.get_object_type(type_id)
    for type_id in recipe.embedding_projections:
        if types.get_object_type(type_id).map is None:
            raise ValueError(f"recipe {recipe.id} embeds {type_id}, which has no Map projection")
    if recipe.max_running is not None and recipe.max_running < 1:
        raise ValueError(f"recipe {recipe.id} max_running must be positive")
    if recipe.model_concurrency < 1:
        raise ValueError(f"recipe {recipe.id} model_concurrency must be positive")


def register_recipe(recipe: Recipe, *, replace: bool = False) -> Recipe:
    _check_definition(recipe)
    with _lock:
        if recipe.id in _recipes and not replace:
            raise ValueError(f"recipe {recipe.id} is already registered")
        _recipes[recipe.id] = recipe
    return recipe


def unregister_recipe(recipe_id: str) -> None:
    with _lock:
        _recipes.pop(recipe_id, None)


_builtins_loaded = False


def load_builtin_recipes() -> None:
    """Import `dembrane.analysis.recipes`, whose modules register the built-in
    recipes, once. A deployment without that package has no built-ins."""
    global _builtins_loaded
    if _builtins_loaded:
        return
    _builtins_loaded = True
    try:
        importlib.import_module("dembrane.analysis.recipes")
    except ModuleNotFoundError as exc:
        if exc.name != "dembrane.analysis.recipes":
            raise


def get_recipe(recipe_id: str) -> Recipe:
    recipe = _recipes.get(recipe_id)
    if recipe is None:
        load_builtin_recipes()
        recipe = _recipes.get(recipe_id)
    if recipe is None:
        raise UnknownRecipe(f"unknown recipe {recipe_id!r}")
    return recipe


def list_recipes() -> list[Recipe]:
    load_builtin_recipes()
    return sorted(_recipes.values(), key=lambda r: r.id)


def recipes_metadata() -> list[dict[str, Any]]:
    return [recipe.metadata() for recipe in list_recipes()]
