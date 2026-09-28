import {
  AnalysisValidationError,
  type Json,
  RELATION_BASES,
  type RelationBasis,
} from "./contracts";
import {
  describeErrors,
  type Model,
  required,
  type SchemaError,
  s,
  validateAgainst,
  withDefault,
} from "./schema";
import SCHEMAS from "./schemas.json" with { type: "json" };

/**
 * Registered object and relation types: each object type names its payload schema, how
 * its attributes are read, and its capabilities (on the Map with a label, detail and a
 * versioned embedding projection; fact-checkable). Unknown types fail validation.
 * The pydantic JSON schemas the Recipes tab shows live in schemas.json, exported from the
 * Python models they describe.
 */

export class UnknownType extends AnalysisValidationError {}

export class InvalidPayload extends AnalysisValidationError {
  constructor(
    readonly typeId: string,
    readonly errors: readonly SchemaError[],
  ) {
    super(`invalid ${typeId} payload: ${describeErrors(errors)}`);
  }
}

// ── payload schemas ─────────────────────────────────────────────────────

const payload = (name: string, fields: Model["fields"]): Model => ({ name, fields, strip: true });
const list =
  <T>() =>
  () =>
    [] as T[];

const Evidence = payload("Evidence", [
  required("conversationId", s.str({ min: 1 })),
  withDefault("label", s.opt(s.str()), null),
  withDefault("createdAt", s.opt(s.str()), null),
  withDefault("quotes", s.list(s.str()), list()),
]);

const quoteFields = [
  required("text", s.str({ min: 1 })),
  withDefault("conversationId", s.opt(s.str()), null),
  withDefault("location", s.opt(s.dict()), null),
];
const QuoteRef = payload("QuoteRef", quoteFields);

const argumentFields = [
  required("statement", s.str({ min: 1 })),
  required("epistemicKind", s.lit("argument", "claim")),
  withDefault("valence", s.opt(s.lit("positive", "negative", "neutral")), null),
  withDefault("evidence", s.list(s.model(Evidence)), list()),
];
const ArgumentPayload = payload("ArgumentPayload", argumentFields);

const Consolidation = payload("Consolidation", [
  required("strategy", s.str({ min: 1 })),
  required("memberCount", s.int({ ge: 1 })),
  required("verification", s.lit("verified", "singleton", "uncertain")),
  withDefault("rationale", s.opt(s.str()), null),
  withDefault("coverage", s.dict(), () => ({})),
]);

const DeduplicatedArgumentPayload = payload("DeduplicatedArgumentPayload", [
  ...argumentFields,
  required("consolidation", s.model(Consolidation)),
]);

const PopcornPayload = payload("PopcornPayload", [
  required("phrase", s.str({ min: 1, max: 90 })),
  withDefault("question", s.bool(), false),
  withDefault("language", s.opt(s.str()), null),
  withDefault("evidence", s.list(s.model(Evidence)), list()),
]);

const TensionQuote = payload("TensionQuote", [
  ...quoteFields,
  withDefault("pole", s.opt(s.lit("A", "B")), null),
]);

const TensionPayload = payload("TensionPayload", [
  required("poleA", s.str({ min: 1 })),
  required("poleB", s.str({ min: 1 })),
  required("knot", s.str({ min: 1 })),
  required("toResolve", s.str({ min: 1 })),
  withDefault("quotes", s.list(s.model(TensionQuote)), list()),
]);

const StakeholderWeight = payload("StakeholderWeight", [
  required("stake", s.float({ ge: 0, le: 1 })),
  required("mentions", s.float({ ge: 0, le: 1 })),
]);

const StakeholderPayload = payload("StakeholderPayload", [
  required("name", s.str({ min: 1 })),
  required("role", s.str({ min: 1 })),
  required("stake", s.str({ min: 1 })),
  required("rung", s.lit("voiced", "named", "inferred")),
  withDefault("invokedBy", s.opt(s.str()), null),
  required("weight", s.model(StakeholderWeight)),
  withDefault("quotes", s.list(s.model(QuoteRef)), list()),
]);

export const AssessmentSource = payload("AssessmentSource", [
  required("url", s.str({ min: 1 })),
  withDefault("title", s.opt(s.str()), null),
]);

const FactCheckAssessmentPayload = payload("FactCheckAssessmentPayload", [
  required("verdict", s.str({ min: 1 })),
  withDefault("justification", s.str(), ""),
  withDefault("sources", s.list(s.model(AssessmentSource)), list()),
  required("statement", s.str({ min: 1 })),
  withDefault("claimKey", s.opt(s.str()), null),
  withDefault("model", s.opt(s.str()), null),
  withDefault("promptVersion", s.opt(s.str()), null),
]);

const StakeholderAspect = payload("StakeholderAspect", [
  required("kind", s.lit("power", "risk", "opportunity")),
  required("note", s.str({ min: 1 })),
  withDefault("quotes", s.list(s.model(QuoteRef)), list()),
]);

const StakeholderRelationAttributes = payload("StakeholderRelationAttributes", [
  required("label", s.str({ min: 1 })),
  required("intensity", s.float({ ge: 0, le: 1 })),
  required("sentiment", s.float({ ge: -1, le: 1 })),
  required("unowned", s.bool()),
  required("detail", s.str({ min: 1 })),
  withDefault("aspects", s.list(s.model(StakeholderAspect)), list()),
]);

const EvidenceAttributes = payload("EvidenceAttributes", [
  withDefault("rationale", s.opt(s.str()), null),
  withDefault("quotes", s.list(s.model(QuoteRef)), list()),
]);

// The integration fixture's destination schema (recipes/integration.ts projects into it).
const DeliverySource = payload("DeliverySource", [
  required("conversationId", s.str({ min: 1 })),
  withDefault("quote", s.opt(s.str()), null),
]);
const DeliveryRevision = payload("DeliveryRevision", [
  required("objectId", s.str({ min: 1 })),
  required("revisionId", s.str({ min: 1 })),
  withDefault("recipeId", s.opt(s.str()), null),
  withDefault("recipeVersion", s.opt(s.str()), null),
]);
export const DeliveryItem = payload("DeliveryItem", [
  required("externalId", s.str({ min: 1 })),
  required("type", s.lit("argument", "deduplicated_argument", "tension")),
  required("title", s.str({ min: 1 })),
  required("body", s.str({ min: 1 })),
  withDefault("question", s.opt(s.str()), null),
  withDefault("sources", s.list(s.model(DeliverySource)), list()),
  required("revision", s.model(DeliveryRevision)),
]);
const DeliveryBody = payload("DeliveryBody", [
  required("destination", s.str({ min: 1 })),
  required("schemaVersion", s.int({ ge: 1 })),
  required("idempotencyKey", s.str({ min: 1 })),
  required("projectId", s.str({ min: 1 })),
  withDefault("counts", s.dict(s.int()), () => ({})),
  withDefault("items", s.list(s.model(DeliveryItem)), list()),
]);
const DeliveryPayload = payload("DeliveryPayload", [
  required("endpoint", s.str({ min: 1 })),
  required("method", s.lit("POST")),
  required("contentType", s.lit("application/json")),
  required("body", s.model(DeliveryBody)),
]);

// ── capabilities ────────────────────────────────────────────────────────

export interface MapCapability {
  readonly label: (p: Json) => string;
  readonly detail: (p: Json) => Json;
  readonly embeddingText: (p: Json) => string;
  /** Part of the embedding cache input: a projection change is new text, never a rewrite. */
  readonly projectionVersion: string;
}

export interface FactCheckCapability {
  readonly eligible: (payload: Json, attributes: Json) => boolean;
  readonly statement: (payload: Json) => string;
}

export interface ObjectType {
  readonly id: string;
  readonly schemaVersion: number;
  readonly model: Model;
  readonly attributes: (payload: Json) => Json;
  readonly map: MapCapability | null;
  readonly factCheck: FactCheckCapability | null;
  readonly description: string;
}

export interface RelationType {
  readonly id: string;
  readonly fromTypes: ReadonlySet<string>;
  readonly toTypes: ReadonlySet<string>;
  readonly bases: ReadonlySet<RelationBasis>;
  readonly attributesModel: Model | null;
  readonly description: string;
}

const payloadSchemas = SCHEMAS.payloadSchemas as Record<string, Json>;

export function typeMetadata(t: ObjectType): Json {
  return {
    id: t.id,
    schemaVersion: t.schemaVersion,
    description: t.description,
    payloadSchema: payloadSchemas[t.id] ?? null,
    mapCapable: t.map !== null,
    embeddingProjectionVersion: t.map ? t.map.projectionVersion : null,
    factCheckable: t.factCheck !== null,
  };
}

const objectTypes = new Map<string, ObjectType>();
const relationTypes = new Map<string, RelationType>();

export function registerObjectType(t: ObjectType): ObjectType {
  objectTypes.set(t.id, t);
  return t;
}

export function registerRelationType(t: RelationType): RelationType {
  const unknown = [...t.fromTypes, ...t.toTypes].filter((x) => !objectTypes.has(x)).sort();
  if (unknown.length)
    throw new UnknownType(`relation type ${t.id} names unknown object types: ${unknown}`);
  relationTypes.set(t.id, t);
  return t;
}

export function getObjectType(id: string): ObjectType {
  const t = objectTypes.get(id);
  if (!t) throw new UnknownType(`unknown object type '${id}'`);
  return t;
}

export function getRelationType(id: string): RelationType {
  const t = relationTypes.get(id);
  if (!t) throw new UnknownType(`unknown relation type '${id}'`);
  return t;
}

/** The payload as its type's schema normalises it, or InvalidPayload. */
export function validatePayload(typeId: string, value: unknown): Json {
  const t = getObjectType(typeId);
  const r = validateAgainst(t.model, value);
  if (!r.ok) throw new InvalidPayload(typeId, r.errors);
  return r.value;
}

export function attributesFor(typeId: string, payload: Json): Json {
  return Object.fromEntries(
    Object.entries(getObjectType(typeId).attributes(payload)).filter(
      ([, v]) => v !== null && v !== undefined,
    ),
  );
}

export function validateRelation(
  typeId: string,
  opts: { fromType: string; toType: string; basis: string; attributes: unknown },
): Json {
  const t = getRelationType(typeId);
  if (!t.fromTypes.has(opts.fromType))
    throw new AnalysisValidationError(`${typeId} cannot start at a ${opts.fromType}`);
  if (!t.toTypes.has(opts.toType))
    throw new AnalysisValidationError(`${typeId} cannot end at a ${opts.toType}`);
  if (!RELATION_BASES.includes(opts.basis as RelationBasis))
    throw new AnalysisValidationError(`'${opts.basis}' is not a relation basis`);
  if (!t.bases.has(opts.basis as RelationBasis))
    throw new AnalysisValidationError(`${typeId} cannot be recorded as ${opts.basis}`);
  if (!t.attributesModel) {
    if (opts.attributes && Object.keys(opts.attributes as Json).length)
      throw new AnalysisValidationError(`${typeId} carries no attributes`);
    return {};
  }
  const r = validateAgainst(t.attributesModel, opts.attributes ?? {});
  if (!r.ok) throw new InvalidPayload(typeId, r.errors);
  return r.value;
}

export function factCheckEligible(typeId: string, payload: Json, attributes: Json): boolean {
  const t = getObjectType(typeId);
  return t.factCheck?.eligible(payload, attributes) === true;
}

// ── built-in types ──────────────────────────────────────────────────────

/** Whitespace collapsed, exactly Map's embedding input. */
export const normalised = (text: unknown) =>
  String(text ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

const argumentAttributes = (p: Json): Json => ({
  valence: p.valence ?? null,
  epistemicKind: p.epistemicKind ?? null,
});

const argumentDetail = (p: Json): Json => ({
  statement: p.statement,
  epistemicKind: p.epistemicKind,
  valence: p.valence ?? null,
  evidence: (p.evidence as unknown[] | undefined) || [],
});

const claimCheck: FactCheckCapability = {
  eligible: (payload, attributes) =>
    (attributes.epistemicKind || payload.epistemicKind) === "claim",
  statement: (payload) => String(payload.statement),
};

const ARGUMENTS = new Set(["argument", "deduplicated_argument"]);
export const MAP_TYPE_IDS = [
  "argument",
  "deduplicated_argument",
  "popcorn",
  "tension",
  "stakeholder",
];
const MAP_TYPES = new Set(MAP_TYPE_IDS);
const ALL_BASES = new Set<RelationBasis>(RELATION_BASES);

const none = () => ({});

registerObjectType({
  id: "argument",
  schemaVersion: 1,
  model: ArgumentPayload,
  attributes: argumentAttributes,
  map: {
    label: (p) => String(p.statement),
    detail: argumentDetail,
    embeddingText: (p) => normalised(p.statement),
    projectionVersion: "statement-v1",
  },
  factCheck: claimCheck,
  description: "A complete, source-grounded argument or claim from a transcript.",
});

registerObjectType({
  id: "deduplicated_argument",
  schemaVersion: 1,
  model: DeduplicatedArgumentPayload,
  attributes: argumentAttributes,
  map: {
    label: (p) => String(p.statement),
    detail: (p) => ({ ...argumentDetail(p), consolidation: p.consolidation }),
    embeddingText: (p) => normalised(p.statement),
    projectionVersion: "statement-v1",
  },
  factCheck: claimCheck,
  description: "An argument consolidating equivalent source arguments, derived from each.",
});

registerObjectType({
  id: "popcorn",
  schemaVersion: 1,
  model: PopcornPayload,
  attributes: none,
  map: {
    label: (p) => String(p.phrase),
    detail: (p) => ({
      phrase: p.phrase,
      question: p.question ?? false,
      evidence: (p.evidence as unknown[] | undefined) || [],
    }),
    embeddingText: (p) => normalised(p.phrase),
    projectionVersion: "phrase-v1",
  },
  factCheck: null,
  description: "A short phrase from a conversation, as the Popcorn wall shows it.",
});

registerObjectType({
  id: "tension",
  schemaVersion: 1,
  model: TensionPayload,
  attributes: none,
  map: {
    label: (p) => `${p.poleA} / ${p.poleB}`,
    detail: (p) => ({
      poleA: p.poleA,
      poleB: p.poleB,
      narrative: p.knot,
      toResolve: p.toResolve,
      quotes: (p.quotes as unknown[] | undefined) || [],
    }),
    embeddingText: (p) => normalised(`${p.poleA} versus ${p.poleB}. ${p.knot}`),
    projectionVersion: "poles-knot-v1",
  },
  factCheck: null,
  description: "Two evidenced poles, the knot between them and the question to resolve.",
});

registerObjectType({
  id: "stakeholder",
  schemaVersion: 1,
  model: StakeholderPayload,
  attributes: none,
  map: {
    label: (p) => String(p.name),
    detail: (p) => ({
      name: p.name,
      role: p.role,
      stake: p.stake,
      rung: p.rung,
      invokedBy: p.invokedBy ?? null,
      weight: p.weight,
      quotes: (p.quotes as unknown[] | undefined) || [],
    }),
    embeddingText: (p) => normalised(`${p.name}: ${p.role}. ${p.stake}`),
    projectionVersion: "name-role-stake-v1",
  },
  factCheck: null,
  description: "A group with a stake, with how it is evidenced: voiced, named or inferred.",
});

registerObjectType({
  id: "fact_check_assessment",
  schemaVersion: 1,
  model: FactCheckAssessmentPayload,
  attributes: none,
  map: null,
  factCheck: null,
  description: "A completed fact-check of one exact claim revision, linked by `assesses`.",
});

registerObjectType({
  id: "integration.delivery_payload",
  schemaVersion: 1,
  model: DeliveryPayload,
  attributes: none,
  map: null,
  factCheck: null,
  description:
    "A request body for an external destination, built from selected object revisions. It has no Map projection and no embedding, and generating it sends nothing.",
});

const relation = (
  id: string,
  from: Iterable<string>,
  to: Iterable<string>,
  attributesModel: Model | null,
  description: string,
  bases: ReadonlySet<RelationBasis> = ALL_BASES,
) =>
  registerRelationType({
    id,
    fromTypes: new Set(from),
    toTypes: new Set(to),
    bases,
    attributesModel,
    description,
  });

relation(
  "supports_pole_a",
  ARGUMENTS,
  ["tension"],
  EvidenceAttributes,
  "An argument that establishes a tension's pole A.",
);
relation(
  "supports_pole_b",
  ARGUMENTS,
  ["tension"],
  EvidenceAttributes,
  "An argument that establishes a tension's pole B.",
);
relation(
  "holds_position",
  ["stakeholder"],
  [...ARGUMENTS, "tension"],
  EvidenceAttributes,
  "A stakeholder evidenced as holding an argument or a tension's pole.",
);
relation(
  "affected_by",
  ["stakeholder"],
  [...ARGUMENTS, "tension"],
  EvidenceAttributes,
  "A stakeholder evidenced as affected by an argument or a tension.",
);
relation(
  "stakeholder_relation",
  ["stakeholder"],
  ["stakeholder"],
  StakeholderRelationAttributes,
  "A relation between two stakeholders, with its label and aspects.",
);
relation(
  "derived_from",
  MAP_TYPES,
  MAP_TYPES,
  EvidenceAttributes,
  "Explicit lineage: a consolidation, split or merge and its sources.",
);
relation(
  "assesses",
  ["fact_check_assessment"],
  ARGUMENTS,
  null,
  "An assessment of one exact claim revision.",
  new Set<RelationBasis>(["extracted", "authored"]),
);
