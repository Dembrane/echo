import { newId } from "@dembrane/core";
import {
  AnalysisValidationError,
  AUTHORED_SCOPE_OWNER,
  extraOf,
  IMPORTED_SCOPE_OWNER,
  type Json,
  type ObjectRecord,
  type ObjectRevision,
  type Origin,
  type Provenance,
  ReferenceViolation,
  type Relation,
  type RelationBasis,
  type Run,
  type SourceRef,
  sourceRefJson,
} from "./contracts";
import { contentHash } from "./hashing";
import { sortedStrings } from "./registry";
import type { AnalysisStore } from "./store";
import { attributesFor, getObjectType, validatePayload, validateRelation } from "./types";

/**
 * The one revision-writing service: generated revisions are staged under their run and
 * visible only once it publishes (unchanged content reuses the head); a generated update
 * over an authored head never replaces it; authored edits name the revision they started
 * from and a moved head is a RevisionConflict, never last-write-wins; rollback is a new
 * revision with older content. Identity comes from the producer's lineage key.
 */

export const WORDING_KINDS = ["typo", "clarity", "meaning"] as const;
export const CHANGE_KINDS = [...WORDING_KINDS, "withdraw", "restore", "rollback"] as const;
const REASON_MIN = 12;
const WITHDRAW_REASON_MIN = 4;
const REASON_MAX = 1000;

const cleanReason = (reason: string | null | undefined) =>
  String(reason ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

/**
 * The rules per operation for every client that names a kind. A client that names none
 * predates the audit trail: it still writes, and its revision reads as "not recorded".
 */
export function checkChangeKind(
  operation: "edit" | "exclude" | "include" | "rollback",
  changeKind: string | null | undefined,
  reason: string | null | undefined,
): string | null {
  if (changeKind === null || changeKind === undefined) return null;
  const kind = String(changeKind);
  if (!(CHANGE_KINDS as readonly string[]).includes(kind))
    throw new AnalysisValidationError(
      `'${kind}' is not a kind of change: ${CHANGE_KINDS.join(", ")}`,
    );
  const allowed: Record<string, readonly string[]> = {
    edit: WORDING_KINDS,
    exclude: ["withdraw"],
    include: ["restore"],
    rollback: ["rollback"],
  };
  const ok = allowed[operation] ?? [];
  if (!ok.includes(kind))
    throw new AnalysisValidationError(
      `a ${operation} is recorded as ${ok.join(" or ")}, not as '${kind}'`,
    );
  const trimmed = cleanReason(reason);
  const minimum = kind === "meaning" ? REASON_MIN : kind === "withdraw" ? WITHDRAW_REASON_MIN : 0;
  if ([...trimmed].length < minimum)
    throw new AnalysisValidationError("a few more words, so someone reading later understands why");
  if ([...trimmed].length > REASON_MAX)
    throw new AnalysisValidationError(`a reason is at most ${REASON_MAX} characters`);
  return kind;
}

export interface StagedRevision {
  readonly object: ObjectRecord;
  readonly revision: ObjectRevision;
  /** No new revision was written: the head already says this, or a host authored it. */
  readonly reused: boolean;
}

/** What makes two revisions interchangeable; the run id is left out so unchanged output reuses. */
export function revisionContentHash(o: {
  typeId: string;
  schemaVersion: number;
  payload: Json;
  attributes: Json;
  provenance: Provenance;
}): string {
  return contentHash({
    type: o.typeId,
    schemaVersion: o.schemaVersion,
    payload: o.payload,
    attributes: o.attributes,
    origin: o.provenance.origin,
    recipeId: o.provenance.recipeId ?? null,
    recipeVersion: o.provenance.recipeVersion ?? null,
    inputRevisionIds: sortedStrings(o.provenance.inputRevisionIds ?? []),
    sourceRefs: (o.provenance.sourceRefs ?? []).map(sourceRefJson),
  });
}

/** A head is reusable for a computation naming no vector, or the very vector it references. */
function sameEmbedding(current: Json | null, wanted: Json | null | undefined): boolean {
  if (wanted === null || wanted === undefined) return true;
  return contentHash(current ?? {}) === contentHash(wanted);
}

const dedupSorted = (xs: Iterable<string>) => sortedStrings(new Set(xs));

export function relationContentHash(o: {
  typeId: string;
  basis: string;
  from: string;
  to: string;
  attributes: Json;
  sourceRefs: Json[];
}): string {
  return contentHash({
    type: o.typeId,
    basis: o.basis,
    from: o.from,
    to: o.to,
    attributes: o.attributes,
    sourceRefs: o.sourceRefs,
  });
}

export class RevisionService {
  constructor(readonly store: AnalysisStore) {}

  private async head(record: ObjectRecord): Promise<ObjectRevision | null> {
    if (!record.currentRevisionId) return null;
    return (
      (await this.store.getRevisions(record.projectId, [record.currentRevisionId])).get(
        record.currentRevisionId,
      ) ?? null
    );
  }

  private async scopeId(projectId: string, owner: string): Promise<string> {
    const scope = await this.store.ensureScope({
      projectId,
      kind: "producer",
      ownerId: owner,
      scopeKey: "project",
    });
    return scope.id;
  }

  /** Stages one generated revision under a running run; null when the run is no longer ours. */
  async stageGenerated(
    run: Run,
    lease: string,
    o: {
      typeId: string;
      lineageKey: string;
      payload: Json;
      sourceRefs?: readonly SourceRef[];
      inputRevisionIds?: readonly string[];
      embeddingRefs?: Json | null;
      extra?: Json | null;
    },
  ): Promise<StagedRevision | null> {
    const definition = getObjectType(o.typeId);
    const clean = validatePayload(o.typeId, o.payload);
    const attributes = attributesFor(o.typeId, clean);
    const provenance: Provenance = {
      runId: run.id,
      origin: "generated",
      recipeId: run.recipeId,
      recipeVersion: run.recipeVersion,
      inputRevisionIds: dedupSorted(o.inputRevisionIds ?? []),
      sourceRefs: [...(o.sourceRefs ?? [])],
      extra: { ...(o.extra ?? {}) },
    };
    const hashed = revisionContentHash({
      typeId: o.typeId,
      schemaVersion: definition.schemaVersion,
      payload: clean,
      attributes,
      provenance,
    });
    const record = await this.store.ensureObject({
      projectId: run.projectId,
      type: o.typeId,
      lineageKey: o.lineageKey,
      scopeId: run.scopeId,
    });
    const head = await this.head(record);
    // A host's edit or exclusion stays the head until a host changes it.
    if (head && head.provenance.origin === "authored")
      return { object: record, revision: head, reused: true };
    if (head && head.contentHash === hashed && sameEmbedding(head.embeddingRefs, o.embeddingRefs))
      return { object: record, revision: head, reused: true };
    const revision = await this.store.stageRevision(run.id, lease, {
      projectId: run.projectId,
      objectId: record.id,
      type: o.typeId,
      schemaVersion: definition.schemaVersion,
      origin: "generated",
      payload: clean,
      attributes,
      provenance,
      contentHash: hashed,
      status: "staged",
      runId: run.id,
      parentRevisionId: head ? head.id : null,
      embeddingRefs: o.embeddingRefs ?? null,
    });
    if (!revision) return null;
    return { object: record, revision, reused: false };
  }

  async stageRelation(
    run: Run,
    lease: string,
    o: {
      typeId: string;
      from: ObjectRevision;
      to: ObjectRevision;
      basis: RelationBasis;
      attributes?: Json | null;
      sourceRefs?: readonly SourceRef[];
    },
  ): Promise<Relation | null> {
    const clean = validateRelation(o.typeId, {
      fromType: o.from.type,
      toType: o.to.type,
      basis: o.basis,
      attributes: o.attributes ?? null,
    });
    if (o.from.projectId !== run.projectId || o.to.projectId !== run.projectId)
      throw new ReferenceViolation("a relation connects revisions of its own project only");
    if (o.from.id === o.to.id)
      throw new AnalysisValidationError("a relation connects two different revisions");
    const sourceRefs = (o.sourceRefs ?? []).map(sourceRefJson);
    const provenance = {
      runId: run.id,
      recipeId: run.recipeId,
      recipeVersion: run.recipeVersion,
      sourceRefs,
    };
    return this.store.stageRelation(run.id, lease, {
      projectId: run.projectId,
      type: o.typeId,
      basis: o.basis,
      fromRevisionId: o.from.id,
      toRevisionId: o.to.id,
      fromObjectId: o.from.objectId,
      toObjectId: o.to.objectId,
      attributes: clean,
      provenance,
      contentHash: relationContentHash({
        typeId: o.typeId,
        basis: o.basis,
        from: o.from.id,
        to: o.to.id,
        attributes: clean,
        sourceRefs,
      }),
      runId: run.id,
    });
  }

  // ── authored, imported, rolled back ─────────────────────────────────

  private async append(
    record: ObjectRecord,
    o: {
      payload: Json;
      origin: Origin;
      expected: string | null;
      actorId: string | null;
      reason: string | null;
      sourceRefs?: readonly SourceRef[];
      inputRevisionIds?: readonly string[];
      recipeId?: string | null;
      recipeVersion?: string | null;
      extra?: Json;
      revisionId?: string | null;
      embeddingRefs?: Json | null;
      changeKind?: string | null;
    },
  ): Promise<ObjectRevision> {
    const definition = getObjectType(record.type);
    const clean = validatePayload(record.type, o.payload);
    const attributes = attributesFor(record.type, clean);
    const provenance: Provenance = {
      runId: null,
      origin: o.origin,
      recipeId: o.recipeId ?? null,
      recipeVersion: o.recipeVersion ?? null,
      inputRevisionIds: dedupSorted(o.inputRevisionIds ?? []),
      sourceRefs: [...(o.sourceRefs ?? [])],
      extra: { ...(o.extra ?? {}), ...(o.expected ? { before: o.expected } : {}) },
    };
    return this.store.appendRevision(
      {
        projectId: record.projectId,
        objectId: record.id,
        type: record.type,
        schemaVersion: definition.schemaVersion,
        origin: o.origin,
        payload: clean,
        attributes,
        provenance,
        contentHash: revisionContentHash({
          typeId: record.type,
          schemaVersion: definition.schemaVersion,
          payload: clean,
          attributes,
          provenance,
        }),
        status: "published",
        parentRevisionId: o.expected,
        actorId: o.actorId,
        reason: o.reason,
        changeKind: o.changeKind ?? null,
        revisionId: o.revisionId ?? null,
        embeddingRefs: o.embeddingRefs ?? null,
      },
      o.expected,
    );
  }

  private async record(projectId: string, objectId: string): Promise<ObjectRecord> {
    const record = await this.store.getObject(objectId);
    if (!record || record.projectId !== projectId)
      throw new ReferenceViolation(`object ${objectId} is not in this project`);
    return record;
  }

  private async previous(
    projectId: string,
    objectId: string,
    expected: string,
  ): Promise<ObjectRevision> {
    const previous = (await this.store.getRevisions(projectId, [expected])).get(expected);
    if (!previous || previous.objectId !== objectId)
      throw new ReferenceViolation(
        `revision ${expected} is not a published revision of this object`,
      );
    return previous;
  }

  /** Appends an authored revision; RevisionConflict with the head when `expected` moved on. */
  async authorEdit(o: {
    projectId: string;
    objectId: string;
    expected: string;
    payload: Json;
    actorId: string;
    reason?: string | null;
    changeKind?: string | null;
  }): Promise<ObjectRevision> {
    const kind = checkChangeKind("edit", o.changeKind, o.reason);
    const record = await this.record(o.projectId, o.objectId);
    const previous = await this.previous(o.projectId, o.objectId, o.expected);
    return this.append(record, {
      payload: o.payload,
      origin: "authored",
      expected: o.expected,
      actorId: o.actorId,
      reason: o.reason ?? null,
      sourceRefs: previous.provenance.sourceRefs ?? [],
      inputRevisionIds: previous.provenance.inputRevisionIds ?? [],
      recipeId: previous.provenance.recipeId ?? null,
      recipeVersion: previous.provenance.recipeVersion ?? null,
      extra: {
        authoredFrom: o.expected,
        ...(extraOf(previous.provenance).membershipExcluded ? { membershipExcluded: true } : {}),
      },
      changeKind: kind,
    });
  }

  /** Appends a reversible membership decision without altering content. */
  async setExcluded(o: {
    projectId: string;
    objectId: string;
    expected: string;
    excluded: boolean;
    actorId: string;
    reason?: string | null;
    changeKind?: string | null;
  }): Promise<ObjectRevision> {
    const kind = checkChangeKind(o.excluded ? "exclude" : "include", o.changeKind, o.reason);
    const record = await this.record(o.projectId, o.objectId);
    const previous = await this.previous(o.projectId, o.objectId, o.expected);
    return this.append(record, {
      payload: previous.payload,
      origin: "authored",
      expected: o.expected,
      actorId: o.actorId,
      reason: o.reason ?? null,
      sourceRefs: previous.provenance.sourceRefs ?? [],
      inputRevisionIds: previous.provenance.inputRevisionIds ?? [],
      recipeId: previous.provenance.recipeId ?? null,
      recipeVersion: previous.provenance.recipeVersion ?? null,
      extra: { authoredFrom: o.expected, membershipExcluded: o.excluded },
      embeddingRefs: previous.embeddingRefs,
      changeKind: kind,
    });
  }

  async createAuthored(o: {
    projectId: string;
    typeId: string;
    payload: Json;
    actorId: string;
    reason?: string | null;
  }): Promise<ObjectRevision> {
    const record = await this.store.ensureObject({
      projectId: o.projectId,
      type: o.typeId,
      lineageKey: `authored:${crypto.randomUUID()}`,
      scopeId: await this.scopeId(o.projectId, AUTHORED_SCOPE_OWNER),
    });
    return this.append(record, {
      payload: o.payload,
      origin: "authored",
      expected: null,
      actorId: o.actorId,
      reason: o.reason ?? null,
    });
  }

  /** Imports saved history; a repeat of the same content or fixed revision id returns the first. */
  async importRevision(o: {
    projectId: string;
    typeId: string;
    lineageKey: string;
    payload: Json;
    importKey: string;
    scopeId?: string | null;
    sourceRefs?: readonly SourceRef[];
    recipeId?: string | null;
    recipeVersion?: string | null;
    revisionId?: string | null;
    extra?: Json | null;
    embeddingRefs?: Json | null;
    objectId?: string | null;
  }): Promise<ObjectRevision> {
    if (o.embeddingRefs && !o.embeddingRefs.embeddingId)
      throw new AnalysisValidationError("an embedding reference names its embedding");
    const record = await this.store.ensureObject({
      projectId: o.projectId,
      type: o.typeId,
      lineageKey: o.lineageKey,
      scopeId: o.scopeId ?? (await this.scopeId(o.projectId, IMPORTED_SCOPE_OWNER)),
      objectId: o.objectId ?? null,
    });
    const head = await this.head(record);
    const clean = validatePayload(o.typeId, o.payload);
    const provenance: Provenance = {
      runId: null,
      origin: "imported",
      recipeId: o.recipeId ?? null,
      recipeVersion: o.recipeVersion ?? null,
      sourceRefs: [...(o.sourceRefs ?? [])],
      extra: { ...(o.extra ?? {}), importKey: o.importKey },
    };
    const attributes = attributesFor(o.typeId, clean);
    if (
      head &&
      head.contentHash ===
        revisionContentHash({
          typeId: o.typeId,
          schemaVersion: getObjectType(o.typeId).schemaVersion,
          payload: clean,
          attributes,
          provenance,
        }) &&
      sameEmbedding(head.embeddingRefs, o.embeddingRefs)
    )
      return head;
    return this.append(record, {
      payload: clean,
      origin: "imported",
      expected: head ? head.id : null,
      actorId: null,
      reason: null,
      sourceRefs: o.sourceRefs ?? [],
      recipeId: o.recipeId ?? null,
      recipeVersion: o.recipeVersion ?? null,
      extra: { ...(o.extra ?? {}), importKey: o.importKey },
      revisionId: o.revisionId ?? null,
      embeddingRefs: o.embeddingRefs ?? null,
    });
  }

  /** A new authored revision carrying an older revision's wording; withdrawal state stays. */
  async rollback(o: {
    projectId: string;
    objectId: string;
    toRevisionId: string;
    expected: string;
    actorId: string;
    reason?: string | null;
    changeKind?: string | null;
  }): Promise<ObjectRevision> {
    const kind = checkChangeKind("rollback", o.changeKind, o.reason);
    const record = await this.record(o.projectId, o.objectId);
    const found = await this.store.getRevisions(o.projectId, [o.toRevisionId, o.expected]);
    const target = found.get(o.toRevisionId);
    if (!target || target.objectId !== o.objectId || target.status !== "published")
      throw new ReferenceViolation(
        `revision ${o.toRevisionId} is not a published revision of this object`,
      );
    const current = found.get(o.expected);
    const excluded = Boolean(current ? extraOf(current.provenance).membershipExcluded : false);
    return this.append(record, {
      payload: target.payload,
      origin: "authored",
      expected: o.expected,
      actorId: o.actorId,
      reason: o.reason ?? null,
      sourceRefs: target.provenance.sourceRefs ?? [],
      inputRevisionIds: target.provenance.inputRevisionIds ?? [],
      recipeId: target.provenance.recipeId ?? null,
      recipeVersion: target.provenance.recipeVersion ?? null,
      extra: { rollbackOf: o.toRevisionId, ...(excluded ? { membershipExcluded: true } : {}) },
      changeKind: kind,
    });
  }
}

export const newLineage = () => `authored:${newId()}`;
