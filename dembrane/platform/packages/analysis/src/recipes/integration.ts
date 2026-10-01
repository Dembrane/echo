import type { Json, ObjectRevision } from "../contracts";
import { type RecipeContext, stepResult } from "../executor";
import { contentHash } from "../hashing";
import type { InputRequest, Recipe } from "../registry";
import { s, validateAgainst, withDefault } from "../schema";
import { DeliveryItem } from "../types";

/**
 * An integration-shaped output: selected revisions as an external API's request body. It
 * proves the extension point: no model step, no embedding, no network call. The body is
 * deterministic, so an unchanged refresh reuses the output instead of writing a revision.
 */

export const RECIPE_ID = "integration.fixture_delivery";
export const RECIPE_VERSION = "integration-fixture-v1";
export const PAYLOAD_TYPE = "integration.delivery_payload";
export const BODY_SCHEMA_VERSION = 1;
export const SHAPE_CHECK = "delivery-body-v1";
/** A destination this fixture stands for. Nothing is ever sent here. */
export const ENDPOINT = "https://example.invalid/v1/deliberation-items";
export const DEFAULT_MAX_ITEMS = 100;
export const PAYLOAD_KEY = "payload";
const INPUT_TYPES = ["argument", "deduplicated_argument", "tension"];

export const destinationOf = (scopeKey: string) => scopeKey.split(":").slice(1).join(":");

/** A stable token for the receiver, derived from the object's identity. */
export const externalId = (r: ObjectRevision) =>
  contentHash({ type: r.type, objectId: r.objectId }).slice(0, 24);

function sources(r: ObjectRevision): Json[] {
  const refs = (r.provenance.sourceRefs ?? [])
    .filter((ref) => ref.quote?.trim())
    .map((ref) => ({ conversationId: ref.conversationId, quote: ref.quote }));
  if (refs.length) return refs;
  return ((r.payload.evidence as Json[] | undefined) ?? []).flatMap((item) =>
    ((item.quotes as unknown[] | undefined) ?? [])
      .filter((q) => String(q).trim())
      .map((q) => ({ conversationId: String(item.conversationId), quote: String(q) })),
  );
}

function item(r: ObjectRevision): Json {
  const p = r.payload;
  let title: unknown;
  let body: unknown;
  let question: unknown = null;
  let srcs: Json[];
  if (r.type === "tension") {
    title = `${p.poleA} / ${p.poleB}`;
    body = p.knot;
    question = p.toResolve;
    srcs = ((p.quotes as Json[] | undefined) ?? [])
      .filter((q) => q.conversationId)
      .map((q) => ({ conversationId: q.conversationId, quote: q.text ?? null }));
  } else {
    title = p.statement;
    body = p.statement;
    srcs = sources(r);
  }
  return {
    externalId: externalId(r),
    type: r.type,
    title,
    body,
    question,
    sources: srcs,
    revision: {
      objectId: r.objectId,
      revisionId: r.id,
      recipeId: r.provenance.recipeId ?? null,
      recipeVersion: r.provenance.recipeVersion ?? null,
    },
  };
}

/** The request body with an idempotency key taken over the body exactly as the schema normalises it. */
export function buildBody(o: { destination: string; projectId: string; items: Json[] }): Json {
  const normalised = o.items.map((i) => {
    const r = validateAgainst(DeliveryItem, i);
    if (!r.ok) throw new Error("a delivery item does not match its schema");
    return JSON.parse(JSON.stringify(r.value)) as Json;
  });
  const counts: Record<string, number> = {};
  for (const i of normalised) counts[String(i.type)] = (counts[String(i.type)] ?? 0) + 1;
  const body = {
    destination: o.destination,
    schemaVersion: BODY_SCHEMA_VERSION,
    projectId: o.projectId,
    counts,
    items: normalised,
  };
  return { ...body, idempotencyKey: contentHash(body) };
}

async function resolveInputs(request: InputRequest): Promise<Json> {
  return {
    destination: destinationOf(request.scopeKey),
    endpoint: ENDPOINT,
    bodySchemaVersion: BODY_SCHEMA_VERSION,
  };
}

async function execute(ctx: RecipeContext): Promise<void> {
  const destination = destinationOf(ctx.scopeKey);
  const maxItems = Number(ctx.parameters.max_items);
  const revisions = await ctx.inputRevisions();
  const items = revisions.map(item);
  const collected = await ctx.step<Json>("collect", async () => stepResult({ output: { items } }), {
    inputs: { revisionIds: revisions.map((r) => r.id) },
  });
  const body = await ctx.step<Json>(
    "render",
    async () =>
      stepResult({
        output: buildBody({
          destination,
          projectId: ctx.projectId,
          items: [...(collected.items as Json[])],
        }),
      }),
    { inputs: { destination, collect: contentHash(collected) } },
  );
  await ctx.step(
    "validate",
    async () => {
      const selected = new Set(ctx.inputRevisionIds);
      const bodyItems = body.items as Json[];
      const stray = bodyItems
        .map((i) => String((i.revision as Json).revisionId))
        .filter((id) => !selected.has(id))
        .sort();
      const tooMany = bodyItems.length > maxItems;
      const failed = stray.length > 0 || tooMany;
      let message: string | null = null;
      if (tooMany)
        message = `${bodyItems.length} items is more than this destination accepts in one request.`;
      else if (stray.length) message = "An item names a revision this run did not pin.";
      return stepResult({
        output: { items: bodyItems.length, idempotencyKey: body.idempotencyKey },
        validation: [
          {
            check: "body-matches-destination",
            status: failed ? "failed" : "passed",
            version: SHAPE_CHECK,
            evidence: { items: bodyItems.length, maxItems, counts: body.counts, stray },
            message,
          },
        ],
      });
    },
    { inputs: { body: contentHash(body), maxItems } },
  );
  await ctx.emit(
    PAYLOAD_TYPE,
    PAYLOAD_KEY,
    { endpoint: ENDPOINT, method: "POST", contentType: "application/json", body },
    { inputRevisionIds: revisions.map((r) => r.id) },
  );
  ctx.count("deliveryItems", items.length);
}

export const RECIPE: Recipe = {
  id: RECIPE_ID,
  version: RECIPE_VERSION,
  name: "Delivery payload (integration fixture)",
  purpose:
    "Turn selected arguments, deduplicated arguments and tensions into a schema-validated request body for an external destination. It builds the payload and sends nothing.",
  inputTypes: INPUT_TYPES,
  steps: [
    {
      key: "collect",
      version: "1",
      kind: "deterministic",
      description: "Project each selected revision into one delivery item",
    },
    {
      key: "render",
      version: "1",
      kind: "deterministic",
      description: "Assemble the request body and its content-derived idempotency key",
    },
    {
      key: "validate",
      version: "1",
      kind: "check",
      description:
        "The body matches the destination's declared shape and every item names a pinned revision",
      checkVersion: SHAPE_CHECK,
    },
  ],
  outputTypes: [PAYLOAD_TYPE],
  execute,
  resolveInputs,
  validationRules: [
    "every item names a revision this run pinned",
    "a selection above the destination's limit fails the check rather than being cut to fit",
    "the payload is built and stored; delivering it is a separate action with its own authorization",
  ],
  identityPolicy: {
    description:
      "One payload object per destination scope: each run appends a revision, so a destination's history is its revisions.",
  },
  parameters: {
    name: "DeliveryParameters",
    fields: [withDefault("max_items", s.int({ ge: 1, le: 1000 }), DEFAULT_MAX_ITEMS)],
  },
  scopeKeyPattern: /^delivery:[a-z0-9][a-z0-9-]{0,39}$/,
  modelConfig: () => ({}),
};
