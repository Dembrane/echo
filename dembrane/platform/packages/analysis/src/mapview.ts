import { newId } from "@dembrane/core";
import { budgetsPayload, type ResolvedBudgets } from "./budgets";
import {
  extraOf,
  type Json,
  type ObjectRevision,
  type OutboxEvent,
  type Snapshot,
  SnapshotConflict,
} from "./contracts";
import { count, isUuid, J, one, pyIso, q, transaction } from "./db";
import { inputHash } from "./embeddings";
import { contentHash } from "./hashing";
import { claimKey } from "./maprecipe";
import { compareStrings, getRecipe, sortedStrings, UnknownRecipe } from "./registry";
import { buildManifest, type ProducerRef, SNAPSHOT_MANIFEST_VERSION } from "./snapshots";
import type { AnalysisStore } from "./store";
import { getObjectType, MAP_TYPE_IDS } from "./types";

/**
 * The project map as an analysis view: snapshot assembly and the v2 graph payload. The
 * map view (`map`, scope `project`) pins in one immutable snapshot the current ready
 * output of every registered producer of a map type, the latest assessment of each
 * displayed fact-checkable revision and one embedding configuration. A project without a
 * ready arguments output shows its newest imported legacy result instead.
 *
 * Reads advance the view when it is behind its producers (needsAdvance), exactly as the
 * Python did, so a following view catches up even where the outbox hook did not run.
 */

export const MAP_VIEW_ID = "map";
export const LEGACY_VIEW_ID = "map.legacy";
export const VIEW_SCOPE_KEY = "project";
export const PAYLOAD_VERSION = 2;
export const MAP_TYPES = MAP_TYPE_IDS;
export const ARGUMENT_TYPES = new Set(["argument", "deduplicated_argument"]);
export const ARGUMENTS_RECIPE_ID = "arguments";
export const LEGACY_RECIPE_ID = "map.legacy_arguments";
export const ADVANCE_RETRIES = 3;
export const V2_RESULT_RECIPE_VERSION = "map-view-v2";

export class UnknownMapType extends Error {}
export class UnknownResultScope extends Error {}

export const isV2Manifest = (m: unknown) =>
  !!m &&
  typeof m === "object" &&
  !Array.isArray(m) &&
  (m as Json).version === PAYLOAD_VERSION &&
  Boolean((m as Json).snapshotId);

// ── reads the lifecycle store does not offer ────────────────────────────

export interface ProducerHead {
  readonly recipeId: string;
  readonly scopeKey: string;
  readonly scopeId: string;
  readonly runId: string;
}

export interface ResultLink {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly manifestVersion: number;
  readonly snapshotId: string | null;
  readonly recipeVersion: string | null;
  readonly embeddingConfig: Json | null;
  readonly createdAt: string | null;
  readonly completedAt: string | null;
}

const LINK_COLUMNS =
  "id::text AS id, project_id::text AS project_id, status, manifest_version, snapshot_id::text AS snapshot_id, recipe_version, embedding_config, created_at, completed_at";

const link = (r: Json): ResultLink => ({
  id: String(r.id),
  projectId: String(r.project_id),
  status: String(r.status),
  manifestVersion: Number(r.manifest_version || 1),
  snapshotId: (r.snapshot_id as string | null) ?? null,
  recipeVersion: (r.recipe_version as string | null) ?? null,
  embeddingConfig: (r.embedding_config as Json | null) ?? null,
  createdAt: (r.created_at as string | null) ?? null,
  completedAt: (r.completed_at as string | null) ?? null,
});

export class MapViewReads {
  constructor(readonly store: AnalysisStore) {}

  private get sql() {
    return this.store.sql;
  }

  async producerHeads(projectId: string): Promise<ProducerHead[]> {
    const rows = await q(
      this.sql,
      `SELECT recipe_id, scope_key, id::text AS scope_id, current_run_id::text AS run_id
         FROM analysis_scope
        WHERE project_id = $1 AND kind = 'producer' AND current_run_id IS NOT NULL
        ORDER BY recipe_id, scope_key`,
      [projectId],
    );
    return rows.map((r) => ({
      recipeId: String(r.recipe_id),
      scopeKey: String(r.scope_key),
      scopeId: String(r.scope_id),
      runId: String(r.run_id),
    }));
  }

  async embeddingIdentity(projectId: string, configKey: string): Promise<[string, number] | null> {
    const row = await one(
      this.sql,
      "SELECT model, dims FROM map_embedding WHERE project_id = $1 AND config_key = $2 LIMIT 1",
      [projectId, configKey],
    );
    return row ? [String(row.model), Number(row.dims)] : null;
  }

  async resultLink(resultId: string): Promise<ResultLink | null> {
    if (!isUuid(resultId)) return null;
    const row = await one(this.sql, `SELECT ${LINK_COLUMNS} FROM map_result WHERE id = $1`, [
      resultId,
    ]);
    return row ? link(row) : null;
  }

  /** Ready v1 results, oldest first (of one project, or of every project). */
  async legacyResults(projectId: string | null): Promise<ResultLink[]> {
    const rows = projectId
      ? await q(
          this.sql,
          `SELECT ${LINK_COLUMNS} FROM map_result WHERE status = 'ready' AND manifest_version = 1 AND project_id = $1 ORDER BY project_id, created_at, id`,
          [projectId],
        )
      : await q(
          this.sql,
          `SELECT ${LINK_COLUMNS} FROM map_result WHERE status = 'ready' AND manifest_version = 1 ORDER BY project_id, created_at, id`,
        );
    return rows.map(link);
  }

  /** The v2 row of a map snapshot, written once per snapshot. */
  async ensureV2Result(snapshot: Snapshot): Promise<string> {
    return transaction(this.sql, async (tx) => {
      await q(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `map_result:${snapshot.id}`,
      ]);
      const existing = await one(
        tx,
        "SELECT id::text AS id FROM map_result WHERE snapshot_id = $1 AND manifest_version = 2 LIMIT 1",
        [snapshot.id],
      );
      if (existing) return String(existing.id);
      const resultId = newId();
      await q(
        tx,
        `INSERT INTO map_result
                (id, project_id, status, recipe_version, embedding_config, progress, manifest,
                 requested_by, manifest_version, snapshot_id, created_at, updated_at, completed_at)
         VALUES ($1, $2, 'ready', $3, $4, $5, $6, $7, 2, $8, now(), now(), now())`,
        [
          resultId,
          snapshot.projectId,
          V2_RESULT_RECIPE_VERSION,
          J(
            snapshot.embeddingConfig && Object.keys(snapshot.embeddingConfig).length
              ? snapshot.embeddingConfig
              : null,
          ),
          J({ stage: "ready" }),
          J({ version: PAYLOAD_VERSION, snapshotId: snapshot.id }),
          snapshot.createdBy,
          snapshot.id,
        ],
      );
      return resultId;
    });
  }

  async linkLegacySnapshot(resultId: string, snapshotId: string): Promise<boolean> {
    return (
      (await count(
        this.sql,
        `UPDATE map_result SET snapshot_id = $1, updated_at = now()
          WHERE id = $2 AND manifest_version = 1 AND snapshot_id IS DISTINCT FROM $1::uuid`,
        [snapshotId, resultId],
      )) === 1
    );
  }

  async revisionHistory(projectId: string, objectId: string): Promise<string[]> {
    if (!isUuid(objectId)) return [];
    const rows = await q(
      this.sql,
      `SELECT id::text AS id FROM analysis_object_revision
        WHERE project_id = $1 AND object_id = $2 AND status = 'published'
        ORDER BY revision_number`,
      [projectId, objectId],
    );
    return rows.map((r) => String(r.id));
  }
}

// ── projections ─────────────────────────────────────────────────────────

function quotesAsEvidence(quotes: unknown[]): Json[] {
  const grouped = new Map<string, string[]>();
  for (const quote of quotes) {
    if (
      quote &&
      typeof quote === "object" &&
      (quote as Json).conversationId &&
      (quote as Json).text
    ) {
      const cid = String((quote as Json).conversationId);
      const list = grouped.get(cid) ?? [];
      list.push(String((quote as Json).text));
      grouped.set(cid, list);
    }
  }
  return [...grouped.entries()].map(([conversationId, texts]) => ({
    conversationId,
    quotes: texts,
  }));
}

/** A fact-checkable revision's statement, evidence quotes and claim key (Map's key). */
export function claimOf(revision: ObjectRevision): [string, string[], string] | null {
  const definition = getObjectType(revision.type);
  if (!definition.factCheck?.eligible(revision.payload, revision.attributes)) return null;
  const statement = definition.factCheck.statement(revision.payload);
  const quotes = ((revision.payload.evidence as Json[] | undefined) ?? []).flatMap((item) =>
    ((item.quotes as unknown[] | undefined) ?? []).map(String),
  );
  return [statement, quotes, claimKey(statement, quotes)];
}

export function projectDetail(revision: ObjectRevision): Json {
  const capability = getObjectType(revision.type).map;
  const detail: Json = capability ? { ...capability.detail(revision.payload) } : {};
  // Consolidation shown by Map is rebuilt from pinned lineage; payload metadata alone never badges a merge.
  if (revision.type === "deduplicated_argument") delete detail.consolidation;
  if (!("evidence" in detail) && Array.isArray(detail.quotes))
    detail.evidence = quotesAsEvidence(detail.quotes);
  const created = ((revision.payload.evidence as Json[] | undefined) ?? [])
    .filter((e) => e.createdAt)
    .map((e) => String(e.createdAt));
  if (created.length)
    detail.createdAt = created.reduce((a, b) => (compareStrings(a, b) >= 0 ? a : b));
  const claim = claimOf(revision);
  if (claim) detail.claimKey = claim[2];
  return detail;
}

export function labelOf(revision: ObjectRevision): string {
  const capability = getObjectType(revision.type).map;
  return capability ? capability.label(revision.payload) : revision.type;
}

export function provenanceDoc(revision: ObjectRevision): Json {
  const p = revision.provenance;
  const doc: Json = {
    runId: p.runId || String(extraOf(p).legacyResultId || ""),
    origin: p.origin,
  };
  if (p.recipeId) doc.recipeId = p.recipeId;
  if (p.recipeVersion) doc.recipeVersion = p.recipeVersion;
  return doc;
}

/** round(value, 6) as Python rounds a float for JSON. */
export const round6 = (v: number) => Number(v.toFixed(6));

export function nodeDoc(
  revision: ObjectRevision,
  vector: number[] | null,
  assessmentId: string | null,
  consolidationIn: Json | null = null,
): Json {
  let consolidation = consolidationIn;
  const claim = claimOf(revision);
  const factCheck: Json = { eligible: claim !== null };
  if (claim) factCheck.claimKey = claim[2];
  if (assessmentId) factCheck.assessmentRevisionId = assessmentId;
  const detail = projectDetail(revision);
  if (!consolidation && revision.provenance.recipeId === LEGACY_RECIPE_ID) {
    const ids = new Set(
      ((extraOf(revision.provenance).legacyCandidateIds as unknown[] | undefined) ?? [])
        .map(String)
        .filter(Boolean),
    );
    if (ids.size > 1) consolidation = { memberCount: ids.size, members: [], legacy: true };
  }
  if (consolidation) detail.consolidation = consolidation;
  return {
    objectId: revision.objectId,
    revisionId: revision.id,
    type: revision.type,
    label: labelOf(revision),
    detail,
    attributes: Object.fromEntries(
      ["valence", "epistemicKind"]
        .filter((k) => revision.attributes[k])
        .map((k) => [k, revision.attributes[k]]),
    ),
    factCheck,
    provenance: provenanceDoc(revision),
    embedding: vector ? vector.map(round6) : null,
  };
}

const usable = (vector: number[] | null | undefined, dims: number) =>
  !!vector && vector.length > 0 && (!dims || vector.length === dims) && vector.some((v) => v !== 0);

/**
 * Vectors by revision id in exactly one embedding configuration: a reference to this
 * configuration and projection is read by id; anything else is looked up by its
 * projection text's hash within the configuration. Nothing is embedded here.
 */
export async function loadVectors(
  projectId: string,
  revisions: Iterable<ObjectRevision>,
  config: Json | null,
  store: AnalysisStore,
): Promise<Map<string, number[]>> {
  if (!config?.key) return new Map();
  const key = String(config.key);
  const dims = Number(config.dims || 0);
  const byReference = new Map<string, string>();
  const byText = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const revision of revisions) {
    const capability = getObjectType(revision.type).map;
    if (!capability) continue;
    texts.set(revision.id, inputHash(capability.embeddingText(revision.payload)));
    const ref = revision.embeddingRefs ?? {};
    if (
      ref.embeddingId &&
      ref.configKey === key &&
      (ref.projectionVersion === undefined ||
        ref.projectionVersion === null ||
        ref.projectionVersion === capability.projectionVersion)
    )
      byReference.set(revision.id, String(ref.embeddingId));
    else byText.set(revision.id, texts.get(revision.id) as string);
  }
  const out = new Map<string, number[]>();
  if (byReference.size) {
    const loaded = await store.vectorsByIds(
      projectId,
      sortedStrings(new Set(byReference.values())),
    );
    for (const [revisionId, embeddingId] of byReference) {
      const vector = loaded.get(embeddingId);
      if (vector === undefined) byText.set(revisionId, texts.get(revisionId) as string);
      else out.set(revisionId, vector);
    }
  }
  if (byText.size) {
    const stored = await store.loadEmbeddings(
      projectId,
      key,
      sortedStrings(new Set(byText.values())),
    );
    for (const [revisionId, hashed] of byText) {
      const hit = stored.get(hashed);
      if (hit) out.set(revisionId, hit[1]);
    }
  }
  return new Map([...out.entries()].filter(([, v]) => usable(v, dims)));
}

// ── the graph payload ───────────────────────────────────────────────────

export interface GraphQuery {
  /** null: the server chooses. Empty: no types selected. */
  readonly types: readonly string[] | null;
  readonly scope: string | null;
  readonly budgets: ResolvedBudgets;
}

export function parseTypes(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const names = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const unknown = sortedStrings(new Set(names.filter((n) => !MAP_TYPES.includes(n))));
  if (unknown.length) throw new UnknownMapType(`unknown object types: ${unknown.join(", ")}`);
  return MAP_TYPES.filter((t) => names.includes(t));
}

export const zeroCounts = (): Record<string, number> =>
  Object.fromEntries(MAP_TYPES.map((t) => [t, 0]));

function producerNames(producer: Json): Set<string> {
  const names = new Set([String(producer.recipeId), `${producer.recipeId}@${producer.scopeKey}`]);
  if (producer.runId) names.add(`run:${producer.runId}`);
  return names;
}

/** The objects of one producer output in this snapshot. */
export async function scopeObjectIds(
  snapshot: Snapshot,
  scope: string,
  store: AnalysisStore,
): Promise<Set<string>> {
  for (const producer of (snapshot.manifest.producers as Json[] | undefined) ?? []) {
    if (!producer.available || !producerNames(producer).has(scope)) continue;
    if (!producer.runId)
      return new Set(((producer.objectIds as unknown[] | undefined) ?? []).map(String));
    const run = await store.getRun(String(producer.runId));
    return new Set(
      ((run?.outputManifest?.objects as Json[] | undefined) ?? []).map((o) => String(o.objectId)),
    );
  }
  throw new UnknownResultScope(`this map has no output named '${scope}'`);
}

function budgetState(
  counts: Record<string, number>,
  query: GraphQuery,
  fallback: string[] | null,
): [string[], boolean] {
  const selected = query.types !== null ? [...query.types] : (fallback ?? ["argument"]);
  const total = selected.reduce((n, t) => n + (counts[t] ?? 0), 0);
  return [selected, total > query.budgets.budgets.nodeLimit];
}

function derivedMembers(manifest: Json, outputIds: Set<string>): Map<string, string[]> {
  const members = new Map<string, string[]>();
  for (const relation of (manifest.relations as Json[] | undefined) ?? []) {
    const owner = String(relation.from || "");
    const member = String(relation.to || "");
    if (relation.type === "derived_from" && outputIds.has(owner) && member) {
      const list = members.get(owner) ?? [];
      list.push(member);
      members.set(owner, list);
    }
  }
  return members;
}

/** Prefer a deduplication output only when it partitions exactly the pinned originals. */
async function defaultArgumentEntries(
  snapshot: Snapshot,
  entries: Json[],
  store: AnalysisStore,
): Promise<[string[], Json[], Map<string, string[]>]> {
  const originals = entries.filter((e) => e.type === "argument");
  const originalIds = new Set(originals.map((e) => String(e.revisionId)));
  const consolidated = entries.filter((e) => e.type === "deduplicated_argument");
  const consolidatedIds = new Set(consolidated.map((e) => String(e.revisionId)));
  if (!originals.length || !consolidated.length) return [["argument"], originals, new Map()];
  const producers = ((snapshot.manifest.producers as Json[] | undefined) ?? []).filter(
    (p) => p.available && p.recipeId === "deduplicated_arguments" && p.runId,
  );
  const sameSet = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));
  for (const producer of [...producers].reverse()) {
    const run = await store.getRun(String(producer.runId));
    const manifest = run?.outputManifest ?? {};
    const outputs = new Set(
      ((manifest.objects as Json[] | undefined) ?? [])
        .filter((i) => i.type === "deduplicated_argument")
        .map((i) => String(i.revisionId)),
    );
    const pinned = new Set(
      (((manifest.inputs as Json | undefined)?.revisionIds as unknown[]) ?? []).map(String),
    );
    const members = derivedMembers(manifest, outputs);
    const flattened = [...outputs].flatMap((o) => members.get(o) ?? []);
    if (
      sameSet(outputs, consolidatedIds) &&
      sameSet(pinned, originalIds) &&
      sameSet(new Set(flattened), originalIds) &&
      flattened.length === originalIds.size &&
      [...outputs].every((o) => (members.get(o) ?? []).length)
    )
      return [["deduplicated_argument"], consolidated, members];
  }
  return [["argument"], originals, new Map()];
}

/** Member details backed by pinned provenance and published lineage. */
async function verifiedConsolidations(
  snapshot: Snapshot,
  revisions: Map<string, ObjectRevision>,
  membersByOutput: Map<string, string[]>,
  store: AnalysisStore,
): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  if (!membersByOutput.size) return out;
  const relationEntries = new Map<string, string>();
  for (const item of (snapshot.manifest.relations as Json[] | undefined) ?? [])
    if (item.type === "derived_from")
      relationEntries.set(`${item.from}|${item.to}`, String(item.relationId));
  const relationIds: string[] = [];
  for (const [owner, memberIds] of membersByOutput)
    for (const member of memberIds) {
      const id = relationEntries.get(`${owner}|${member}`);
      if (id) relationIds.push(id);
    }
  const relations = relationIds.length
    ? await store.getRelations(snapshot.projectId, relationIds)
    : new Map();
  const memberIds = sortedStrings(new Set([...membersByOutput.values()].flat()));
  const memberRevisions = memberIds.length
    ? await store.getRevisions(snapshot.projectId, memberIds)
    : new Map();
  for (const [owner, ownerMembers] of membersByOutput) {
    const revision = revisions.get(owner);
    if (revision?.type !== "deduplicated_argument") continue;
    const inputs = revision.provenance.inputRevisionIds ?? [];
    const set = new Set(inputs);
    if (
      set.size !== new Set(ownerMembers).size ||
      ![...set].every((x) => ownerMembers.includes(x)) ||
      inputs.length !== ownerMembers.length
    )
      continue;
    let valid = true;
    const members: ObjectRevision[] = [];
    for (const memberId of inputs) {
      const member = memberRevisions.get(memberId);
      const relation = relations.get(relationEntries.get(`${owner}|${memberId}`) ?? "");
      if (
        member?.type !== "argument" ||
        member.projectId !== snapshot.projectId ||
        !relation ||
        relation.type !== "derived_from" ||
        relation.status !== "published" ||
        relation.fromRevisionId !== owner ||
        relation.toRevisionId !== memberId
      ) {
        valid = false;
        break;
      }
      members.push(member);
    }
    if (!valid) continue;
    const unique = new Map<string, ObjectRevision>();
    for (const m of members) if (!unique.has(m.objectId)) unique.set(m.objectId, m);
    if (unique.size <= 1) continue;
    const details = [...unique.values()].map((m) => {
      const item: Json = {
        objectId: m.objectId,
        revisionId: m.id,
        statement: String(m.payload.statement),
      };
      const evidence = (m.payload.evidence as unknown[] | undefined) ?? [];
      if (evidence.length) item.evidence = evidence;
      return item;
    });
    out.set(owner, { memberCount: unique.size, members: details });
  }
  return out;
}

const embeddingDoc = (config: Json | null | undefined): Json => ({
  key: String(config?.key || ""),
  model: String(config?.model || ""),
  dims: Number(config?.dims || 0),
});

/** The snapshot's stale entries, each naming the displayed revision whose freshness it affects. */
async function staleRefs(snapshot: Snapshot, store: AnalysisStore): Promise<Json[]> {
  const manifest = snapshot.manifest;
  const entries = [...((manifest.stale as Json[] | undefined) ?? [])];
  if (!entries.length) return [];
  const objects = (manifest.objects as Json[] | undefined) ?? [];
  const displayed = new Set(objects.map((o) => String(o.revisionId)));
  const byObject = new Map(objects.map((o) => [String(o.objectId), String(o.revisionId)]));
  const relationIds = entries
    .filter((e) => e.kind === "relation" && e.relationId)
    .map((e) => String(e.relationId));
  const relations = relationIds.length
    ? await store.getRelations(snapshot.projectId, relationIds)
    : new Map();
  const out: Json[] = [];
  for (const entry of entries) {
    const base = { ...entry, reason: "based_on_earlier_revision" };
    if (entry.kind === "relation") {
      const relation = relations.get(String(entry.relationId));
      const ends = relation ? [relation.fromRevisionId, relation.toRevisionId] : [];
      const dependents = ends.filter(
        (e: string) => e !== entry.pinnedRevisionId && displayed.has(e),
      );
      out.push({ ...base, revisionId: dependents[0] ?? entry.displayedRevisionId ?? null });
      continue;
    }
    const run = entry.runId ? await store.getRun(String(entry.runId)) : null;
    const outputs = ((run?.outputManifest?.objects as Json[] | undefined) ?? [])
      .filter((o) => byObject.has(String(o.objectId)))
      .map((o) => byObject.get(String(o.objectId)) as string);
    for (const revisionId of outputs.length ? outputs : [entry.displayedRevisionId])
      out.push({ ...base, revisionId });
  }
  return out;
}

export async function graphPayload(
  snapshot: Snapshot,
  query: GraphQuery,
  store: AnalysisStore,
  resultId: string | null = null,
): Promise<Json> {
  const manifest = snapshot.manifest;
  let entries = ((manifest.objects as Json[] | undefined) ?? []).filter((o) =>
    MAP_TYPES.includes(String(o.type)),
  );
  if (query.scope) {
    const members = await scopeObjectIds(snapshot, query.scope, store);
    entries = entries.filter((o) => members.has(String(o.objectId)));
  }
  const counts = zeroCounts();
  for (const e of entries) counts[String(e.type)] = (counts[String(e.type)] ?? 0) + 1;
  let chosen: Json[] | null = null;
  let membersByOutput = new Map<string, string[]>();
  let fallback: string[] | null = null;
  if (query.types === null && query.scope === null) {
    [fallback, chosen, membersByOutput] = await defaultArgumentEntries(snapshot, entries, store);
  } else if (query.types === null) {
    fallback = MAP_TYPES.filter((t) => counts[t]);
  }
  const [selected, overBudget] = budgetState(counts, query, fallback);
  const config =
    snapshot.embeddingConfig ?? (manifest.embeddingConfig as Json | null | undefined) ?? null;
  const snapshotDoc: Json = {
    id: snapshot.id,
    createdAt: pyIso(snapshot.createdAt),
    parentId: snapshot.parentSnapshotId,
    stale: await staleRefs(snapshot, store),
  };
  if (resultId) snapshotDoc.resultId = resultId;
  const payload: Json = {
    version: PAYLOAD_VERSION,
    snapshot: snapshotDoc,
    budgets: budgetsPayload(query.budgets),
    counts,
    scope: { types: selected, ...(query.scope ? { resultScope: query.scope } : {}) },
    overBudget,
    embedding: embeddingDoc(config),
    nodes: [],
    relations: [],
    unplaced: [],
    related: [],
  };
  // Counts only: no revision, relation or vector is read for an oversized scope.
  if (overBudget) return payload;

  if (chosen === null) chosen = entries.filter((o) => selected.includes(String(o.type)));
  if (!membersByOutput.size && selected.includes("deduplicated_argument"))
    membersByOutput = derivedMembers(
      manifest,
      new Set(
        chosen.filter((e) => e.type === "deduplicated_argument").map((e) => String(e.revisionId)),
      ),
    );
  const chosenIds = chosen.map((o) => String(o.revisionId));
  const revisions = await store.getRevisions(snapshot.projectId, chosenIds);
  const vectors = await loadVectors(snapshot.projectId, revisions.values(), config, store);
  const consolidations = await verifiedConsolidations(snapshot, revisions, membersByOutput, store);
  const assessments = new Map(
    ((manifest.assessments as Json[] | undefined) ?? []).map((a) => [
      String(a.targetRevisionId),
      String(a.revisionId),
    ]),
  );
  const nodes: Json[] = [];
  for (const id of chosenIds) {
    const revision = revisions.get(id);
    if (!revision) continue;
    nodes.push(
      nodeDoc(
        revision,
        vectors.get(id) ?? null,
        assessments.get(id) ?? null,
        consolidations.get(id) ?? null,
      ),
    );
  }
  const shown = new Set(nodes.map((n) => String(n.revisionId)));
  payload.nodes = nodes;
  payload.unplaced = nodes.filter((n) => n.embedding === null).map((n) => n.revisionId);
  const snapshotRelations = (manifest.relations as Json[] | undefined) ?? [];
  const drawn = snapshotRelations.filter(
    (r) => shown.has(String(r.from)) && shown.has(String(r.to)),
  );
  const rows = drawn.length
    ? await store.getRelations(
        snapshot.projectId,
        drawn.map((r) => String(r.relationId)),
      )
    : new Map();
  payload.relations = drawn.map((r) => ({
    id: String(r.relationId),
    type: r.type,
    from: String(r.from),
    to: String(r.to),
    basis: rows.get(String(r.relationId))?.basis ?? "inferred",
  }));
  const inSnapshot = new Set(
    ((manifest.objects as Json[] | undefined) ?? [])
      .filter((o) => MAP_TYPES.includes(String(o.type)))
      .map((o) => String(o.revisionId)),
  );
  const outside = new Set<string>();
  for (const r of snapshotRelations)
    for (const [end, other] of [
      ["from", "to"],
      ["to", "from"],
    ] as const)
      if (
        shown.has(String(r[other])) &&
        !shown.has(String(r[end])) &&
        inSnapshot.has(String(r[end]))
      )
        outside.add(String(r[end]));
  if (outside.size) {
    const ordered = sortedStrings(outside);
    const related = await store.getRevisions(snapshot.projectId, ordered);
    payload.related = ordered
      .filter((id) => related.has(id))
      .map((id) => {
        const r = related.get(id) as ObjectRevision;
        return { objectId: r.objectId, revisionId: r.id, type: r.type, label: labelOf(r) };
      });
  }
  return payload;
}

/** A v1 node in the v2 node shape; its node id stays what the v1 routes use. */
export function legacyNode(argument: Json, row: Json, vector: number[] | null): Json {
  const evidence = ((argument.evidence as Json[] | undefined) ?? []).map((item) => ({
    conversationId: item.conversation_id ?? null,
    label: item.label ?? null,
    createdAt: item.created_at ?? null,
    quotes: (item.quotes as unknown[] | undefined) ?? [],
  }));
  const detail: Json = {
    statement: argument.statement,
    epistemicKind: argument.kind,
    valence: argument.valence ?? null,
    evidence,
  };
  if (argument.created_at) detail.createdAt = argument.created_at;
  const candidates = new Set(
    ((argument.candidate_ids as unknown[] | undefined) ?? []).map(String).filter(Boolean),
  );
  if (candidates.size > 1)
    detail.consolidation = { memberCount: candidates.size, members: [], legacy: true };
  const factCheck: Json = { eligible: argument.kind === "claim" };
  if (argument.claim_key) {
    detail.claimKey = argument.claim_key;
    factCheck.claimKey = argument.claim_key;
  }
  const provenance: Json = { runId: row.id, origin: "imported", recipeId: LEGACY_RECIPE_ID };
  if (row.recipe_version) provenance.recipeVersion = row.recipe_version;
  return {
    objectId: argument.id,
    revisionId: argument.id,
    type: "argument",
    label: argument.statement,
    detail,
    attributes: Object.fromEntries(
      (
        [
          ["valence", argument.valence],
          ["epistemicKind", argument.kind],
        ] as const
      ).filter(([, v]) => v),
    ),
    factCheck,
    provenance,
    embedding: vector ? vector.map(round6) : null,
  };
}

/** A ready v1 result not yet imported, in the v2 shape; `vectorsByIds` reads map_embedding. */
export async function legacyGraphPayload(
  row: Json,
  query: GraphQuery,
  store: AnalysisStore,
): Promise<Json> {
  if (query.scope) throw new UnknownResultScope(`this map has no output named '${query.scope}'`);
  const args = ((row.manifest as Json | undefined)?.arguments as Json[] | undefined) ?? [];
  const counts = zeroCounts();
  counts.argument = args.length;
  const [selected, overBudget] = budgetState(counts, query, null);
  const payload: Json = {
    version: PAYLOAD_VERSION,
    snapshot: {
      id: row.id,
      createdAt: pyIso(row.completed_at as string | null),
      parentId: null,
      stale: [],
      resultId: row.id,
      legacy: true,
    },
    budgets: budgetsPayload(query.budgets),
    counts,
    scope: { types: selected },
    overBudget,
    embedding: embeddingDoc(row.embedding_config as Json | null),
    nodes: [],
    relations: [],
    unplaced: [],
    related: [],
  };
  if (overBudget || !selected.includes("argument")) return payload;
  const vectors = await store.vectorsByIds(
    String(row.project_id),
    args.filter((a) => a.embedding_id).map((a) => String(a.embedding_id)),
  );
  const dims = Number((row.embedding_config as Json | null)?.dims || 0);
  const nodes = args.map((a) => {
    const v = vectors.get(String(a.embedding_id || "")) ?? null;
    return legacyNode(a, row, usable(v, dims) ? v : null);
  });
  payload.nodes = nodes;
  payload.unplaced = nodes.filter((n) => n.embedding === null).map((n) => n.revisionId);
  return payload;
}

// ── assembly and advancement ────────────────────────────────────────────

/**
 * Resolved: producer scopes with a ready output whose registered recipe makes a map type.
 * Carried: entries the parent pinned for recipes this process does not know, while their
 * scope still has a ready output, so a rolling deploy never drops a producer.
 */
async function resolveProducers(
  projectId: string,
  reads: MapViewReads,
  parent: Snapshot | null,
): Promise<[ProducerHead[], Json[]]> {
  const known: ProducerHead[] = [];
  const unknown = new Set<string>();
  for (const head of await reads.producerHeads(projectId)) {
    let outputs: readonly string[];
    try {
      outputs = getRecipe(head.recipeId).outputTypes;
    } catch (err) {
      if (!(err instanceof UnknownRecipe)) throw err;
      unknown.add(`${head.recipeId}|${head.scopeKey}`);
      continue;
    }
    if (outputs.some((t) => MAP_TYPES.includes(t))) known.push(head);
  }
  const carried = ((parent?.manifest.producers as Json[] | undefined) ?? []).filter(
    (e) => e.available && e.runId && unknown.has(`${e.recipeId}|${e.scopeKey}`),
  );
  return [known, carried];
}

export async function mapProducers(
  projectId: string,
  reads: MapViewReads,
): Promise<ProducerHead[]> {
  return (await resolveProducers(projectId, reads, null))[0];
}

async function carryOver(
  body: Json,
  carried: Json[],
  parent: Snapshot,
  store: AnalysisStore,
): Promise<Json> {
  const parentObjects = new Map(
    ((parent.manifest.objects as Json[] | undefined) ?? []).map((o) => [String(o.objectId), o]),
  );
  const shown = new Set(((body.objects as Json[]) ?? []).map((o) => String(o.objectId)));
  const entries: Json[] = [];
  const kept: Json[] = [];
  for (const producer of carried) {
    const run = await store.getRun(String(producer.runId));
    const objects = ((run?.outputManifest?.objects as Json[] | undefined) ?? [])
      .filter((o) => parentObjects.has(String(o.objectId)) && !shown.has(String(o.objectId)))
      .map((o) => parentObjects.get(String(o.objectId)) as Json);
    if (!objects.length) continue;
    entries.push({ ...producer, carried: true });
    for (const o of objects) shown.add(String(o.objectId));
    kept.push(...objects);
  }
  if (!entries.length) return body;
  body.producers = [...(body.producers as Json[]), ...entries];
  body.objects = [...(body.objects as Json[]), ...kept].sort((a, b) =>
    compareStrings(String(a.objectId), String(b.objectId)),
  );
  const displayed = new Set((body.objects as Json[]).map((o) => String(o.revisionId)));
  const carriedRevisions = new Set(kept.map((o) => String(o.revisionId)));
  const drawn = new Set((body.relations as Json[]).map((r) => String(r.relationId)));
  body.relations = [
    ...(body.relations as Json[]),
    ...((parent.manifest.relations as Json[] | undefined) ?? []).filter(
      (r) =>
        !drawn.has(String(r.relationId)) &&
        displayed.has(String(r.from)) &&
        displayed.has(String(r.to)) &&
        (carriedRevisions.has(String(r.from)) || carriedRevisions.has(String(r.to))),
    ),
  ].sort((a, b) => compareStrings(String(a.relationId), String(b.relationId)));
  body.assessments = [
    ...(body.assessments as Json[]),
    ...((parent.manifest.assessments as Json[] | undefined) ?? []).filter((a) =>
      carriedRevisions.has(String(a.targetRevisionId)),
    ),
  ].sort((a, b) => compareStrings(String(a.targetRevisionId), String(b.targetRevisionId)));
  return body;
}

/** The newest ready v1 result and its import snapshot, when it was imported. */
export async function legacySource(
  projectId: string,
  store: AnalysisStore,
  reads: MapViewReads,
): Promise<[ResultLink, Snapshot] | null> {
  const rows = await reads.legacyResults(projectId);
  const newest = rows[rows.length - 1];
  if (!newest?.snapshotId) return null;
  const snapshot = await store.getSnapshot(newest.snapshotId);
  if (!snapshot || snapshot.projectId !== projectId) return null;
  return [newest, snapshot];
}

/** One configuration for the whole snapshot: the one most displayed revisions reference, else the imported result's. */
async function embeddingConfigFor(
  projectId: string,
  objects: Json[],
  legacy: Snapshot | null,
  store: AnalysisStore,
  reads: MapViewReads,
): Promise<Json | null> {
  const ids = objects
    .filter((o) => MAP_TYPES.includes(String(o.type)))
    .map((o) => String(o.revisionId));
  const revisions = ids.length ? await store.getRevisions(projectId, ids) : new Map();
  const keys = new Map<string, number>();
  for (const r of revisions.values()) {
    const key = r.embeddingRefs?.configKey;
    if (key) keys.set(String(key), (keys.get(String(key)) ?? 0) + 1);
  }
  const legacyConfig = legacy?.embeddingConfig ?? {};
  let key: string;
  if (keys.size) {
    key = [...keys.entries()].reduce((best, cur) =>
      cur[1] > best[1] || (cur[1] === best[1] && compareStrings(cur[0], best[0]) > 0) ? cur : best,
    )[0];
  } else if (legacyConfig.key) key = String(legacyConfig.key);
  else return null;
  if (key === legacyConfig.key)
    return { key, model: legacyConfig.model ?? null, dims: legacyConfig.dims ?? null };
  const identity = await reads.embeddingIdentity(projectId, key);
  return { key, model: identity ? identity[0] : null, dims: identity ? identity[1] : null };
}

export async function buildMapManifest(
  projectId: string,
  store: AnalysisStore,
  reads: MapViewReads,
  parent: Snapshot | null = null,
): Promise<Json> {
  const [heads, carried] = await resolveProducers(projectId, reads, parent);
  const manifest = await buildManifest(
    {
      projectId,
      viewId: MAP_VIEW_ID,
      scopeKey: VIEW_SCOPE_KEY,
      producers: heads.map((h): ProducerRef => ({ recipeId: h.recipeId, scopeKey: h.scopeKey })),
      versions: { mapPayload: PAYLOAD_VERSION },
    },
    store,
  );
  let body: Json = { ...manifest };
  delete body.contentHash;
  if (carried.length && parent) body = await carryOver(body, carried, parent, store);
  const argumentsReady = (body.producers as Json[]).some(
    (p) => p.recipeId === ARGUMENTS_RECIPE_ID && p.available,
  );
  const legacy = argumentsReady ? null : await legacySource(projectId, store, reads);
  const legacySnapshot = legacy ? legacy[1] : null;
  if (legacy && legacySnapshot) {
    const row = legacy[0];
    const shown = new Set((body.objects as Json[]).map((o) => String(o.objectId)));
    const imported = ((legacySnapshot.manifest.objects as Json[] | undefined) ?? [])
      .filter((o) => !shown.has(String(o.objectId)))
      .map((o) => ({
        objectId: String(o.objectId),
        revisionId: String(o.revisionId),
        type: String(o.type),
      }));
    body.objects = [...(body.objects as Json[]), ...imported].sort((a, b) =>
      compareStrings(String(a.objectId), String(b.objectId)),
    );
    body.producers = [
      ...(body.producers as Json[]),
      {
        recipeId: LEGACY_RECIPE_ID,
        scopeKey: VIEW_SCOPE_KEY,
        runId: null,
        recipeVersion: row.recipeVersion,
        legacyResultId: row.id,
        legacySnapshotId: legacySnapshot.id,
        objectIds: sortedStrings(imported.map((o) => o.objectId)),
        available: true,
      },
    ];
    const found = await store.assessmentsFor(
      projectId,
      imported.map((o) => o.revisionId),
    );
    body.assessments = [
      ...(body.assessments as Json[]),
      ...[...found.entries()].map(([target, a]) => ({
        targetRevisionId: target,
        revisionId: a.id,
        relationId: extraOf(a.provenance).assessesRelationId ?? null,
      })),
    ].sort((a, b) => compareStrings(String(a.targetRevisionId), String(b.targetRevisionId)));
  }
  body.embeddingConfig = await embeddingConfigFor(
    projectId,
    body.objects as Json[],
    legacySnapshot,
    store,
    reads,
  );
  return { ...body, contentHash: contentHash(body) };
}

/** Whether the view's current snapshot is behind its producers, legacy source or assessments. */
export async function needsAdvance(
  snapshot: Snapshot,
  store: AnalysisStore,
  reads: MapViewReads,
): Promise<boolean> {
  const producers = (snapshot.manifest.producers as Json[] | undefined) ?? [];
  const [heads, carried] = await resolveProducers(snapshot.projectId, reads, snapshot);
  const pinned = new Set(
    producers
      .filter((p) => p.runId && !p.carried)
      .map((p) => `${p.recipeId}|${p.scopeKey}|${p.runId}`),
  );
  const current = new Set(heads.map((h) => `${h.recipeId}|${h.scopeKey}|${h.runId}`));
  const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  if (!eq(pinned, current)) return true;
  if (
    !eq(
      new Set(producers.filter((p) => p.carried).map((p) => `${p.recipeId}|${p.scopeKey}`)),
      new Set(carried.map((c) => `${c.recipeId}|${c.scopeKey}`)),
    )
  )
    return true;
  const legacyPinned =
    producers.find((p) => p.recipeId === LEGACY_RECIPE_ID)?.legacySnapshotId ?? null;
  if (
    heads.some((h) => h.recipeId === ARGUMENTS_RECIPE_ID) ||
    carried.some((c) => c.recipeId === ARGUMENTS_RECIPE_ID)
  ) {
    if (legacyPinned) return true;
  } else {
    const legacy = await legacySource(snapshot.projectId, store, reads);
    if ((legacy ? legacy[1].id : null) !== (legacyPinned || null)) return true;
  }
  const checkable = ((snapshot.manifest.objects as Json[] | undefined) ?? [])
    .filter((o) => ARGUMENT_TYPES.has(String(o.type)))
    .map((o) => String(o.revisionId));
  if (!checkable.length) return false;
  const latest = await store.assessmentsFor(snapshot.projectId, checkable);
  const shown = new Map(
    ((snapshot.manifest.assessments as Json[] | undefined) ?? []).map((a) => [
      String(a.targetRevisionId),
      String(a.revisionId),
    ]),
  );
  if (latest.size !== shown.size) return true;
  for (const [target, a] of latest) if (shown.get(target) !== a.id) return true;
  return false;
}

export type EventPublisher = (projectId: string, event: Json) => Promise<void>;

/** Assembles the map view's successor, or keeps the current one when nothing changed. */
export async function advanceMapView(
  projectId: string,
  store: AnalysisStore,
  reads: MapViewReads,
  o: { sourceEventId?: string | null; createdBy?: string | null; publish: EventPublisher },
): Promise<Snapshot | null> {
  let snapshot: Snapshot | null = null;
  let created = false;
  for (let attempt = 0; attempt < ADVANCE_RETRIES; attempt++) {
    const scope = await store.ensureScope({
      projectId,
      kind: "view",
      ownerId: MAP_VIEW_ID,
      scopeKey: VIEW_SCOPE_KEY,
    });
    const expected = scope.currentSnapshotId;
    const previous = expected ? await store.getSnapshot(expected) : null;
    const manifest = await buildMapManifest(projectId, store, reads, previous);
    if (
      expected === null &&
      !((manifest.objects as Json[]) ?? []).length &&
      !((manifest.producers as Json[]) ?? []).some((p) => p.available)
    )
      return null;
    if (previous && !o.sourceEventId && previous.contentHash === manifest.contentHash) {
      snapshot = previous;
      break;
    }
    try {
      snapshot = await store.publishSnapshot(
        {
          projectId,
          scopeId: scope.id,
          viewId: MAP_VIEW_ID,
          manifest,
          contentHash: String(manifest.contentHash),
          manifestVersion: SNAPSHOT_MANIFEST_VERSION,
          versions: { ...((manifest.versions as Json | undefined) ?? {}) },
          embeddingConfig: (manifest.embeddingConfig as Json | null) ?? null,
          createdBy: o.createdBy ?? null,
          sourceEventId: o.sourceEventId ?? null,
        },
        expected,
      );
      created = snapshot.id !== expected;
      break;
    } catch (err) {
      if (!(err instanceof SnapshotConflict) || attempt === ADVANCE_RETRIES - 1) throw err;
    }
  }
  if (!snapshot) return null;
  await reads.ensureV2Result(snapshot);
  if (created) await o.publish(projectId, { type: "ready", snapshot_id: snapshot.id });
  return snapshot;
}

/** The map view's current snapshot, advanced first when it is behind. */
export async function currentMapSnapshot(
  projectId: string,
  store: AnalysisStore,
  reads: MapViewReads,
  o: { follow?: boolean; publish: EventPublisher },
): Promise<Snapshot | null> {
  const scope = await store.findScope({
    projectId,
    kind: "view",
    ownerId: MAP_VIEW_ID,
    scopeKey: VIEW_SCOPE_KEY,
  });
  const snapshot = scope?.currentSnapshotId
    ? await store.getSnapshot(scope.currentSnapshotId)
    : null;
  if (o.follow === false) return snapshot;
  if (!snapshot || (await needsAdvance(snapshot, store, reads)))
    return (await advanceMapView(projectId, store, reads, { publish: o.publish })) ?? snapshot;
  return snapshot;
}

// ── reading what a snapshot pins ────────────────────────────────────────

export const MAX_LINEAGE_DEPTH = 4;
export const MAX_LINEAGE_REVISIONS = 500;

/** A revision the snapshot displays, exactly as pinned; null otherwise. */
export async function snapshotRevision(
  snapshot: Snapshot,
  revisionId: string,
  store: AnalysisStore,
): Promise<ObjectRevision | null> {
  if (
    !((snapshot.manifest.objects as Json[] | undefined) ?? []).some(
      (o) => String(o.revisionId) === revisionId,
    )
  )
    return null;
  return (await store.getRevisions(snapshot.projectId, [revisionId])).get(revisionId) ?? null;
}

export function envelope(r: ObjectRevision): Json {
  const out: Json = {
    objectId: r.objectId,
    revisionId: r.id,
    projectId: r.projectId,
    type: r.type,
    schemaVersion: r.schemaVersion,
    payload: r.payload,
    attributes: r.attributes,
    provenance: provenanceOut(r),
    createdAt: pyIso(r.createdAt),
  };
  if (r.actorId !== null) out.actorId = r.actorId;
  if (r.changeKind !== null) out.changeKind = r.changeKind;
  if (r.parentRevisionId !== null) out.parentRevisionId = r.parentRevisionId;
  return out;
}

function provenanceOut(r: ObjectRevision): Json {
  const p = r.provenance;
  const out: Json = {
    runId: p.runId,
    origin: p.origin,
    inputRevisionIds: [...(p.inputRevisionIds ?? [])],
    sourceRefs: (p.sourceRefs ?? []).map((ref) => {
      const o: Json = { conversationId: ref.conversationId };
      if (ref.sourceFingerprint !== null && ref.sourceFingerprint !== undefined)
        o.sourceFingerprint = ref.sourceFingerprint;
      if (ref.quote !== null && ref.quote !== undefined) o.quote = ref.quote;
      if (ref.location !== null && ref.location !== undefined) o.location = ref.location;
      return o;
    }),
  };
  if (p.recipeId) out.recipeId = p.recipeId;
  if (p.recipeVersion) out.recipeVersion = p.recipeVersion;
  if (p.extra && Object.keys(p.extra).length) out.extra = p.extra;
  return out;
}

/** The historical evidence behind one displayed revision, as pinned; null when not displayed. */
export async function pinnedLineage(
  snapshot: Snapshot,
  revisionId: string,
  store: AnalysisStore,
): Promise<Json | null> {
  const manifest = snapshot.manifest;
  const pinned = new Set([
    ...((manifest.objects as Json[] | undefined) ?? []).map((o) => String(o.revisionId)),
    ...((manifest.assessments as Json[] | undefined) ?? []).map((a) => String(a.revisionId)),
  ]);
  if (!pinned.has(revisionId)) return null;
  const seen = new Map<string, ObjectRevision>();
  const edges: Json[] = [];
  const missing: string[] = [];
  let frontier = [revisionId];
  let truncated = false;
  let exhausted = true;
  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH; depth++) {
    let wanted = [...new Set(frontier)].filter((id) => !seen.has(id));
    if (!wanted.length) {
      exhausted = false;
      break;
    }
    if (seen.size + wanted.length > MAX_LINEAGE_REVISIONS) {
      wanted = wanted.slice(0, MAX_LINEAGE_REVISIONS - seen.size);
      truncated = true;
    }
    const found = await store.getRevisions(snapshot.projectId, wanted);
    missing.push(...wanted.filter((id) => !found.has(id)));
    for (const [id, r] of found) seen.set(id, r);
    frontier = [];
    for (const revision of found.values())
      for (const inputId of revision.provenance.inputRevisionIds ?? []) {
        edges.push({ from: revision.id, to: inputId });
        frontier.push(inputId);
      }
    if (truncated) {
      exhausted = false;
      break;
    }
  }
  if (exhausted) truncated = frontier.some((id) => !seen.has(id));
  return {
    snapshotId: snapshot.id,
    root: revisionId,
    revisions: [...seen.values()].map((r) => ({
      ...envelope(r),
      revisionNumber: r.revisionNumber,
      status: r.status,
    })),
    edges,
    missing: sortedStrings(new Set(missing)),
    truncated,
  };
}

// ── the following-view hook ─────────────────────────────────────────────

/** Assessments change what a view pins, so their publications advance it too. */
export const HOOK_TYPES = new Set([...MAP_TYPES, "fact_check_assessment"]);

export function mapViewHook(publish: EventPublisher) {
  return async (event: OutboxEvent, store: AnalysisStore): Promise<void> => {
    const reads = new MapViewReads(store);
    if (event.eventType === "revision_published") {
      if (HOOK_TYPES.has(String(event.payload.type)))
        await advanceMapView(event.projectId, store, reads, { sourceEventId: event.id, publish });
      return;
    }
    if (event.eventType !== "run_published") return;
    let outputs: readonly string[];
    try {
      outputs = getRecipe(String(event.payload.recipeId)).outputTypes;
    } catch (err) {
      if (err instanceof UnknownRecipe) return;
      throw err;
    }
    if (!outputs.some((t) => HOOK_TYPES.has(t))) return;
    await advanceMapView(event.projectId, store, reads, { sourceEventId: event.id, publish });
  };
}
