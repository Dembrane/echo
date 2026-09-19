"""Stakeholders: who has something at stake, and how they stand to each other.

Scope `project`: the call reads every conversation of the session at once, the
way the deck's slide always has, so the project is the output's scope.

1. corpus         deterministic: every transcript inside one shared character
                  budget, so a short conversation keeps every word and the long
                  ones split what is left
2. stakeholders   model: one grounded call over that corpus
3. gates          check: one group per name, and one connected map; a flagged
                  answer goes back once with its flags, as the live tick does
4. embed          deterministic: each group's name, role and stake projected and
                  embedded, reusing stored vectors

Every quote is checked verbatim against the transcript it is credited to before
anything is written, and a quote the session does not hold is dropped along with
the aspect resting on it. Absence from the corpus is never evidence of a
position: a group nobody spoke for is `named` or `inferred`, and that rung
travels with the object.

The prompt returns groups and the relations between them, so those are what this
recipe publishes. It invents no relation to an argument or a tension: pinned
arguments and tensions would need a prompt that reads them, and none does yet.
"""

from __future__ import annotations

import re
import logging
from typing import Any, Mapping

from dembrane.map import recipe as map_recipe
from dembrane.analysis import types
from dembrane.popcorn.gates import name_flags, island_flags
from dembrane.popcorn.model import STAKEHOLDERS_PROMPT, prompt_text, _transcript_message
from dembrane.popcorn.analysis import (
    MAX_ANALYSIS_CHARS,
    STAKEHOLDERS_SCHEMA,
    QuoteBook,
    norm,
    build_corpus,
    allocate_chars,
    shape_stakeholders,
)
from dembrane.analysis.executor import StepResult, RecipeFailed, RecipeContext
from dembrane.analysis.registry import Recipe, StepDef, InputRequest, IdentityPolicy
from dembrane.analysis.contracts import (
    StepKind,
    SourceRef,
    CheckStatus,
    CheckOutcome,
)
from dembrane.analysis.embeddings import EmbeddingRef, EmbeddingService, input_hash
from dembrane.analysis.recipes.services import model_deployment, producer_services
from dembrane.analysis.recipes.arguments import (
    LOCATION_BASIS,
    fresh,
    artifact_hash,
    live_model_deployment,
    load_pinned_transcripts,
)

logger = logging.getLogger("dembrane.analysis.recipes.stakeholders")

RECIPE_ID = "stakeholders"
RECIPE_VERSION = "stakeholders-v1"
GATES_CHECK = "stakeholder-gates-v1"
TOKEN_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens")
# How a failed answer goes back to the model, word for word as the live tick
# sends it (`dembrane.popcorn.model.run_analysis`).
FEEDBACK_HEADING = "## Your previous answer failed these checks"
FEEDBACK_CLOSE = "\nFix every one of them and return the complete output again."

STEPS = (
    StepDef(
        "corpus",
        "1",
        StepKind.DETERMINISTIC,
        "Every transcript inside one shared character budget, with what each conversation kept",
    ),
    StepDef(
        "stakeholders",
        "1",
        StepKind.MODEL,
        "The groups with something at stake and the relations between them, over the whole session",
        prompt_ref=f"dembrane/popcorn/prompts/{STAKEHOLDERS_PROMPT}.md",
        prompt_version=STAKEHOLDERS_PROMPT,
    ),
    StepDef(
        "gates",
        "1",
        StepKind.CHECK,
        "One group per name and one connected map, with the flags left after the retry",
        check_version=GATES_CHECK,
    ),
    StepDef(
        "embed",
        "1",
        StepKind.DETERMINISTIC,
        "Embed each group's projection, reusing stored vectors",
    ),
)


def feedback_prompt(system: str, flags: list[str]) -> str:
    lines = "".join(f"- {flag}\n" for flag in flags)
    return f"{system}\n\n{FEEDBACK_HEADING}\n\n{lines}{FEEDBACK_CLOSE}"


def lineage_key(name: str) -> str:
    """A group's identity: its name as the room said it, normalised. The `s1`
    on the slide is a position in a list, and never an identity."""
    return f"name:{map_recipe.sha256_hex(norm(name))[:40]}"


# ── inputs ──────────────────────────────────────────────────────────────


async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
    services = producer_services(request.services)
    transcripts = await services.transcripts(request.project_id)
    return {
        "sources": [{"conversationId": t.id, "textHash": t.text_hash} for t in transcripts],
        "sourceFingerprint": map_recipe.source_fingerprint(transcripts),
        "prompt": STAKEHOLDERS_PROMPT,
        "budget": MAX_ANALYSIS_CHARS,
        "embedding": dict(services.embedding_settings()),
    }


# ── execution ───────────────────────────────────────────────────────────


async def _done(result: StepResult) -> StepResult:
    return result


def _location(keys: Mapping[str, str], conversation_id: str, quote: str) -> dict[str, Any] | None:
    found = keys.get(conversation_id, "").find(map_recipe.norm_key(quote))
    return {"offset": found, "basis": LOCATION_BASIS} if found >= 0 else None


def _quote_refs(
    quote_ids: list[str],
    book_quotes: Mapping[str, dict[str, Any]],
    keys: Mapping[str, str],
) -> list[dict[str, Any]]:
    refs = []
    for quote_id in quote_ids:
        quote = book_quotes.get(quote_id)
        if quote is None:
            continue
        conversation_id = str(quote["transcript"])
        refs.append(
            {
                "text": str(quote["text"]),
                "conversationId": conversation_id,
                "location": _location(keys, conversation_id, str(quote["text"])),
            }
        )
    return refs


def _source_refs(
    quote_ids: list[str],
    book_quotes: Mapping[str, dict[str, Any]],
    keys: Mapping[str, str],
    hashes: Mapping[str, str],
) -> list[SourceRef]:
    return [
        SourceRef(
            conversation_id=str(ref["conversationId"]),
            source_fingerprint=hashes.get(str(ref["conversationId"])),
            quote=str(ref["text"]),
            location=ref["location"],
        )
        for ref in _quote_refs(quote_ids, book_quotes, keys)
    ]


async def execute(ctx: RecipeContext) -> None:
    services = producer_services(ctx.services)
    deployment = live_model_deployment(ctx)
    sources = list(ctx.input_manifest.get("sources") or [])
    transcripts = await load_pinned_transcripts(services, ctx.project_id, sources)
    if not transcripts:
        # A session with nothing said yet is a valid, empty output.
        await ctx.step(
            "corpus",
            lambda: _done(StepResult(output={"conversations": [], "chars": 0})),
            inputs={"sources": []},
        )
        await ctx.step(
            "gates",
            lambda: _done(
                StepResult(
                    output={"flags": [], "left": [], "retried": False},
                    validation=(
                        CheckOutcome(
                            check="stakeholder-gates",
                            status=CheckStatus.PASSED,
                            version=GATES_CHECK,
                            evidence={"stakeholders": 0, "relations": 0, "flags": [], "left": []},
                        ),
                    ),
                )
            ),
            inputs={"check": GATES_CHECK, "answer": None},
        )
        return

    # 1. the corpus, inside one shared budget
    await ctx.progress("reading", force=True)
    lengths = {t.id: len(t.text) for t in transcripts}
    quota = allocate_chars(lengths, MAX_ANALYSIS_CHARS)
    texts = {t.id: t.text[: quota[t.id]] for t in transcripts}
    hashes = {t.id: t.text_hash for t in transcripts}
    keys = {t.id: map_recipe.norm_key(t.text) for t in transcripts}
    corpus_doc = {
        "conversations": [
            {
                "conversationId": t.id,
                "textHash": t.text_hash,
                "chars": lengths[t.id],
                "read": quota[t.id],
            }
            for t in transcripts
        ],
        "chars": sum(quota.values()),
        "clipped": sorted(tid for tid, n in lengths.items() if quota[tid] < n),
    }
    await ctx.step(
        "corpus",
        lambda: _done(StepResult(output=corpus_doc)),
        inputs={"sources": corpus_doc["conversations"], "budget": MAX_ANALYSIS_CHARS},
    )
    corpus = build_corpus([(tid, text) for tid, text in texts.items()])
    system = prompt_text(STAKEHOLDERS_PROMPT)
    user_text = _transcript_message("session", corpus)

    async def ask(prompt: str, instance: str) -> dict[str, Any]:
        async def compute() -> StepResult:
            answer, usage = await services.generate(
                system_prompt=prompt, user_text=user_text, schema=STAKEHOLDERS_SCHEMA, thinking=True
            )
            return StepResult(
                output=answer,
                usage={k: int(v) for k, v in usage.items() if k in TOKEN_KEYS},
                model_calls=1,
            )

        return dict(
            await ctx.step(
                "stakeholders",
                compute,
                instance=instance,
                inputs={
                    "prompt": map_recipe.sha256_hex(prompt),
                    "corpus": artifact_hash(corpus_doc),
                    "model": deployment,
                },
            )
        )

    # 2 and 3. one call, its gates, and one retry carrying the flags
    await ctx.progress("reading the session", force=True)
    raw = await ask(system, "first")
    # The gates read a shaped answer; a throwaway book keeps a rejected
    # answer's quotes out of the registry this run publishes from.
    probe = shape_stakeholders(raw, QuoteBook(texts))
    flags = name_flags(probe) + island_flags(probe)
    if flags:
        await ctx.progress("asking again", force=True, flags=len(flags))
        raw = await ask(feedback_prompt(system, flags), "retry")

    book = QuoteBook(texts)
    slide = shape_stakeholders(raw, book)
    people = list(slide["stakeholders"])
    relations = list(slide["relations"])
    left = name_flags(slide) + island_flags(slide)
    book_quotes = {str(q["id"]): dict(q) for q in book.quotes}

    async def gates() -> StepResult:
        return StepResult(
            output={
                "flags": flags,
                "left": left,
                "retried": bool(flags),
                "answer": artifact_hash(raw),
            },
            validation=(
                CheckOutcome(
                    check="stakeholder-gates",
                    status=CheckStatus.PASSED,
                    version=GATES_CHECK,
                    evidence={
                        "stakeholders": len(people),
                        "relations": len(relations),
                        "flags": flags,
                        "left": left,
                        "quotesVerified": len(book.quotes),
                        "quotesRejected": book.rejected,
                        "quotesReattributed": book.reattributed,
                    },
                    message=(f"{len(left)} gate flag(s) left after the retry." if left else None),
                ),
            ),
        )

    await ctx.step("gates", gates, inputs={"check": GATES_CHECK, "answer": artifact_hash(raw)})
    if not people:
        raise RecipeFailed("The session's transcripts hold no group with something at stake.")

    # 4. embeddings of each group's projection
    await ctx.progress("embedding", force=True)
    projection = types.get_object_type("stakeholder").map
    assert projection is not None
    payloads = {
        person["id"]: {
            "name": person["name"],
            "role": person["role"],
            "stake": person["stake"],
            "rung": person["evidence"]["rung"],
            **(
                {"invokedBy": str(person["evidence"]["invokedBy"])}
                if person["evidence"].get("invokedBy")
                else {}
            ),
            "weight": {
                "stake": float(person["weight"]["stake"]),
                "mentions": float(person["weight"]["mentions"]),
            },
            "quotes": _quote_refs(list(person.get("quoteIds") or []), book_quotes, keys),
        }
        for person in people
    }
    texts_by_hash = {
        input_hash(projection.embedding_text(payload)): projection.embedding_text(payload)
        for payload in payloads.values()
    }

    async def embed() -> StepResult:
        identity = await services.probe()
        service = EmbeddingService(ctx.store, identity=identity, embed=services.embed)
        batch = await service.ensure(ctx.project_id, list(texts_by_hash.values()))
        await service.verify_durable(ctx.project_id, batch.ids.values())
        return StepResult(
            output={
                "ids": dict(batch.ids),
                "configKey": identity.key,
                "model": identity.model,
                "reused": batch.reused,
                "computed": batch.computed,
            }
        )

    hits, resumed = ctx.metrics["cacheHits"], ctx.metrics["stepsResumed"]
    embedded = await ctx.step(
        "embed",
        embed,
        inputs={
            "embedding": dict(ctx.input_manifest.get("embedding") or {}),
            "projectionVersion": projection.projection_version,
            "inputHashes": sorted(texts_by_hash),
        },
    )
    if fresh(ctx, hits, resumed):
        ctx.metrics["embeddingsReused"] += int(embedded["reused"])
        ctx.metrics["embeddingsComputed"] += int(embedded["computed"])

    # objects, then the relations between them
    await ctx.progress("emitting", force=True)
    emitted = {}
    for person in people:
        payload = payloads[person["id"]]
        hashed = input_hash(projection.embedding_text(payload))
        emitted[person["id"]] = await ctx.emit(
            "stakeholder",
            lineage_key(str(person["name"])),
            payload,
            source_refs=_source_refs(list(person.get("quoteIds") or []), book_quotes, keys, hashes),
            embedding_refs={
                **EmbeddingRef(
                    embedding_id=embedded["ids"][hashed],
                    input_hash=hashed,
                    config_key=str(embedded["configKey"]),
                    projection_version=projection.projection_version,
                ).as_json(),
                "model": embedded["model"],
            },
            extra={"prompt": STAKEHOLDERS_PROMPT, "model": deployment, "slideId": person["id"]},
        )
        ctx.metrics["stakeholders"] += 1

    for relation in relations:
        ends = [emitted.get(str(end)) for end in relation.get("between") or []]
        if len(ends) != 2 or ends[0] is None or ends[1] is None or ends[0].id == ends[1].id:
            continue
        aspects = [
            {
                "kind": aspect["kind"],
                "note": aspect["note"],
                "quotes": _quote_refs(list(aspect.get("quoteIds") or []), book_quotes, keys),
            }
            for aspect in relation.get("aspects") or []
        ]
        quote_ids = [
            qid for aspect in relation.get("aspects") or [] for qid in aspect.get("quoteIds") or []
        ]
        await ctx.relate(
            "stakeholder_relation",
            ends[0],
            ends[1],
            basis="extracted",
            attributes={
                "label": relation["label"],
                "intensity": float(relation["intensity"]),
                "sentiment": float(relation["sentiment"]),
                "unowned": bool(relation["unowned"]),
                "detail": relation["detail"],
                "aspects": aspects,
            },
            source_refs=_source_refs(quote_ids, book_quotes, keys, hashes),
        )
        ctx.metrics["relations"] += 1
    ctx.metrics["gateFlags"] += len(left)


RECIPE = Recipe(
    id=RECIPE_ID,
    version=RECIPE_VERSION,
    name="Stakeholders",
    purpose=(
        "Map the groups with something at stake in a session and how they stand to one another, "
        "each group carrying how well the transcripts evidence it."
    ),
    input_types=(),
    steps=STEPS,
    output_types=("stakeholder",),
    execute=execute,
    resolve_inputs=resolve_inputs,
    validation_rules=(
        "one group per name, and every group connected to the map",
        "every quote is verbatim in the conversation it is credited to; an aspect without one is dropped",
        "absence from the corpus is never evidence of a position: the rung says how a group is evidenced",
        "relations connect groups this run published, and no relation to an argument or a tension is invented",
        "gate flags left after the retry are recorded with the output, not hidden",
    ),
    identity_policy=IdentityPolicy(
        description=(
            "A group keeps its identity while the room's name for it stays the same; the slide's "
            "`s1` is a position in a list and never an identity."
        )
    ),
    embedding_projections=("stakeholder",),
    scope_key_pattern=re.compile(r"^project$"),
    model_config=model_deployment,
    model_concurrency=2,
    # Both calls name the corpus they read, so a conversation that did not
    # change does not make the session's judgement stale on its own.
    partitioned_inputs=("sources", "sourceFingerprint", "embedding"),
)
