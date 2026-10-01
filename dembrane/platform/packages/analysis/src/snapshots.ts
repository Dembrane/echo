import {
  extraOf,
  type Json,
  type ObjectRevision,
  type OutboxEvent,
  type Relation,
  type Snapshot,
  SnapshotConflict,
} from "./contracts";
import { contentHash, HASH_VERSION } from "./hashing";
import { compareStrings, sortedStrings } from "./registry";
import type { AnalysisStore } from "./store";
import { factCheckEligible, getObjectType } from "./types";

/**
 * View snapshots: the one immutable manifest every rendered or shared view reads.
 * Assembly resolves each producer's current ready output once, keeps one displayed
 * revision per object, keeps a relation only when both ends are displayed, pins the latest
 * assessment of each displayed fact-checkable revision, and records what is stale. The
 * view's current snapshot is the expected previous one, so an older assembly never
 * overwrites a newer view.
 */

export const SNAPSHOT_MANIFEST_VERSION = 1;
export const CONFLICT_RETRIES = 3;

export interface ProducerRef {
  readonly recipeId: string;
  readonly scopeKey: string;
}

export interface SnapshotRequest {
  readonly projectId: string;
  readonly viewId: string;
  readonly scopeKey: string;
  readonly producers: readonly ProducerRef[];
  readonly settings?: Json;
  readonly versions?: Json;
  readonly embeddingConfig?: Json | null;
  readonly createdBy?: string | null;
  /** The outbox event this assembly answers, recorded as its durable effect. */
  readonly sourceEventId?: string | null;
}

export interface SnapshotContents {
  readonly snapshot: Snapshot;
  readonly revisions: Map<string, ObjectRevision>;
  readonly relations: Map<string, Relation>;
  readonly assessments: Map<string, ObjectRevision>;
  /** Pinned ids that no longer resolve (source deletion): shown as missing. */
  readonly missing: readonly string[];
}

/** Current durable withdrawals, applied even to pinned audience views. */
export async function excludedObjectIds(
  store: AnalysisStore,
  projectId: string,
  scopeIds: readonly string[] | null = null,
): Promise<Set<string>> {
  const heads = await store.currentRevisions(projectId, scopeIds);
  return new Set(
    [...heads.entries()]
      .filter(([, r]) => extraOf(r.provenance).membershipExcluded)
      .map(([id]) => id),
  );
}

const byKey =
  <T>(key: (x: T) => string) =>
  (a: T, b: T) =>
    compareStrings(key(a), key(b));

export async function buildManifest(request: SnapshotRequest, store: AnalysisStore): Promise<Json> {
  const producers: Json[] = [];
  const candidates = new Map<string, Json[]>();
  const relationEntries = new Map<string, Json>();
  const pinnedInputs: [Json, string][] = [];
  const producerScopeIds: string[] = [];
  for (const ref of request.producers) {
    const scope = await store.findScope({
      projectId: request.projectId,
      kind: "producer",
      ownerId: ref.recipeId,
      scopeKey: ref.scopeKey,
    });
    const run = scope?.currentRunId ? await store.getRun(scope.currentRunId) : null;
    if (!scope || !run?.outputManifest || !Object.keys(run.outputManifest).length) {
      producers.push({
        recipeId: ref.recipeId,
        scopeKey: ref.scopeKey,
        runId: null,
        available: false,
      });
      continue;
    }
    const manifest = run.outputManifest;
    const entry: Json = {
      recipeId: ref.recipeId,
      scopeKey: ref.scopeKey,
      scopeId: scope.id,
      runId: run.id,
      recipeVersion: run.recipeVersion,
      manifestHash: manifest.contentHash ?? null,
      publicationSequence: manifest.publicationSequence ?? null,
      available: true,
    };
    producerScopeIds.push(scope.id);
    producers.push(entry);
    for (const obj of (manifest.objects as Json[] | undefined) ?? []) {
      const list = candidates.get(String(obj.objectId)) ?? [];
      list.push({ ...obj, producer: entry });
      candidates.set(String(obj.objectId), list);
    }
    for (const relation of (manifest.relations as Json[] | undefined) ?? [])
      relationEntries.set(String(relation.relationId), relation);
    for (const rid of ((manifest.inputs as Json | undefined)?.revisionIds as
      | unknown[]
      | undefined) ?? [])
      pinnedInputs.push([entry, String(rid)]);
  }

  const current = await store.currentRevisions(request.projectId, producerScopeIds);
  const wanted = new Set<string>();
  for (const group of candidates.values()) for (const o of group) wanted.add(String(o.revisionId));
  for (const r of relationEntries.values()) {
    wanted.add(String(r.from));
    wanted.add(String(r.to));
  }
  for (const [, rid] of pinnedInputs) wanted.add(rid);
  const revisions = await store.getRevisions(request.projectId, sortedStrings(wanted));

  const displayed = new Map<string, ObjectRevision>();
  for (const [objectId, group] of candidates) {
    const head = current.get(objectId);
    if (head && head.provenance.origin === "authored") {
      if (!extraOf(head.provenance).membershipExcluded) displayed.set(objectId, head);
      continue;
    }
    const options = group
      .map((o) => revisions.get(String(o.revisionId)))
      .filter((r): r is ObjectRevision => Boolean(r));
    // One displayed revision per identity: the newest (first maximum, as Python's max).
    let best: ObjectRevision | null = null;
    for (const r of options) if (!best || r.revisionNumber > best.revisionNumber) best = r;
    if (best) displayed.set(objectId, best);
  }
  // An authored head stays a member of its producer scope even when a later run no longer
  // emits that identity; exclusion is resolved here once.
  for (const [objectId, head] of current)
    if (
      head.provenance.origin === "authored" &&
      !extraOf(head.provenance).membershipExcluded &&
      !displayed.has(objectId)
    )
      displayed.set(objectId, head);
  const displayedIds = new Set([...displayed.values()].map((r) => r.id));

  const relations: Json[] = [];
  const stale: Json[] = [];
  const historical: Json[] = [];
  for (const relationId of sortedStrings(relationEntries.keys())) {
    const relation = relationEntries.get(relationId) as Json;
    const ends = [String(relation.from), String(relation.to)];
    if (ends.every((e) => displayedIds.has(e))) {
      relations.push({ relationId, type: relation.type, from: ends[0], to: ends[1] });
      continue;
    }
    const newer: [string, string][] = [];
    for (const end of ends) {
      const rev = revisions.get(end);
      if (rev && displayed.has(rev.objectId) && !displayedIds.has(end))
        newer.push([end, (displayed.get(rev.objectId) as ObjectRevision).id]);
    }
    if (newer.length)
      for (const [pinnedId, shownId] of newer)
        stale.push({
          kind: "relation",
          relationId,
          objectId: (revisions.get(pinnedId) as ObjectRevision).objectId,
          pinnedRevisionId: pinnedId,
          displayedRevisionId: shownId,
        });
    else historical.push({ relationId, reason: "endpoint_not_displayed" });
  }

  for (const [entry, rid] of pinnedInputs) {
    const revision = revisions.get(rid);
    if (!revision || !displayed.has(revision.objectId)) continue;
    const shown = displayed.get(revision.objectId) as ObjectRevision;
    if (shown.id !== rid)
      stale.push({
        kind: "output",
        recipeId: entry.recipeId,
        scopeKey: entry.scopeKey,
        runId: entry.runId,
        objectId: revision.objectId,
        pinnedRevisionId: rid,
        displayedRevisionId: shown.id,
      });
  }

  const checkable = [...displayed.values()]
    .filter((r) => factCheckEligible(r.type, r.payload, r.attributes))
    .map((r) => r.id);
  const found = await store.assessmentsFor(request.projectId, checkable);
  const assessments = sortedStrings(found.keys()).map((target) => {
    const assessment = found.get(target) as ObjectRevision;
    return {
      targetRevisionId: target,
      revisionId: assessment.id,
      relationId: extraOf(assessment.provenance).assessesRelationId ?? null,
    };
  });

  const configKey = request.embeddingConfig?.key;
  const vectors: Json[] = [];
  const unplaced: string[] = [];
  if (configKey) {
    for (const revision of [...displayed.values()].sort(byKey((r) => r.id))) {
      if (!getObjectType(revision.type).map) continue;
      const refs = revision.embeddingRefs ?? {};
      if (refs.configKey === configKey && refs.embeddingId)
        vectors.push({ revisionId: revision.id, embeddingId: refs.embeddingId });
      else unplaced.push(revision.id);
    }
  }

  const staleKey = (s: Json) => [
    String(s.kind),
    String(s.relationId || s.runId || ""),
    String(s.pinnedRevisionId),
  ];
  const body: Json = {
    version: SNAPSHOT_MANIFEST_VERSION,
    hashVersion: HASH_VERSION,
    view: { id: request.viewId, scopeKey: request.scopeKey },
    producers,
    objects: [...displayed.values()]
      .map((r) => ({ objectId: r.objectId, revisionId: r.id, type: r.type }))
      .sort(byKey((o) => o.objectId)),
    relations,
    assessments,
    stale: stale.sort((a, b) => {
      const x = staleKey(a);
      const y = staleKey(b);
      for (let i = 0; i < 3; i++) {
        const c = compareStrings(x[i] as string, y[i] as string);
        if (c) return c;
      }
      return 0;
    }),
    historicalRelations: historical,
    embeddingConfig: request.embeddingConfig ? { ...request.embeddingConfig } : null,
    settings: { ...(request.settings ?? {}) },
    versions: { ...(request.versions ?? {}) },
  };
  if (configKey) {
    body.vectors = vectors;
    body.unplaced = unplaced;
  }
  return { ...body, contentHash: contentHash(body) };
}

/** Builds and publishes a snapshot against the view's current one; SnapshotConflict when it moved. */
export async function assembleSnapshot(
  request: SnapshotRequest,
  store: AnalysisStore,
  expectedPrevious?: string | null,
): Promise<Snapshot> {
  const scope = await store.ensureScope({
    projectId: request.projectId,
    kind: "view",
    ownerId: request.viewId,
    scopeKey: request.scopeKey,
  });
  const expected = expectedPrevious === undefined ? scope.currentSnapshotId : expectedPrevious;
  const manifest = await buildManifest(request, store);
  return store.publishSnapshot(
    {
      projectId: request.projectId,
      scopeId: scope.id,
      viewId: request.viewId,
      manifest,
      contentHash: String(manifest.contentHash),
      manifestVersion: SNAPSHOT_MANIFEST_VERSION,
      settings: { ...(request.settings ?? {}) },
      versions: { ...(request.versions ?? {}) },
      embeddingConfig: request.embeddingConfig ? { ...request.embeddingConfig } : null,
      createdBy: request.createdBy ?? null,
      sourceEventId: request.sourceEventId ?? null,
    },
    expected,
  );
}

/** A pinned snapshot by id, or a view's current snapshot; null when not this project's. */
export async function resolveSnapshot(
  store: AnalysisStore,
  o: {
    projectId: string;
    snapshotId?: string | null;
    viewId?: string | null;
    scopeKey?: string | null;
  },
): Promise<Snapshot | null> {
  if (o.snapshotId) {
    const snapshot = await store.getSnapshot(o.snapshotId);
    return snapshot && snapshot.projectId === o.projectId ? snapshot : null;
  }
  if (!(o.viewId && o.scopeKey)) return null;
  const scope = await store.findScope({
    projectId: o.projectId,
    kind: "view",
    ownerId: o.viewId,
    scopeKey: o.scopeKey,
  });
  if (!scope?.currentSnapshotId) return null;
  return store.getSnapshot(scope.currentSnapshotId);
}

/** Exactly what a snapshot pins, whatever has been published since. */
export async function readSnapshot(
  snapshot: Snapshot,
  store: AnalysisStore,
): Promise<SnapshotContents> {
  const m = snapshot.manifest;
  const objects = (m.objects as Json[] | undefined) ?? [];
  const assessmentEntries = (m.assessments as Json[] | undefined) ?? [];
  const revisionIds = objects.map((o) => String(o.revisionId));
  const assessmentIds = assessmentEntries.map((a) => String(a.revisionId));
  const relationIds = [
    ...((m.relations as Json[] | undefined) ?? []).map((r) => String(r.relationId)),
    ...assessmentEntries.filter((a) => a.relationId).map((a) => String(a.relationId)),
  ];
  const revisions = await store.getRevisions(snapshot.projectId, [
    ...revisionIds,
    ...assessmentIds,
  ]);
  const relations = await store.getRelations(snapshot.projectId, relationIds);
  const assessments = new Map<string, ObjectRevision>();
  for (const a of assessmentEntries) {
    const r = revisions.get(String(a.revisionId));
    if (r) assessments.set(String(a.targetRevisionId), r);
  }
  const missing = sortedStrings(
    new Set([
      ...[...revisionIds, ...assessmentIds].filter((id) => !revisions.has(id)),
      ...relationIds.filter((id) => !relations.has(id)),
    ]),
  );
  return {
    snapshot,
    revisions: new Map(
      revisionIds
        .filter((id) => revisions.has(id))
        .map((id) => [id, revisions.get(id) as ObjectRevision]),
    ),
    relations: new Map(
      relationIds
        .filter((id) => relations.has(id))
        .map((id) => [id, relations.get(id) as Relation]),
    ),
    assessments,
    missing,
  };
}

export type SnapshotHook = (event: OutboxEvent, store: AnalysisStore) => Promise<void>;

/**
 * An outbox hook for a view that follows its producers: every publication of one of
 * `recipeIds` assembles a successor snapshot recording the event as its source, and
 * reassembles when another assembly advanced the view first.
 */
export function followingViewHook(
  recipeIds: ReadonlySet<string>,
  buildRequest: (event: OutboxEvent) => SnapshotRequest | null,
): SnapshotHook {
  return async (event, store) => {
    if (event.eventType !== "run_published" && event.eventType !== "revision_published") return;
    if (!recipeIds.has(String(event.payload.recipeId))) return;
    const built = buildRequest(event);
    if (!built) return;
    const request = { ...built, sourceEventId: event.id };
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
      try {
        await assembleSnapshot(request, store);
        return;
      } catch (err) {
        if (!(err instanceof SnapshotConflict) || attempt === CONFLICT_RETRIES - 1) throw err;
      }
    }
  };
}
