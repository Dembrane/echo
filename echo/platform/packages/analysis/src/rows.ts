import {
  type Json,
  type ObjectRecord,
  type ObjectRevision,
  type OutboxEvent,
  provenanceFromJson,
  type Relation,
  type Run,
  type Scope,
  type Snapshot,
  type Step,
} from "./contracts";
import type { Row } from "./db";

/** Row to record mappings for the analysis tables; JSON columns arrive parsed. */

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const objOrNull = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function scopeOf(r: Row): Scope {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as Scope["kind"],
    scopeKey: String(r.scope_key),
    recipeId: str(r.recipe_id),
    viewId: str(r.view_id),
    nextRequestOrder: Number(r.next_request_order),
    generationEpoch: Number(r.generation_epoch),
    publicationSequence: Number(r.publication_sequence),
    currentRunId: str(r.current_run_id),
    currentRequestOrder: r.current_request_order === null ? null : Number(r.current_request_order),
    currentSnapshotId: str(r.current_snapshot_id),
    writer: r.writer as Scope["writer"],
    writerFence: Number(r.writer_fence),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function runOf(r: Row): Run {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    scopeId: String(r.scope_id),
    recipeId: String(r.recipe_id),
    recipeVersion: String(r.recipe_version),
    definition: obj(r.definition),
    mode: r.mode as Run["mode"],
    epoch: Number(r.epoch),
    idempotencyKey: String(r.idempotency_key),
    requestOrder: Number(r.request_order),
    requestFingerprint: String(r.request_fingerprint),
    status: r.status as Run["status"],
    inputFingerprint: str(r.input_fingerprint),
    hashVersion: String(r.hash_version),
    inputManifest: objOrNull(r.input_manifest),
    parameters: obj(r.parameters),
    context: obj(r.context),
    dependsOn: arr<string>(r.depends_on).map(String),
    progress: obj(r.progress),
    lease: str(r.lease),
    leaseExpiresAt: str(r.lease_expires_at),
    attempt: Number(r.attempt),
    writerFence: Number(r.writer_fence),
    executionRef: str(r.execution_ref),
    outputManifest: objOrNull(r.output_manifest),
    checks: arr<Json>(r.checks),
    metrics: obj(r.metrics),
    error: str(r.error),
    reusedRunId: str(r.reused_run_id),
    requestedBy: str(r.requested_by),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    startedAt: str(r.started_at),
    completedAt: str(r.completed_at),
  };
}

export function stepOf(r: Row): Step {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    runId: String(r.run_id),
    stepKey: String(r.step_key),
    stepVersion: String(r.step_version),
    kind: r.kind as Step["kind"],
    cacheKey: String(r.cache_key),
    status: r.status as Step["status"],
    attempt: Number(r.attempt),
    hashVersion: String(r.hash_version),
    lease: str(r.lease),
    reusedStepId: str(r.reused_step_id),
    checkpoint: objOrNull(r.checkpoint),
    output: r.output ?? null,
    validation: arr<Json>(r.validation),
    usage: obj(r.usage),
    error: str(r.error),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    completedAt: str(r.completed_at),
  };
}

export function objectOf(r: Row): ObjectRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    type: String(r.type),
    lineageKey: String(r.lineage_key),
    scopeId: str(r.scope_id),
    currentRevisionId: str(r.current_revision_id),
    revisionCount: Number(r.revision_count),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function revisionOf(r: Row): ObjectRevision {
  return {
    id: String(r.id),
    objectId: String(r.object_id),
    projectId: String(r.project_id),
    type: String(r.type),
    schemaVersion: Number(r.schema_version),
    revisionNumber: Number(r.revision_number),
    status: r.status as ObjectRevision["status"],
    payload: obj(r.payload),
    attributes: obj(r.attributes),
    provenance: provenanceFromJson(objOrNull(r.provenance) ?? { origin: r.origin }),
    contentHash: String(r.content_hash),
    hashVersion: String(r.hash_version),
    runId: str(r.run_id),
    parentRevisionId: str(r.parent_revision_id),
    embeddingRefs: objOrNull(r.embedding_refs),
    actorId: str(r.actor_id),
    reason: str(r.reason),
    changeKind: str(r.change_kind),
    createdAt: str(r.created_at),
    publishedAt: str(r.published_at),
  };
}

export function relationOf(r: Row): Relation {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    type: String(r.type),
    basis: r.basis as Relation["basis"],
    status: r.status as Relation["status"],
    fromRevisionId: String(r.from_revision_id),
    toRevisionId: String(r.to_revision_id),
    fromObjectId: String(r.from_object_id),
    toObjectId: String(r.to_object_id),
    attributes: obj(r.attributes),
    provenance: obj(r.provenance),
    contentHash: String(r.content_hash),
    hashVersion: String(r.hash_version),
    runId: str(r.run_id),
    createdAt: str(r.created_at),
    publishedAt: str(r.published_at),
  };
}

export function snapshotOf(r: Row): Snapshot {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    scopeId: String(r.scope_id),
    viewId: String(r.view_id),
    manifest: obj(r.manifest),
    contentHash: String(r.content_hash),
    manifestVersion: Number(r.manifest_version),
    parentSnapshotId: str(r.parent_snapshot_id),
    settings: obj(r.settings),
    versions: obj(r.versions),
    embeddingConfig: objOrNull(r.embedding_config),
    hashVersion: String(r.hash_version),
    createdBy: str(r.created_by),
    sourceEventId: str(r.source_event_id),
    createdAt: str(r.created_at),
  };
}

export function outboxOf(r: Row): OutboxEvent {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    scopeId: String(r.scope_id),
    sequence: Number(r.sequence),
    eventType: String(r.event_type),
    status: r.status as OutboxEvent["status"],
    runId: str(r.run_id),
    snapshotId: str(r.snapshot_id),
    payload: obj(r.payload),
    attempts: Number(r.attempts),
    claim: str(r.claim),
    nextAttemptAt: str(r.next_attempt_at),
    consumers: obj(r.consumers),
    lastError: str(r.last_error),
    createdAt: str(r.created_at),
    deliveredAt: str(r.delivered_at),
  };
}
