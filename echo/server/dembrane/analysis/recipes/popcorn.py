"""Popcorn: a session's short phrases as shared analysis objects.

Scope `conversation:<id>`, one output per conversation, because replacing one
conversation's output must never remove another's objects.

The live tick is where the room's latency is measured: one fast extractor per
conversation, the deterministic gates, the closest passage, then the second
pass that roots each phrase in a quote and gives it its kind. Those stages stay
where they are. This recipe is how their result becomes typed, revisioned
objects: the tick calls it through `execute_inline` after each write it makes,
so the same run, step and revision rows are created and the output is published
through the same transaction as every other recipe. No model call is made here,
so a first phrase reaches the stage exactly as fast as it did before.

1. collect  deterministic: the conversation's phrases as the session held them
            when the run was requested, with the wording, kind, qualifiers and
            quote the second pass left on each
2. ground   check: the quote behind a phrase counts only while the transcript
            still holds it word for word, and the phrase is verbatim or it is
            not; neither is taken on trust from the session state
3. embed    deterministic: each phrase's versioned projection through the
            shared embedding service, reusing stored vectors

A phrase's lineage key is its conversation and the hash of its wording, so a
question the second pass rewrote is a new object rather than a silent rewrite
of the one the room already read.
"""

from __future__ import annotations

import re
import logging
from typing import Any, Mapping, Protocol
from dataclasses import field, dataclass

from dembrane.map import recipe as map_recipe
from dembrane.analysis import types
from dembrane.popcorn.model import POPCORN_PROMPT, VALIDATE_PROMPT
from dembrane.popcorn.analysis import norm
from dembrane.analysis.executor import StepResult, RecipeFailed, RecipeContext
from dembrane.analysis.registry import Recipe, StepDef, InputRequest, IdentityPolicy
from dembrane.popcorn.grounding import is_verbatim
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
)

logger = logging.getLogger("dembrane.analysis.recipes.popcorn")

RECIPE_ID = "popcorn"
RECIPE_VERSION = "popcorn-v1"
GROUND_CHECK = "popcorn-quote-verbatim-v1"
SCOPE_KEY = re.compile(r"^conversation:[0-9a-f-]{36}$")
# What the session state calls a phrase, kept on the object's provenance: the
# payload schema carries the phrase, its question mark and its evidence, and
# these say how the second pass classified it.
CARRIED = ("kind", "qualifiers", "verbatim", "quoteId", "phraseId", "rooted")

STEPS = (
    StepDef(
        "collect",
        "1",
        StepKind.DETERMINISTIC,
        "The conversation's phrases as the session held them when the run was requested",
    ),
    StepDef(
        "ground",
        "1",
        StepKind.CHECK,
        "Each phrase's quote is still in its transcript word for word, and the phrase is verbatim or it is not",
        check_version=GROUND_CHECK,
    ),
    StepDef(
        "embed",
        "1",
        StepKind.DETERMINISTIC,
        "Embed each phrase's projection, reusing stored vectors",
    ),
)


def scope_key_for(conversation_id: str) -> str:
    return f"conversation:{conversation_id}"


def conversation_of(scope_key: str) -> str:
    if not SCOPE_KEY.fullmatch(scope_key):
        raise RecipeFailed("This run's scope does not name a conversation.")
    return scope_key.split(":", 1)[1]


def phrase_key(phrase: str) -> str:
    """A phrase's identity within its conversation: its wording, normalised.
    Rewording is a new object, because continuity is not known."""
    return map_recipe.sha256_hex(norm(phrase))[:20]


# ── what the recipe reads ───────────────────────────────────────────────


@dataclass(frozen=True)
class ConversationPhrases:
    """One conversation as the session holds it: its transcript, the phrases on
    the stage and how they were produced."""

    conversation_id: str
    text: str
    phrases: tuple[dict[str, Any], ...] = ()
    label: str | None = None
    created_at: str | None = None
    language: str | None = None
    # The voice note the extractor was given, and the prompt versions of the
    # passes that wrote these phrases: what produced them, recorded with them.
    voice: str = ""
    prompts: Mapping[str, str] = field(default_factory=dict)

    @property
    def text_hash(self) -> str:
        return map_recipe.sha256_hex(self.text)


class PopcornSources(Protocol):
    async def conversation(
        self, project_id: str, conversation_id: str
    ) -> ConversationPhrases | None: ...


SOURCES_KEY = "popcorn_sources"


def _phrase_record(
    item: Mapping[str, Any], quotes: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any] | None:
    """One session item as this recipe reads it: its wording, what the second
    pass decided about it, and the text of the quote it was rooted in."""
    phrase = " ".join(str(item.get("phrase") or "").split())
    if not phrase:
        return None
    quote_id = str(item.get("quoteId") or "")
    quote = quotes.get(quote_id) or {}
    record: dict[str, Any] = {
        "phraseId": str(item.get("id") or ""),
        "phrase": phrase,
        "question": bool(item.get("question")),
        "kind": str(item.get("kind") or "") or None,
        "qualifiers": [str(q) for q in (item.get("qualifiers") or [])],
        "quoteId": quote_id or None,
        "quote": str(quote.get("text") or "") or None,
    }
    return record


def phrase_records(items: Any, quotes: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The conversation's items as phrase records, one per wording: the session
    already keeps one item per phrase, and a repeat would be one object."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        record = _phrase_record(item, quotes)
        if record is None:
            continue
        key = phrase_key(record["phrase"])
        if key in seen:
            continue
        seen.add(key)
        out.append(record)
    return out


async def load_from_session(project_id: str, conversation_id: str) -> ConversationPhrases | None:
    """The default source: the project's popcorn session as it stands. The tick
    injects its own, so this runs only for a request made outside a tick."""
    from dembrane.popcorn.ticks import gather_transcripts
    from dembrane.popcorn.service import (
        normalize_state,
        voice_host_note,
        get_latest_config,
        get_popcorn_report,
        normalize_settings,
        get_loop_for_report,
    )

    report = await get_popcorn_report(project_id)
    if not report:
        return None
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        return None
    state = normalize_state(loop.get("popcorn_state"))
    entry = (state.get("conversations") or {}).get(conversation_id)
    if entry is None:
        return None
    transcripts = await gather_transcripts(
        project_id=project_id,
        acting_directus_user_id=str(loop.get("acting_directus_user_id") or ""),
    )
    transcript = next((t for t in transcripts if t["id"] == conversation_id), None)
    if transcript is None:
        return None
    settings = normalize_settings(
        (await get_latest_config(str(report["id"])) or {}).get("popcorn_settings"),
        fallback_title=str(loop.get("name") or "Popcorn"),
    )
    quotes = {
        str(q["id"]): q for q in state.get("quotes") or [] if isinstance(q, dict) and q.get("id")
    }
    return ConversationPhrases(
        conversation_id=conversation_id,
        text=str(transcript["text"]),
        phrases=tuple(phrase_records(entry.get("items"), quotes)),
        label=str(transcript.get("label") or "") or None,
        created_at=str(transcript.get("created_at") or "") or None,
        voice=voice_host_note(settings.get("voice")),
        prompts={"extract": POPCORN_PROMPT, "validate": VALIDATE_PROMPT},
    )


def sources_of(services: Mapping[str, Any]) -> PopcornSources:
    found = services.get(SOURCES_KEY)
    if found is None:
        return _DefaultSources()
    return found


class _DefaultSources:
    async def conversation(
        self, project_id: str, conversation_id: str
    ) -> ConversationPhrases | None:
        return await load_from_session(project_id, conversation_id)


async def _read(
    ctx_services: Mapping[str, Any], project_id: str, conversation_id: str
) -> ConversationPhrases:
    found = await sources_of(ctx_services).conversation(project_id, conversation_id)
    if found is None:
        raise RecipeFailed("This conversation has no popcorn session to publish.")
    return found


# ── inputs ──────────────────────────────────────────────────────────────


async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
    conversation_id = conversation_of(request.scope_key)
    source = await _read(request.services, request.project_id, conversation_id)
    services = producer_services(request.services)
    return {
        "conversation": {
            "conversationId": source.conversation_id,
            "textHash": source.text_hash,
            "label": source.label,
            "createdAt": source.created_at,
            "language": source.language,
        },
        # The phrases themselves are the input: the run publishes exactly the
        # wording the room was shown, not whatever the session holds by the
        # time a worker gets to it.
        "phrases": list(source.phrases),
        "voice": map_recipe.sha256_hex(source.voice)[:20] if source.voice else "",
        "prompts": dict(source.prompts),
        "embedding": dict(services.embedding_settings()),
    }


# ── execution ───────────────────────────────────────────────────────────


async def _done(result: StepResult) -> StepResult:
    return result


def _location(transcript_key: str, quote: str) -> dict[str, Any] | None:
    found = transcript_key.find(map_recipe.norm_key(quote))
    return {"offset": found, "basis": LOCATION_BASIS} if found >= 0 else None


async def execute(ctx: RecipeContext) -> None:
    services = producer_services(ctx.services)
    conversation = dict(ctx.input_manifest.get("conversation") or {})
    conversation_id = str(conversation.get("conversationId") or "")
    pinned = [dict(p) for p in ctx.input_manifest.get("phrases") or []]
    source = await _read(ctx.services, ctx.project_id, conversation_id)
    if source.text_hash != conversation.get("textHash"):
        raise RecipeFailed(
            "This conversation changed after the run pinned its phrases. Read it again."
        )

    await ctx.progress("collecting", force=True)
    collected = await ctx.step(
        "collect",
        lambda: _done(StepResult(output={"phrases": pinned})),
        inputs={"conversationId": conversation_id, "phrases": artifact_hash(pinned)},
    )
    phrases = list(collected["phrases"])

    # The session decided what the room sees; this decides what the evidence is
    # worth now. A quote the transcript no longer holds leaves the object's
    # evidence, and is counted rather than repaired.
    transcript_key = map_recipe.norm_key(source.text)

    async def ground() -> StepResult:
        grounded: list[dict[str, Any]] = []
        missing = 0
        for phrase in phrases:
            quote = str(phrase.get("quote") or "")
            found = bool(quote) and map_recipe.norm_key(quote) in transcript_key
            if quote and not found:
                missing += 1
            grounded.append(
                {
                    **phrase,
                    "quote": quote if found else None,
                    "quoteId": phrase.get("quoteId") if found else None,
                    "verbatim": is_verbatim(str(phrase["phrase"]), source.text),
                }
            )
        return StepResult(
            output={"phrases": grounded},
            validation=(
                CheckOutcome(
                    check="quote-verbatim",
                    status=CheckStatus.PASSED,
                    version=GROUND_CHECK,
                    evidence={
                        "phrases": len(grounded),
                        "withQuote": sum(1 for p in grounded if p["quote"]),
                        "quotesNotFound": missing,
                        "verbatim": sum(1 for p in grounded if p["verbatim"]),
                    },
                ),
            ),
        )

    checked = list(
        (
            await ctx.step(
                "ground",
                ground,
                inputs={
                    "check": GROUND_CHECK,
                    "textHash": source.text_hash,
                    "phrases": artifact_hash(phrases),
                },
            )
        )["phrases"]
    )

    # embeddings of each phrase's projection
    await ctx.progress("embedding", force=True)
    projection = types.get_object_type("popcorn").map
    assert projection is not None
    texts = {
        input_hash(projection.embedding_text({"phrase": p["phrase"]})): projection.embedding_text(
            {"phrase": p["phrase"]}
        )
        for p in checked
    }

    async def embed() -> StepResult:
        if not texts:
            return StepResult(
                output={"ids": {}, "configKey": None, "model": None, "reused": 0, "computed": 0}
            )
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
            "embedding": dict(ctx.input_manifest.get("embedding") or {}),
            "projectionVersion": projection.projection_version,
            "inputHashes": sorted(texts),
        },
    )
    if fresh(ctx, hits, resumed):
        ctx.metrics["embeddingsReused"] += int(embedded["reused"])
        ctx.metrics["embeddingsComputed"] += int(embedded["computed"])

    await ctx.progress("emitting", force=True)
    deployment = live_model_deployment(ctx)
    prompts = dict(ctx.input_manifest.get("prompts") or {})
    for phrase in checked:
        text = str(phrase["phrase"])
        quote = phrase.get("quote")
        hashed = input_hash(projection.embedding_text({"phrase": text}))
        await ctx.emit(
            "popcorn",
            f"{conversation_id}:{phrase_key(text)}",
            {
                "phrase": text,
                "question": bool(phrase.get("question")),
                "language": conversation.get("language"),
                "evidence": [
                    {
                        "conversationId": conversation_id,
                        "label": conversation.get("label"),
                        "createdAt": conversation.get("createdAt"),
                        "quotes": [quote] if quote else [],
                    }
                ],
            },
            source_refs=[
                SourceRef(
                    conversation_id=conversation_id,
                    source_fingerprint=source.text_hash,
                    quote=str(quote),
                    location=_location(transcript_key, str(quote)),
                )
            ]
            if quote
            else [],
            embedding_refs={
                **EmbeddingRef(
                    embedding_id=embedded["ids"][hashed],
                    input_hash=hashed,
                    config_key=str(embedded["configKey"]),
                    projection_version=projection.projection_version,
                ).as_json(),
                "model": embedded["model"],
            },
            # What the session knows about the phrase that the payload schema
            # does not carry: its kind and qualifiers, whether the room may read
            # it in quotation marks, and the ids the deck already holds.
            extra={
                **{key: phrase.get(key) for key in CARRIED if phrase.get(key) is not None},
                "prompts": prompts,
                "model": deployment,
            },
        )
    ctx.metrics["phrases"] += len(checked)
    ctx.metrics["phrasesWithQuote"] += sum(1 for p in checked if p["quote"])
    ctx.metrics["phrasesVerbatim"] += sum(1 for p in checked if p["verbatim"])


RECIPE = Recipe(
    id=RECIPE_ID,
    version=RECIPE_VERSION,
    name="Popcorn",
    purpose=(
        "Publish one conversation's short phrases, as the room read them, with the quote each was "
        "rooted in and what the second pass made of it."
    ),
    input_types=(),
    steps=STEPS,
    output_types=("popcorn",),
    execute=execute,
    resolve_inputs=resolve_inputs,
    validation_rules=(
        "one output per conversation: republishing one never touches another's objects",
        "a quote reaches an object only while its transcript still holds it word for word",
        "a rewritten phrase is a new object, never a silent rewrite of the one the room read",
        "every phrase's vector is durable before publication",
    ),
    identity_policy=IdentityPolicy(
        description=(
            "A phrase keeps its identity while its conversation and its wording stay the same; a "
            "phrase the second pass rewrote is a new object."
        )
    ),
    embedding_projections=("popcorn",),
    scope_key_pattern=SCOPE_KEY,
    model_config=model_deployment,
)
