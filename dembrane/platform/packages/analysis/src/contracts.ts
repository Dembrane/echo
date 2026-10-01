/**
 * The shapes the analysis lifecycle passes around, and the errors it raises. Records mirror
 * the analysis_* rows; JSON documents (payloads, provenance, manifests) keep the camelCase
 * keys the Python package wrote, because the rows are shared with it until cutover.
 */

/** How long a claimed run stays its worker's without a checkpoint. Every checkpoint extends it. */
export const DEFAULT_LEASE_SECONDS = 20 * 60;

export type RunStatus =
  | "queued"
  | "waiting_for_inputs"
  | "running"
  | "needs_review"
  | "ready"
  | "failed"
  | "cancelled"
  | "superseded";
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "waiting_for_inputs",
  "running",
];

export type RunMode = "refresh" | "regenerate" | "retry";
export const RUN_MODES: readonly RunMode[] = ["refresh", "regenerate", "retry"];
export type ScopeKind = "producer" | "view";
export type StepKind = "model" | "deterministic" | "check";
export type StepStatus = "running" | "completed" | "failed";
export type RevisionStatus = "staged" | "candidate" | "published" | "discarded";
export type RelationStatus = "staged" | "published" | "discarded";
export type Origin = "generated" | "authored" | "imported";
export type RelationBasis = "extracted" | "inferred" | "authored";
export const RELATION_BASES: readonly RelationBasis[] = ["extracted", "inferred", "authored"];
export type CheckStatus = "passed" | "failed" | "needs_review";
export type OutboxStatus = "pending" | "dispatching" | "delivered" | "dead";
export type Writer = "legacy" | "analysis";

/**
 * Producer scopes that own objects no recipe produces: authored objects and imports
 * without a producer scope of their own. Their publication sequence orders the outbox
 * events of edits and imports.
 */
export const AUTHORED_SCOPE_OWNER = "authored";
export const IMPORTED_SCOPE_OWNER = "imported";

export type Json = Record<string, unknown>;

// ── errors ──────────────────────────────────────────────────────────────

/** The database refused or failed an analysis read or write. */
export class AnalysisStoreError extends Error {}

/** A request, payload or reference is invalid; nothing is written on its account. */
export class AnalysisValidationError extends Error {}

/** A reference crosses a project, a scope or an object it may not. */
export class ReferenceViolation extends AnalysisValidationError {}

/** A manifest's references or checks failed validation inside publication; all rolled back. */
export class PublicationRejected extends AnalysisValidationError {
  constructor(readonly reasons: string[]) {
    super(`publication rejected: ${reasons.slice(0, 5).join("; ")}`);
  }
}

/** A completed step artifact was about to be rewritten with other inputs. */
export class StepConflict extends AnalysisValidationError {}

/** The scope's writer is not the analysis executor (a legacy producer owns it). */
export class WriterNotOwner extends AnalysisValidationError {}

/** The ready run a refresh meant to reuse is no longer the scope's current output. */
export class ReuseOutdated extends Error {
  constructor(readonly currentRunId: string | null) {
    super(`the scope's current run is now ${currentRunId}`);
  }
}

/** A retry refused because an equivalent run is already in flight: that run is the live answer. */
export class RetryConflict extends AnalysisValidationError {
  constructor(readonly active: Run) {
    super(`an equivalent run is already in flight: ${active.id}`);
  }
}

/** An edit named an expected revision that is no longer the head. */
export class RevisionConflict extends Error {
  constructor(
    readonly objectId: string,
    readonly expectedRevisionId: string | null,
    readonly current: ObjectRevision | null,
  ) {
    super(`object ${objectId} has moved on from revision ${expectedRevisionId}`);
  }
}

/** A view scope advanced past the snapshot an assembly expected. */
export class SnapshotConflict extends Error {
  constructor(
    readonly scopeId: string,
    readonly expected: string | null,
    readonly current: string | null,
  ) {
    super(`view scope ${scopeId} is at ${current}, not ${expected}`);
  }
}

// ── records ─────────────────────────────────────────────────────────────

/** Where evidence came from: a conversation and source version, the quote and its location. */
export interface SourceRef {
  readonly conversationId: string;
  readonly sourceFingerprint?: string | null;
  readonly quote?: string | null;
  readonly location?: Json | null;
}

export function sourceRefJson(ref: SourceRef): Json {
  const out: Json = { conversationId: ref.conversationId };
  if (ref.sourceFingerprint !== undefined && ref.sourceFingerprint !== null)
    out.sourceFingerprint = ref.sourceFingerprint;
  if (ref.quote !== undefined && ref.quote !== null) out.quote = ref.quote;
  if (ref.location !== undefined && ref.location !== null) out.location = ref.location;
  return out;
}

export function sourceRefFromJson(data: Json): SourceRef {
  return {
    conversationId: String(data.conversationId),
    sourceFingerprint: (data.sourceFingerprint as string | undefined) ?? null,
    quote: (data.quote as string | undefined) ?? null,
    location: (data.location as Json | undefined) ?? null,
  };
}

export interface Scope {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ScopeKind;
  readonly scopeKey: string;
  readonly recipeId: string | null;
  readonly viewId: string | null;
  readonly nextRequestOrder: number;
  readonly generationEpoch: number;
  readonly publicationSequence: number;
  readonly currentRunId: string | null;
  readonly currentRequestOrder: number | null;
  readonly currentSnapshotId: string | null;
  readonly writer: Writer;
  readonly writerFence: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface Run {
  readonly id: string;
  readonly projectId: string;
  readonly scopeId: string;
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly definition: Json;
  readonly mode: RunMode;
  readonly epoch: number;
  readonly idempotencyKey: string;
  readonly requestOrder: number;
  readonly requestFingerprint: string;
  readonly status: RunStatus;
  readonly inputFingerprint: string | null;
  readonly hashVersion: string;
  readonly inputManifest: Json | null;
  readonly parameters: Json;
  readonly context: Json;
  readonly dependsOn: string[];
  readonly progress: Json;
  readonly lease: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attempt: number;
  readonly writerFence: number;
  readonly executionRef: string | null;
  readonly outputManifest: Json | null;
  readonly checks: Json[];
  readonly metrics: Json;
  readonly error: string | null;
  readonly reusedRunId: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export const isActiveRun = (run: Run) => ACTIVE_RUN_STATUSES.includes(run.status);

export interface Step {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepKey: string;
  readonly stepVersion: string;
  readonly kind: StepKind;
  readonly cacheKey: string;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly hashVersion: string;
  readonly lease: string | null;
  readonly reusedStepId: string | null;
  readonly checkpoint: Json | null;
  readonly output: unknown;
  readonly validation: Json[];
  readonly usage: Json;
  readonly error: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
}

export interface ObjectRecord {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly lineageKey: string;
  readonly scopeId: string | null;
  readonly currentRevisionId: string | null;
  readonly revisionCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface Provenance {
  readonly runId: string | null;
  readonly origin: Origin;
  readonly recipeId?: string | null;
  readonly recipeVersion?: string | null;
  readonly inputRevisionIds?: readonly string[];
  readonly sourceRefs?: readonly SourceRef[];
  /** Anything else a producer records: a legacy import key, a check outcome, a lineage note. */
  readonly extra?: Json;
}

export function provenanceJson(p: Provenance): Json {
  const out: Json = {
    runId: p.runId,
    origin: p.origin,
    inputRevisionIds: [...(p.inputRevisionIds ?? [])],
    sourceRefs: (p.sourceRefs ?? []).map(sourceRefJson),
  };
  if (p.recipeId !== undefined && p.recipeId !== null) out.recipeId = p.recipeId;
  if (p.recipeVersion !== undefined && p.recipeVersion !== null)
    out.recipeVersion = p.recipeVersion;
  if (p.extra && Object.keys(p.extra).length) out.extra = p.extra;
  return out;
}

export function provenanceFromJson(data: Json): Provenance {
  return {
    runId: (data.runId as string | undefined) ?? null,
    origin: data.origin as Origin,
    recipeId: (data.recipeId as string | undefined) ?? null,
    recipeVersion: (data.recipeVersion as string | undefined) ?? null,
    inputRevisionIds: ((data.inputRevisionIds as string[] | undefined) ?? []).map(String),
    sourceRefs: ((data.sourceRefs as Json[] | undefined) ?? []).map(sourceRefFromJson),
    extra: { ...((data.extra as Json | undefined) ?? {}) },
  };
}

export const extraOf = (p: Provenance): Json => p.extra ?? {};

/** The revision envelope. Immutable once published. */
export interface ObjectRevision {
  readonly id: string;
  readonly objectId: string;
  readonly projectId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly revisionNumber: number;
  readonly status: RevisionStatus;
  readonly payload: Json;
  readonly attributes: Json;
  readonly provenance: Provenance;
  readonly contentHash: string;
  readonly hashVersion: string;
  readonly runId: string | null;
  readonly parentRevisionId: string | null;
  readonly embeddingRefs: Json | null;
  readonly actorId: string | null;
  readonly reason: string | null;
  /** What the host said they changed; null on generated revisions and older authored ones. */
  readonly changeKind: string | null;
  readonly createdAt: string | null;
  readonly publishedAt: string | null;
}

export interface Relation {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly basis: RelationBasis;
  readonly status: RelationStatus;
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly fromObjectId: string;
  readonly toObjectId: string;
  readonly attributes: Json;
  readonly provenance: Json;
  readonly contentHash: string;
  readonly hashVersion: string;
  readonly runId: string | null;
  readonly createdAt: string | null;
  readonly publishedAt: string | null;
}

export interface Snapshot {
  readonly id: string;
  readonly projectId: string;
  readonly scopeId: string;
  readonly viewId: string;
  readonly manifest: Json;
  readonly contentHash: string;
  readonly manifestVersion: number;
  readonly parentSnapshotId: string | null;
  readonly settings: Json;
  readonly versions: Json;
  readonly embeddingConfig: Json | null;
  readonly hashVersion: string;
  readonly createdBy: string | null;
  readonly sourceEventId: string | null;
  readonly createdAt: string | null;
}

export interface OutboxEvent {
  readonly id: string;
  readonly projectId: string;
  readonly scopeId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly status: OutboxStatus;
  readonly runId: string | null;
  readonly snapshotId: string | null;
  readonly payload: Json;
  readonly attempts: number;
  readonly claim: string | null;
  readonly nextAttemptAt: string | null;
  readonly consumers: Json;
  readonly lastError: string | null;
  readonly createdAt: string | null;
  readonly deliveredAt: string | null;
}

/** One check's result; evidence is what the check actually looked at. */
export interface CheckOutcome {
  readonly check: string;
  readonly status: CheckStatus;
  readonly version?: string;
  readonly evidence?: Json;
  readonly message?: string | null;
}

export function checkJson(c: CheckOutcome): Json {
  const out: Json = {
    check: c.check,
    status: c.status,
    version: c.version ?? "1",
    evidence: c.evidence ?? {},
  };
  if (c.message !== undefined && c.message !== null) out.message = c.message;
  return out;
}

export function checkFromJson(data: Json): CheckOutcome {
  return {
    check: String(data.check),
    status: data.status as CheckStatus,
    version: String(data.version || "1"),
    evidence: { ...((data.evidence as Json | undefined) ?? {}) },
    message: (data.message as string | undefined) ?? null,
  };
}

// ── writes ──────────────────────────────────────────────────────────────

export interface NewRun {
  readonly projectId: string;
  readonly scopeId: string;
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly definition: Json;
  readonly mode: RunMode;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly status: RunStatus;
  /** null: the store allocates the scope's next generation epoch (regenerate). */
  readonly epoch: number | null;
  readonly parameters: Json;
  readonly context: Json;
  readonly inputManifest?: Json | null;
  readonly inputFingerprint?: string | null;
  readonly dependsOn: readonly string[];
  readonly requestedBy: string | null;
  /** A refresh whose inputs match the current ready run: recorded as ready, reusing its manifest. */
  readonly reusedRunId?: string | null;
  readonly outputManifest?: Json | null;
  readonly metrics?: Json;
}

export interface StepWrite {
  readonly stepKey: string;
  readonly stepVersion: string;
  readonly kind: StepKind;
  readonly cacheKey: string;
  readonly status: StepStatus;
  readonly output?: unknown;
  readonly checkpoint?: Json | null;
  readonly validation?: readonly Json[];
  readonly usage?: Json;
  readonly error?: string | null;
  readonly reusedStepId?: string | null;
}

export interface NewRevision {
  readonly projectId: string;
  readonly objectId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly origin: Origin;
  readonly payload: Json;
  readonly attributes: Json;
  readonly provenance: Provenance;
  readonly contentHash: string;
  readonly status: RevisionStatus;
  readonly runId?: string | null;
  readonly parentRevisionId?: string | null;
  readonly embeddingRefs?: Json | null;
  readonly actorId?: string | null;
  readonly reason?: string | null;
  readonly changeKind?: string | null;
  /** A fixed id makes a repeat import land on the same row. */
  readonly revisionId?: string | null;
}

export interface NewRelation {
  readonly projectId: string;
  readonly type: string;
  readonly basis: RelationBasis;
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly fromObjectId: string;
  readonly toObjectId: string;
  readonly attributes: Json;
  readonly provenance: Json;
  readonly contentHash: string;
  readonly runId?: string | null;
}

export interface NewSnapshot {
  readonly projectId: string;
  readonly scopeId: string;
  readonly viewId: string;
  readonly manifest: Json;
  readonly contentHash: string;
  readonly manifestVersion?: number;
  readonly settings?: Json;
  readonly versions?: Json;
  readonly embeddingConfig?: Json | null;
  readonly createdBy?: string | null;
  /** The outbox event this snapshot is the effect of, if any. */
  readonly sourceEventId?: string | null;
}

/** claimed: running under the new lease. busy: at the recipe's running limit. inactive: nothing to run. */
export interface ClaimResult {
  readonly outcome: "claimed" | "busy" | "inactive";
  readonly run: Run | null;
}

/** ready, superseded, inactive (not this worker's any more) or conflict (a head moved since staging). */
export interface PublishResult {
  readonly outcome: "ready" | "superseded" | "inactive" | "conflict";
  readonly eventId?: string | null;
  readonly sequence?: number | null;
  readonly conflicts?: readonly string[];
}

export interface WakeResult {
  readonly woken: readonly Run[];
  readonly failed: readonly Run[];
}
