"""Test-only recipes that run through the real lifecycle.

`FixtureWorld` scripts the transcripts a recipe reads and counts every model and
embedding call; nothing reaches a network. Recipes:

- `fixture.words`: one model step per conversation reads its statements, a
  shared embedding pass, one `argument` per statement (a claim when the world
  says so), and a check step. An argument's lineage key is its conversation
  and position, so an edited statement is a new revision of the same object.
  Scopes `project` or `conversation:<uuid>`.
- `fixture.pairs`: depends on `fixture.words@project`; one model step pairs
  the pinned arguments into tensions with `supports_pole_a` and
  `supports_pole_b` relations, and a check step.
- `fixture.assess`: depends on `fixture.words@project`; one model step per
  pinned claim returns the world's verdict as a `fact_check_assessment` with
  an `assesses` relation to that exact claim revision.
- `fixture.cycle_a` and `fixture.cycle_b`: depend on each other and must never
  run.
"""

from __future__ import annotations

import hashlib
from typing import Any, Mapping, Callable, Sequence, Awaitable
from collections import Counter

from dembrane.embedding import EmbeddingIdentity
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import StepResult, RecipeContext
from dembrane.analysis.registry import (
    Recipe,
    StepDef,
    Dependency,
    InputRequest,
    register_recipe,
    unregister_recipe,
)
from dembrane.analysis.contracts import (
    StepKind,
    SourceRef,
    CheckStatus,
    CheckOutcome,
    ObjectRevision,
)
from dembrane.analysis.embeddings import EmbeddingService, input_hash

WORDS = "fixture.words"
PAIRS = "fixture.pairs"
ASSESS = "fixture.assess"
CYCLE_A = "fixture.cycle_a"
CYCLE_B = "fixture.cycle_b"


class FixtureWorld:
    def __init__(self, *, dims: int = 4) -> None:
        # project id -> conversation id -> statements
        self.sources: dict[str, dict[str, list[str]]] = {}
        self.claims: set[str] = set()
        self.verdict = "true"
        self.dims = dims
        self.model_calls: Counter[str] = Counter()
        self.embed_calls: list[str] = []
        self.fail_conversations: set[str] = set()
        # Awaited inside a model call before it answers, with a label.
        self.during_model: Callable[[str], Awaitable[None]] | None = None
        # Awaited after the words recipe staged its objects, before its check.
        self.after_emit: Callable[[RecipeContext], Awaitable[None]] | None = None
        # A revision the pairs recipe tries to relate although it is no input.
        self.foreign_revision: ObjectRevision | None = None

    def identity(self) -> EmbeddingIdentity:
        return EmbeddingIdentity(model="fixture/embedding", endpoint="fixture:endpoint", dims=self.dims)

    async def embed(self, text: str) -> list[float]:
        self.embed_calls.append(text)
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        values = [(digest[i] / 255.0) * 2 - 1 for i in range(self.dims)]
        return values if any(values) else [1.0, *values[1:]]

    def conversations(self, project_id: str, scope_key: str) -> dict[str, list[str]]:
        every = self.sources.get(project_id, {})
        if scope_key == "project":
            return dict(every)
        conversation = scope_key.split(":", 1)[1]
        return {conversation: every[conversation]} if conversation in every else {}

    def total_model_calls(self) -> int:
        return sum(self.model_calls.values())


def _passed(check: str, **evidence: Any) -> StepResult:
    return StepResult(
        output=evidence,
        validation=(CheckOutcome(check=check, status=CheckStatus.PASSED, evidence=evidence),),
    )


def _words(world: FixtureWorld) -> Recipe:
    async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
        conversations = world.conversations(request.project_id, request.scope_key)
        return {
            "sources": {cid: content_hash(texts) for cid, texts in sorted(conversations.items())},
            "claims": sorted(world.claims),
        }

    async def execute(ctx: RecipeContext) -> None:
        conversations = world.conversations(ctx.project_id, ctx.scope_key)
        extracted: dict[str, list[str]] = {}
        for cid, texts in sorted(conversations.items()):

            async def read(cid: str = cid, texts: tuple[str, ...] = tuple(texts)) -> StepResult:
                world.model_calls[f"{WORDS}:extract"] += 1
                if world.during_model is not None:
                    await world.during_model(f"extract:{cid}")
                if cid in world.fail_conversations:
                    raise RuntimeError("the fake model broke")
                return StepResult(output={"items": list(texts)}, usage={"total_tokens": 10 * len(texts)}, model_calls=1)

            output = await ctx.step(
                "extract", read, instance=cid, inputs={"conversation": cid, "texts": content_hash(list(texts))}
            )
            extracted[cid] = list(output["items"])
            await ctx.progress("extracting", conversations_done=len(extracted))

        service = EmbeddingService(ctx.store, identity=world.identity(), embed=world.embed)
        statements = [s for items in extracted.values() for s in items]
        batch = await service.ensure(ctx.project_id, statements)
        ctx.metrics["embeddingsReused"] += batch.reused
        ctx.metrics["embeddingsComputed"] += batch.computed
        for cid, items in sorted(extracted.items()):
            for index, statement in enumerate(items):
                hashed = input_hash(statement)
                await ctx.emit(
                    "argument",
                    f"{cid}:{index}",
                    {
                        "statement": statement,
                        "epistemicKind": "claim" if statement in world.claims else "argument",
                        "valence": "positive",
                        "evidence": [{"conversationId": cid, "quotes": [statement]}],
                    },
                    source_refs=[SourceRef(conversation_id=cid, quote=statement)],
                    embedding_refs={
                        "embeddingId": batch.ids[hashed],
                        "inputHash": hashed,
                        "configKey": world.identity().key,
                        "projectionVersion": "statement-v1",
                    },
                )
        if world.after_emit is not None:
            await world.after_emit(ctx)

        async def check() -> StepResult:
            empty = [s for s in statements if not s.strip()]
            return StepResult(
                output={"statements": len(statements)},
                validation=(
                    CheckOutcome(
                        check="statements-have-text",
                        status=CheckStatus.FAILED if empty else CheckStatus.PASSED,
                        evidence={"statements": len(statements), "empty": len(empty)},
                    ),
                ),
            )

        await ctx.step("check", check, inputs={"statements": content_hash(sorted(statements))})

    return Recipe(
        id=WORDS,
        version="1",
        name="Fixture words",
        purpose="Reads scripted statements into arguments.",
        input_types=(),
        steps=(
            StepDef("extract", "1", StepKind.MODEL, "Read one conversation's statements", prompt_ref="fixture/extract", prompt_version="1"),
            StepDef("check", "1", StepKind.CHECK, "Every statement has text", check_version="1"),
        ),
        output_types=("argument",),
        execute=execute,
        resolve_inputs=resolve_inputs,
        embedding_projections=("argument",),
        # Each extraction names its own conversation in its step inputs.
        partitioned_inputs=("sources",),
        model_config=lambda: {"model": "fixture/model", "temperature": 0},
    )


def _on_words(_scope_key: str, _parameters: Mapping[str, Any]) -> Sequence[Dependency]:
    return (Dependency(recipe_id=WORDS, scope_key="project", name="arguments"),)


def _pairs(world: FixtureWorld) -> Recipe:
    async def execute(ctx: RecipeContext) -> None:
        arguments = sorted(await ctx.input_revisions("arguments"), key=lambda r: (r.payload["statement"], r.id))

        async def pair() -> StepResult:
            world.model_calls[f"{PAIRS}:pair"] += 1
            if world.during_model is not None:
                await world.during_model("pair")
            pairs = [[a.id, b.id] for a, b in zip(arguments[::2], arguments[1::2], strict=False)]
            return StepResult(output={"pairs": pairs}, usage={"total_tokens": 5}, model_calls=1)

        output = await ctx.step("pair", pair, inputs={"revisions": [a.id for a in arguments]})
        by_id = {a.id: a for a in arguments}
        for a_id, b_id in output["pairs"]:
            a, b = by_id[a_id], by_id[b_id]
            tension = await ctx.emit(
                "tension",
                f"{a.object_id}:{b.object_id}",
                {
                    "poleA": a.payload["statement"],
                    "poleB": b.payload["statement"],
                    "knot": "Both cannot hold at once.",
                    "toResolve": "Which comes first?",
                    "quotes": [
                        {"text": a.payload["statement"], "pole": "A"},
                        {"text": b.payload["statement"], "pole": "B"},
                    ],
                },
                input_revision_ids=[a.id, b.id],
            )
            await ctx.relate("supports_pole_a", world.foreign_revision or a, tension, basis="extracted")
            await ctx.relate("supports_pole_b", b, tension, basis="extracted")
        await ctx.step(
            "coverage",
            lambda: _async(_passed("both-poles-supported", tensions=len(output["pairs"]), arguments=len(arguments))),
            inputs={"pairs": output["pairs"]},
        )

    return Recipe(
        id=PAIRS,
        version="1",
        name="Fixture pairs",
        purpose="Pairs pinned arguments into tensions.",
        input_types=("argument",),
        steps=(
            StepDef("pair", "1", StepKind.MODEL, "Pair arguments", prompt_ref="fixture/pair", prompt_version="1"),
            StepDef("coverage", "1", StepKind.CHECK, "Every tension has two supported poles", check_version="1"),
        ),
        output_types=("tension",),
        execute=execute,
        dependencies=_on_words,
        model_config=lambda: {"model": "fixture/model", "temperature": 0},
    )


def _assess(world: FixtureWorld) -> Recipe:
    async def execute(ctx: RecipeContext) -> None:
        claims = [r for r in await ctx.input_revisions("arguments") if r.attributes.get("epistemicKind") == "claim"]
        for claim in claims:

            async def judge(claim: ObjectRevision = claim) -> StepResult:
                world.model_calls[f"{ASSESS}:judge"] += 1
                return StepResult(output={"verdict": world.verdict}, model_calls=1)

            verdict = await ctx.step("judge", judge, instance=claim.object_id, inputs={"revision": claim.id})
            assessment = await ctx.emit(
                "fact_check_assessment",
                claim.object_id,
                {
                    "verdict": verdict["verdict"],
                    "justification": "The fixture says so.",
                    "statement": claim.payload["statement"],
                },
                input_revision_ids=[claim.id],
            )
            await ctx.relate("assesses", assessment, claim, basis="extracted")
        await ctx.step("check", lambda: _async(_passed("assessed", claims=len(claims))), inputs={"claims": [c.id for c in claims]})

    return Recipe(
        id=ASSESS,
        version="1",
        name="Fixture assess",
        purpose="Assesses pinned claims.",
        input_types=("argument",),
        steps=(
            StepDef("judge", "1", StepKind.MODEL, "Judge one claim", prompt_ref="fixture/judge", prompt_version="1"),
            StepDef("check", "1", StepKind.CHECK, "Every claim was judged", check_version="1"),
        ),
        output_types=("fact_check_assessment",),
        execute=execute,
        dependencies=_on_words,
        model_config=lambda: {"model": "fixture/model", "temperature": 0},
    )


async def _async(result: StepResult) -> StepResult:
    return result


def _cycle(world: FixtureWorld, recipe_id: str, other: str) -> Recipe:
    async def execute(ctx: RecipeContext) -> None:  # noqa: ARG001
        world.model_calls[f"{recipe_id}:never"] += 1
        raise AssertionError("a cyclic recipe must never run")

    return Recipe(
        id=recipe_id,
        version="1",
        name=recipe_id,
        purpose="Depends on its partner.",
        input_types=(),
        steps=(StepDef("never", "1", StepKind.DETERMINISTIC, "Never runs"),),
        output_types=("argument",),
        execute=execute,
        dependencies=lambda _k, _p: (Dependency(recipe_id=other, scope_key="project"),),
    )


def register_fixture_recipes(world: FixtureWorld) -> list[str]:
    recipes = [
        _words(world),
        _pairs(world),
        _assess(world),
        _cycle(world, CYCLE_A, CYCLE_B),
        _cycle(world, CYCLE_B, CYCLE_A),
    ]
    for recipe in recipes:
        register_recipe(recipe, replace=True)
    return [recipe.id for recipe in recipes]


def unregister_fixture_recipes(ids: list[str]) -> None:
    for recipe_id in ids:
        unregister_recipe(recipe_id)
