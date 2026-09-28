"""Arguments: Map's grounded transcript extraction, as a recipe.

Scope `project`; its inputs are the project's transcripts, pinned by their
text hashes when the run is requested.

1. load     deterministic: read the transcripts and check each against the
            pinned text hash; a conversation that changed since then fails the
            run rather than being read unpinned
2. extract  model, once per conversation: every window's raw answer, keyed by
            the conversation's text hash, the prompt version and the model
            deployment, so only a changed conversation calls the model again
3. ground   check: keep items with a known kind and valence and at least one
            quote found verbatim in its own transcript; the rest are counted
4. merge    deterministic: one candidate per source item across overlapping
            windows of one conversation. Distinct arguments stay separate, also
            across conversations: consolidation is `deduplicated_arguments`
5. embed    deterministic: each statement's versioned projection through the
            shared embedding service, reusing stored vectors for identical text
            and configuration

Every output is an `argument` whose lineage key is its conversation and the
extracted item's key (kind and normalised statement). New quotes for the same
statement are a new revision of the same object; a reworded statement is a
new object, because continuity is not known.
"""

from __future__ import annotations

import re
import json
import asyncio
import hashlib
import logging
from typing import Any, Mapping
from collections import Counter

from dembrane.map import recipe as map_recipe
from dembrane.analysis import types
from dembrane.map.model import EXTRACTION_PROMPT
from dembrane.map.generate import read_conversation
from dembrane.analysis.hashing import CanonicalizationError, content_hash
from dembrane.analysis.executor import RunStopped, StepResult, RecipeFailed, RecipeContext
from dembrane.analysis.registry import Recipe, StepDef, InputRequest, IdentityPolicy
from dembrane.analysis.contracts import (
    StepKind,
    SourceRef,
    CheckStatus,
    CheckOutcome,
    ObjectRevision,
    AnalysisStoreError,
    AnalysisValidationError,
)
from dembrane.analysis.embeddings import EmbeddingRef, EmbeddingService, input_hash
from dembrane.analysis.recipes.services import (
    ProducerServices,
    model_deployment,
    producer_services,
)

logger = logging.getLogger("dembrane.analysis.recipes.arguments")

RECIPE_ID = "arguments"
RECIPE_VERSION = "arguments-v1"
EXTRACTION_CONCURRENCY = 6
GROUND_CHECK = "ground-quote-v1"
# How a quote's location is given: its offset in the transcript after
# whitespace is collapsed and case folded, the text `ground_quote` searched.
LOCATION_BASIS = "collapsed-casefold-v1"

STEPS = (
    StepDef("load", "1", StepKind.DETERMINISTIC, "Read the transcripts and check them against the pinned text hashes"),
    StepDef(
        "extract",
        "1",
        StepKind.MODEL,
        "Extract arguments and claims from one conversation, window by window",
        prompt_ref=f"dembrane/map/prompts/{EXTRACTION_PROMPT}.md",
        prompt_version=EXTRACTION_PROMPT,
    ),
    StepDef(
        "ground",
        "1",
        StepKind.CHECK,
        "Keep items with a known kind and valence and a quote found verbatim in their transcript",
        check_version=GROUND_CHECK,
    ),
    StepDef("merge", "1", StepKind.DETERMINISTIC, "One candidate per source item across overlapping windows"),
    StepDef("embed", "1", StepKind.DETERMINISTIC, "Embed each statement's projection, reusing stored vectors"),
)


# ── shared by the producers that read arguments ─────────────────────────


def artifact_hash(value: Any) -> str:
    """A step artifact's fingerprint for the steps that consume it. A model
    answer can hold what canonical JSON refuses (a NaN), so those fall back to
    sorted JSON; either way the artifact's content decides it, never a run id."""
    try:
        return content_hash(value)
    except CanonicalizationError:
        text = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
        return "json:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def argument_order(revision: ObjectRevision) -> tuple[str, str, str, str]:
    """A stable order for pinned argument revisions (manifests list objects by
    id): the first evidence's conversation time and id, then the statement."""
    evidence = (revision.payload.get("evidence") or [{}])[0]
    return (
        str(evidence.get("createdAt") or ""),
        str(evidence.get("conversationId") or ""),
        str(revision.payload.get("statement") or ""),
        revision.object_id,
    )


def revision_quotes(revision: ObjectRevision) -> list[SourceRef]:
    """A revision's checked evidence: its source references, or for a revision
    without any (an import) the quotes its payload carries."""
    refs = [ref for ref in revision.provenance.source_refs if ref.quote and ref.quote.strip()]
    if refs:
        return refs
    return [
        SourceRef(conversation_id=str(item["conversationId"]), quote=str(quote))
        for item in revision.payload.get("evidence") or []
        for quote in item.get("quotes") or []
        if str(quote).strip()
    ]


def live_model_deployment(ctx: RecipeContext) -> dict[str, Any]:
    return dict(producer_services(ctx.services).model_deployment())


def fresh(ctx: RecipeContext, hits_before: int, resumed_before: int) -> bool:
    """Whether the step just awaited computed, rather than reusing an artifact."""
    return ctx.metrics["cacheHits"] == hits_before and ctx.metrics["stepsResumed"] == resumed_before


async def _async(result: StepResult) -> StepResult:
    return result


# ── inputs ──────────────────────────────────────────────────────────────


def _source(transcript: map_recipe.Transcript) -> dict[str, Any]:
    return {
        "conversationId": transcript.id,
        "textHash": transcript.text_hash,
        "label": transcript.label,
        "createdAt": transcript.created_at,
    }


async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
    services = producer_services(request.services)
    transcripts = await services.transcripts(request.project_id)
    return {
        "sources": [_source(t) for t in transcripts],
        "sourceFingerprint": map_recipe.source_fingerprint(transcripts),
        "embedding": dict(services.embedding_settings()),
    }


async def load_pinned_transcripts(
    services: ProducerServices, project_id: str, sources: list[Mapping[str, Any]]
) -> list[map_recipe.Transcript]:
    """The pinned conversations' transcripts, in pinned order. A conversation
    that is gone or whose text changed since pinning fails the run."""
    by_id = {t.id: t for t in await services.transcripts(project_id)}
    moved = [
        s["conversationId"]
        for s in sources
        if s["conversationId"] not in by_id or by_id[s["conversationId"]].text_hash != s["textHash"]
    ]
    if moved:
        raise RecipeFailed(
            f"{len(moved)} conversation(s) changed after this run pinned its inputs. Request it again."
        )
    return [by_id[str(s["conversationId"])] for s in sources]


# ── execution ───────────────────────────────────────────────────────────


def _location(transcript_key: str, quote: str) -> dict[str, Any] | None:
    found = transcript_key.find(map_recipe.norm_key(quote))
    return {"offset": found, "basis": LOCATION_BASIS} if found >= 0 else None


async def execute(ctx: RecipeContext) -> None:
    services = producer_services(ctx.services)
    sources = list(ctx.input_manifest.get("sources") or [])
    embedding_config = dict(ctx.input_manifest.get("embedding") or {})
    deployment = live_model_deployment(ctx)

    await ctx.progress("loading", force=True)
    transcripts = await load_pinned_transcripts(services, ctx.project_id, sources)
    fingerprints = [{"conversationId": t.id, "textHash": t.text_hash} for t in transcripts]
    await ctx.step(
        "load",
        lambda: _async(
            StepResult(
                output={"conversations": fingerprints},
                validation=(
                    CheckOutcome(
                        check="sources-match-pinned",
                        status=CheckStatus.PASSED,
                        evidence={"conversations": len(transcripts)},
                    ),
                ),
            )
        ),
        inputs={"sources": fingerprints},
    )

    # 2. extraction, one model step per conversation
    answers: dict[str, list[dict[str, Any]]] = {}
    extract_hashes: dict[str, str] = {}
    failed: dict[str, str] = {}
    lock = asyncio.Lock()

    async def extract_one(transcript: map_recipe.Transcript) -> None:
        async def compute() -> StepResult:
            read = await read_conversation(transcript, services.extract)
            usage: Counter[str] = Counter()
            for _raw, used in read:
                usage.update(used)
            return StepResult(
                output={"windows": [raw for raw, _used in read]},
                usage=dict(usage),
                model_calls=len(read),
            )

        try:
            output = await ctx.step(
                "extract",
                compute,
                instance=transcript.id,
                inputs={
                    "conversationId": transcript.id,
                    "textHash": transcript.text_hash,
                    "prompt": EXTRACTION_PROMPT,
                    "windowChars": map_recipe.WINDOW_CHARS,
                    "windowOverlapChars": map_recipe.WINDOW_OVERLAP_CHARS,
                    "model": deployment,
                },
            )
        except Exception as exc:
            if not _conversation_failure(exc):
                raise
            async with lock:
                failed[transcript.id] = type(exc).__name__
            logger.warning(
                "arguments run %s: conversation %s failed: %s", ctx.run.id, transcript.id, type(exc).__name__
            )
            return
        async with lock:
            answers[transcript.id] = list(output["windows"])
            extract_hashes[transcript.id] = artifact_hash(output)
        await ctx.progress(
            "extracting",
            conversations_total=len(transcripts),
            conversations_done=len(answers),
            conversations_failed=len(failed),
        )

    async with asyncio.TaskGroup() as group:
        for transcript in transcripts:
            group.create_task(extract_one(transcript))
    if failed:
        raise RecipeFailed(f"Reading {len(failed)} of {len(transcripts)} conversations failed.")

    # 3. grounding, checked against each conversation's own text
    ground_inputs = {
        "check": GROUND_CHECK,
        "conversations": [
            {"conversationId": t.id, "textHash": t.text_hash, "extraction": extract_hashes[t.id]} for t in transcripts
        ],
    }

    async def ground() -> StepResult:
        per: dict[str, dict[str, Any]] = {}
        kept = dropped = 0
        for t in transcripts:
            windows: list[list[dict[str, Any]]] = []
            lost_here = 0
            for index, raw in enumerate(answers[t.id]):
                candidates, lost = map_recipe.shape_extraction(raw, t, window_index=index)
                windows.append(candidates)
                lost_here += lost
                kept += len(candidates)
            per[t.id] = {"windows": windows, "dropped": lost_here}
            dropped += lost_here
        return StepResult(
            output={"conversations": per},
            validation=(
                CheckOutcome(
                    check="quotes-verbatim",
                    status=CheckStatus.PASSED,
                    version=GROUND_CHECK,
                    evidence={
                        "conversations": len(transcripts),
                        "kept": kept,
                        "dropped": dropped,
                        "droppedByConversation": {cid: entry["dropped"] for cid, entry in per.items()},
                    },
                ),
            ),
        )

    grounded = await ctx.step("ground", ground, inputs=ground_inputs)
    ground_hash = artifact_hash(grounded)

    # 4. one candidate per source item across windows
    async def merge() -> StepResult:
        return StepResult(
            output={
                "conversations": {
                    t.id: map_recipe.merge_conversation_candidates(grounded["conversations"][t.id]["windows"])
                    for t in transcripts
                }
            }
        )

    merged = (await ctx.step("merge", merge, inputs={"ground": ground_hash}))["conversations"]
    await ctx.progress("embedding", force=True)

    # 5. embeddings of each statement's projection
    projection = types.get_object_type("argument").map
    assert projection is not None
    texts: dict[str, str] = {}
    for t in transcripts:
        for candidate in merged[t.id]:
            text = projection.embedding_text({"statement": candidate["statement"]})
            texts[input_hash(text)] = text

    async def embed() -> StepResult:
        if not texts:
            return StepResult(output={"ids": {}, "configKey": None, "model": None, "reused": 0, "computed": 0})
        identity = await services.probe()
        service = EmbeddingService(ctx.store, identity=identity, embed=services.embed)
        batch = await service.ensure(ctx.project_id, list(texts.values()))
        await service.verify_durable(ctx.project_id, batch.ids.values())
        return StepResult(
            output={
                "ids": dict(batch.ids),
                "configKey": identity.key,
                "model": identity.model,
                "dims": identity.dims,
                "reused": batch.reused,
                "computed": batch.computed,
            }
        )

    hits, resumed = ctx.metrics["cacheHits"], ctx.metrics["stepsResumed"]
    embedded = await ctx.step(
        "embed",
        embed,
        inputs={
            "embedding": embedding_config,
            "projectionVersion": projection.projection_version,
            "inputHashes": sorted(texts),
        },
    )
    if fresh(ctx, hits, resumed):
        ctx.metrics["embeddingsReused"] += int(embedded["reused"])
        ctx.metrics["embeddingsComputed"] += int(embedded["computed"])

    # objects
    await ctx.progress("emitting", force=True)
    for t in transcripts:
        transcript_key = map_recipe.norm_key(t.text)
        for candidate in merged[t.id]:
            statement = candidate["statement"]
            hashed = input_hash(projection.embedding_text({"statement": statement}))
            extra: dict[str, Any] = {}
            if candidate["kind"] == "claim":
                extra["claimKey"] = map_recipe.claim_key(statement, candidate["quotes"])
            await ctx.emit(
                "argument",
                f"{t.id}:{candidate['id']}",
                {
                    "statement": statement,
                    "epistemicKind": candidate["kind"],
                    "valence": candidate["valence"],
                    "evidence": [
                        {
                            "conversationId": t.id,
                            "label": t.label,
                            "createdAt": t.created_at,
                            "quotes": list(candidate["quotes"]),
                        }
                    ],
                },
                source_refs=[
                    SourceRef(
                        conversation_id=t.id,
                        source_fingerprint=t.text_hash,
                        quote=quote,
                        location=_location(transcript_key, quote),
                    )
                    for quote in candidate["quotes"]
                ],
                embedding_refs={
                    **EmbeddingRef(
                        embedding_id=embedded["ids"][hashed],
                        input_hash=hashed,
                        config_key=str(embedded["configKey"]),
                        projection_version=projection.projection_version,
                    ).as_json(),
                    "model": embedded["model"],
                },
                extra=extra,
            )
    ctx.metrics["conversations"] += len(transcripts)
    ctx.metrics["candidates"] += sum(len(merged[t.id]) for t in transcripts)
    ctx.metrics["droppedUngrounded"] += sum(int(grounded["conversations"][t.id]["dropped"]) for t in transcripts)


def _conversation_failure(exc: Exception) -> bool:
    """A failure of one conversation's reading, as opposed to the run itself
    stopping or its storage failing: those end the run at once."""
    return not isinstance(exc, (RunStopped, AnalysisStoreError, AnalysisValidationError))


RECIPE = Recipe(
    id=RECIPE_ID,
    version=RECIPE_VERSION,
    name="Arguments",
    purpose=(
        "Extract complete, source-grounded arguments and claims from every conversation in the "
        "project, keeping distinct arguments separate."
    ),
    input_types=(),
    steps=STEPS,
    output_types=("argument",),
    execute=execute,
    resolve_inputs=resolve_inputs,
    validation_rules=(
        "every argument has a statement, a kind and a valence",
        "every argument has at least one quote found verbatim in its conversation",
        "every statement's vector is durable before publication",
    ),
    identity_policy=IdentityPolicy(
        description=(
            "An argument keeps its identity while its conversation and extracted item (kind and "
            "normalised statement) stay the same; a reworded statement is a new object."
        )
    ),
    embedding_projections=("argument",),
    scope_key_pattern=re.compile(r"^project$"),
    model_config=model_deployment,
    model_concurrency=EXTRACTION_CONCURRENCY,
    # Each step names the conversation (text hash) or embedding configuration it
    # read, so a changed conversation recomputes only its own extraction.
    partitioned_inputs=("sources", "sourceFingerprint", "embedding"),
)
