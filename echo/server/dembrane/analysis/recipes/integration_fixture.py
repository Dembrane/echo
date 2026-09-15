"""An integration-shaped output: selected revisions as an external API's request body.

This recipe exists to prove the extension point. It was added through type and
recipe registration alone: no execution internal, no storage and no graph
algorithm changed for it. It reads the object revisions a host selects
(arguments, deduplicated arguments and tensions), projects each into one item
of a delivery payload, and publishes that payload through the same run,
provenance and revision storage every other recipe uses. The runs API shows it
as JSON like any other output.

Scope `delivery:<destination>`: each configured destination is its own scope,
so its publications are ordered and fenced apart from the others, and its
payload keeps one object identity whose revisions are its history.

What it deliberately does not do:

- no model step, so generation cannot reach a provider at all;
- no embedding and no Map projection, so the payload is never a node and no
  vector is computed for it;
- no network call. Generating a payload and delivering it are separate
  actions. Delivery will bring its own authorization, destination and receipt,
  keyed by the `idempotencyKey` this recipe derives from the body.

The body is deterministic: the same selected revisions and parameters give the
same bytes, so an unchanged refresh reuses the output instead of writing a new
revision.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import Field, BaseModel, ConfigDict

from dembrane.analysis import types
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.executor import StepResult, RecipeContext
from dembrane.analysis.registry import Recipe, StepDef, InputRequest, IdentityPolicy
from dembrane.analysis.contracts import (
    StepKind,
    CheckStatus,
    CheckOutcome,
    ObjectRevision,
)

RECIPE_ID = "integration.fixture_delivery"
RECIPE_VERSION = "integration-fixture-v1"
PAYLOAD_TYPE = "integration.delivery_payload"

# The destination's contract version, carried in the body so a receiver can
# tell which shape it was sent.
BODY_SCHEMA_VERSION = 1
SHAPE_CHECK = "delivery-body-v1"
# A destination this fixture stands for. Nothing is ever sent here.
ENDPOINT = "https://example.invalid/v1/deliberation-items"
DEFAULT_MAX_ITEMS = 100
# The lineage key of the one payload object a destination scope owns.
PAYLOAD_KEY = "payload"

INPUT_TYPES = ("argument", "deduplicated_argument", "tension")
SCOPE_KEY = re.compile(r"^delivery:[a-z0-9][a-z0-9-]{0,39}$")


# ── the destination's schema ────────────────────────────────────────────


class DeliverySource(types.Payload):
    conversationId: str = Field(min_length=1)
    quote: str | None = None


class DeliveryRevision(types.Payload):
    """What the receiver needs to cite the exact content it was sent."""

    objectId: str = Field(min_length=1)
    revisionId: str = Field(min_length=1)
    recipeId: str | None = None
    recipeVersion: str | None = None


class DeliveryItem(types.Payload):
    externalId: str = Field(min_length=1)
    type: Literal["argument", "deduplicated_argument", "tension"]
    title: str = Field(min_length=1)
    body: str = Field(min_length=1)
    question: str | None = None
    sources: list[DeliverySource] = Field(default_factory=list)
    revision: DeliveryRevision


class DeliveryBody(types.Payload):
    """Shaped like the request body of an external API, not sent by this recipe."""

    destination: str = Field(min_length=1)
    schemaVersion: int = Field(ge=1)
    idempotencyKey: str = Field(min_length=1)
    projectId: str = Field(min_length=1)
    counts: dict[str, int] = Field(default_factory=dict)
    items: list[DeliveryItem] = Field(default_factory=list)


class DeliveryPayload(types.Payload):
    endpoint: str = Field(min_length=1)
    method: Literal["POST"]
    contentType: Literal["application/json"]
    body: DeliveryBody


DELIVERY_PAYLOAD = types.ObjectType(
    id=PAYLOAD_TYPE,
    schema_version=1,
    payload_model=DeliveryPayload,
    description=(
        "A request body for an external destination, built from selected object revisions. "
        "It has no Map projection and no embedding, and generating it sends nothing."
    ),
)

types.register_object_type(DELIVERY_PAYLOAD, replace=True)


# ── projection ──────────────────────────────────────────────────────────


def destination_of(scope_key: str) -> str:
    return scope_key.split(":", 1)[1]


def external_id(revision: ObjectRevision) -> str:
    """A stable token for the receiver: derived from the object's identity, so
    the same object keeps its external id across runs and rewordings."""
    return content_hash({"type": revision.type, "objectId": revision.object_id})[:24]


def _sources(revision: ObjectRevision) -> list[dict[str, Any]]:
    """The revision's checked evidence: its source references, or for a
    revision without any the quotes its payload carries."""
    refs = [
        {"conversationId": ref.conversation_id, "quote": ref.quote}
        for ref in revision.provenance.source_refs
        if ref.quote and ref.quote.strip()
    ]
    if refs:
        return refs
    return [
        {"conversationId": str(item["conversationId"]), "quote": str(quote)}
        for item in revision.payload.get("evidence") or []
        for quote in item.get("quotes") or []
        if str(quote).strip()
    ]


def _item(revision: ObjectRevision) -> dict[str, Any]:
    """One revision as one delivery item. Each type is projected by this
    recipe, never by a Map or view projection."""
    payload = revision.payload
    if revision.type == "tension":
        title = f"{payload['poleA']} / {payload['poleB']}"
        body = payload["knot"]
        question = payload["toResolve"]
        sources = [
            {"conversationId": quote["conversationId"], "quote": quote.get("text")}
            for quote in payload.get("quotes") or []
            if quote.get("conversationId")
        ]
    else:
        title = payload["statement"]
        body = payload["statement"]
        question = None
        sources = _sources(revision)
    return {
        "externalId": external_id(revision),
        "type": revision.type,
        "title": title,
        "body": body,
        "question": question,
        "sources": sources,
        "revision": {
            "objectId": revision.object_id,
            "revisionId": revision.id,
            "recipeId": revision.provenance.recipe_id,
            "recipeVersion": revision.provenance.recipe_version,
        },
    }


def build_body(
    *, destination: str, project_id: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """The request body, with an idempotency key derived from its own content
    so a later delivery of the same payload is recognisable as a repeat.

    The key is taken over the body exactly as the schema normalises it, so a
    receiver derives the same key from the bytes it was sent rather than from
    a shape only this process ever held."""
    normalised = [
        DeliveryItem.model_validate(item).model_dump(mode="json", exclude_none=True) for item in items
    ]
    counts: dict[str, int] = {}
    for item in normalised:
        counts[item["type"]] = counts.get(item["type"], 0) + 1
    body = {
        "destination": destination,
        "schemaVersion": BODY_SCHEMA_VERSION,
        "projectId": project_id,
        "counts": counts,
        "items": normalised,
    }
    return {**body, "idempotencyKey": content_hash(body)}


# ── inputs and execution ────────────────────────────────────────────────


class DeliveryParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # What the destination accepts in one request. A selection above it is a
    # failed check, never a body silently cut to fit.
    max_items: int = Field(default=DEFAULT_MAX_ITEMS, ge=1, le=1000)


async def resolve_inputs(request: InputRequest) -> dict[str, Any]:
    """The destination and its contract. The selected revisions reach the
    manifest through the executor, which pins them."""
    return {
        "destination": destination_of(request.scope_key),
        "endpoint": ENDPOINT,
        "bodySchemaVersion": BODY_SCHEMA_VERSION,
    }


async def _done(result: StepResult) -> StepResult:
    return result


async def execute(ctx: RecipeContext) -> None:
    destination = destination_of(ctx.scope_key)
    max_items = int(ctx.parameters["max_items"])
    revisions = await ctx.input_revisions()

    # 1. collect: every selected revision as one item, in manifest order.
    items = [_item(revision) for revision in revisions]
    collected = await ctx.step(
        "collect",
        lambda: _done(StepResult(output={"items": items})),
        inputs={"revisionIds": [r.id for r in revisions]},
    )

    # 2. render: the body and its content-derived idempotency key.
    async def render() -> StepResult:
        return StepResult(
            output=build_body(
                destination=destination, project_id=ctx.project_id, items=list(collected["items"])
            )
        )

    body = await ctx.step("render", render, inputs={"destination": destination, "collect": content_hash(collected)})

    # 3. validate: the shape the destination declared, and where each item came from.
    async def validate() -> StepResult:
        selected = set(ctx.input_revision_ids)
        stray = sorted(
            str(item["revision"]["revisionId"])
            for item in body["items"]
            if str(item["revision"]["revisionId"]) not in selected
        )
        too_many = len(body["items"]) > max_items
        failed = bool(stray) or too_many
        message = None
        if too_many:
            message = f"{len(body['items'])} items is more than this destination accepts in one request."
        elif stray:
            message = "An item names a revision this run did not pin."
        return StepResult(
            output={"items": len(body["items"]), "idempotencyKey": body["idempotencyKey"]},
            validation=(
                CheckOutcome(
                    check="body-matches-destination",
                    status=CheckStatus.FAILED if failed else CheckStatus.PASSED,
                    version=SHAPE_CHECK,
                    evidence={
                        "items": len(body["items"]),
                        "maxItems": max_items,
                        "counts": body["counts"],
                        "stray": stray,
                    },
                    message=message,
                ),
            ),
        )

    await ctx.step("validate", validate, inputs={"body": content_hash(body), "maxItems": max_items})

    await ctx.emit(
        PAYLOAD_TYPE,
        PAYLOAD_KEY,
        {
            "endpoint": ENDPOINT,
            "method": "POST",
            "contentType": "application/json",
            "body": body,
        },
        input_revision_ids=[r.id for r in revisions],
    )
    ctx.metrics["deliveryItems"] += len(items)


RECIPE = Recipe(
    id=RECIPE_ID,
    version=RECIPE_VERSION,
    name="Delivery payload (integration fixture)",
    purpose=(
        "Turn selected arguments, deduplicated arguments and tensions into a schema-validated "
        "request body for an external destination. It builds the payload and sends nothing."
    ),
    input_types=INPUT_TYPES,
    steps=(
        StepDef("collect", "1", StepKind.DETERMINISTIC, "Project each selected revision into one delivery item"),
        StepDef("render", "1", StepKind.DETERMINISTIC, "Assemble the request body and its content-derived idempotency key"),
        StepDef(
            "validate",
            "1",
            StepKind.CHECK,
            "The body matches the destination's declared shape and every item names a pinned revision",
            check_version=SHAPE_CHECK,
        ),
    ),
    output_types=(PAYLOAD_TYPE,),
    execute=execute,
    resolve_inputs=resolve_inputs,
    validation_rules=(
        "every item names a revision this run pinned",
        "a selection above the destination's limit fails the check rather than being cut to fit",
        "the payload is built and stored; delivering it is a separate action with its own authorization",
    ),
    identity_policy=IdentityPolicy(
        description=(
            "One payload object per destination scope: each run appends a revision, so a destination's "
            "history is its revisions."
        )
    ),
    parameters_model=DeliveryParameters,
    scope_key_pattern=SCOPE_KEY,
    # No model step, so nothing here depends on a model deployment.
    model_config=lambda: {},
)
