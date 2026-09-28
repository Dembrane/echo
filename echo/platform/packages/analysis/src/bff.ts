import type { Access } from "@dembrane/access";
import { ConflictError, NotFoundError, newId, UnavailableError, ValidationError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectAllows, projectFor } from "@dembrane/projects";
import type { RateLimiter } from "@dembrane/ratelimit";
import {
  AnalysisStoreError,
  AnalysisValidationError,
  extraOf,
  type Json,
  type ObjectRevision,
  ReferenceViolation,
  RevisionConflict,
  type Run,
  type Step,
  sourceRefJson,
} from "./contracts";
import { isUuid, J, micros, one, pyIso, q } from "./db";
import { cancelRun, requestRun } from "./executor";
import {
  ARGUMENT_TYPES,
  currentMapSnapshot,
  envelope,
  labelOf,
  MAP_TYPES,
  MapViewReads,
  pinnedLineage,
  projectDetail,
  provenanceDoc,
  scopeObjectIds,
  UnknownResultScope,
} from "./mapview";
import { ASSESSMENT_RECIPE_ID } from "./recipes";
import { listRecipes, pyRepr, recipeMetadata, sortedStrings } from "./registry";
import { RevisionService } from "./revisions";
import type { AnalysisRuntime } from "./runtime";
import { validatePayload } from "./types";

/**
 * The BFF analysis operations: recipes, runs, objects, revisions, the host's last-opened
 * mark and thumbs, lineage. Reading needs project and conversation read access (payloads
 * carry transcript-derived text); requesting, cancelling and editing need project:update.
 * Run- and snapshot-scoped routes resolve the row to its project before any access check,
 * so an id from another project is a 404.
 */

export interface BffDeps {
  readonly rt: AnalysisRuntime;
  readonly access: Access;
  readonly limiter: RateLimiter;
  readonly enablePresent: boolean;
  readonly now: () => Date;
}

/** Recipes that run only from their own feature: an assessment records what a fact-check found. */
export const INTERNAL_RECIPES = new Set([ASSESSMENT_RECIPE_ID]);
/** Client idempotency keys live apart from the keys the platform makes itself. */
export const CLIENT_KEY_PREFIX = "client:";
export const MAX_PAGE = 200;
const RUN_LIMIT = { name: "analysis_run", capacity: 10, windowSeconds: 600 };
export const EDITABLE_TYPES = new Set([
  "argument",
  "deduplicated_argument",
  "popcorn",
  "stakeholder",
  "tension",
]);
/** The words of a finding and nothing else; a host rewords a finding, never its grounds. */
export const EDITABLE_FIELDS: Record<string, ReadonlySet<string>> = {
  argument: new Set(["statement"]),
  deduplicated_argument: new Set(["statement"]),
  popcorn: new Set(["phrase"]),
  stakeholder: new Set(["name", "role", "stake"]),
  tension: new Set(["poleA", "poleB", "knot", "toResolve"]),
};

const unavailable = () => new UnavailableError("Analysis storage is unavailable.");
const notFound = (what: string) => new NotFoundError(`${what} not found`);

/** Maps store failures to the 503 the Python raised; everything else passes through. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AnalysisStoreError) throw unavailable();
    throw err;
  }
}

async function readable(d: BffDeps, who: Signed, projectId: string) {
  const pa = await projectFor(d.access, who, projectId, "project:read");
  await projectFor(d.access, who, projectId, "conversation:read");
  return pa;
}

const allows = (d: BffDeps, who: Signed, projectId: string, policy: "project:update") =>
  projectAllows(d.access, who, projectId, policy);

async function requireUpdate(d: BffDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:update");
}

export function stepDoc(s: Step): Json {
  return {
    id: s.id,
    key: s.stepKey,
    version: s.stepVersion,
    kind: s.kind,
    status: s.status,
    attempt: s.attempt,
    reusedStepId: s.reusedStepId,
    validation: s.validation,
    usage: s.usage,
    error: s.error,
    createdAt: pyIso(s.createdAt),
    completedAt: pyIso(s.completedAt),
  };
}

function manifestSummary(m: Json | null | undefined): Json | null {
  if (!m || !Object.keys(m).length) return null;
  return {
    objects: ((m.objects as unknown[] | undefined) || []).length,
    relations: ((m.relations as unknown[] | undefined) || []).length,
    contentHash: m.contentHash ?? null,
    publicationSequence: m.publicationSequence ?? null,
  };
}

export function runDoc(run: Run, steps: Step[] | null = null): Json {
  const progress = Object.fromEntries(
    Object.entries(run.progress).filter(([k]) => k !== "candidateManifest"),
  );
  const inputs = run.inputManifest ?? {};
  const doc: Json = {
    id: run.id,
    projectId: run.projectId,
    scopeId: run.scopeId,
    recipeId: run.recipeId,
    recipeVersion: run.recipeVersion,
    definition: run.definition,
    mode: run.mode,
    epoch: run.epoch,
    status: run.status,
    requestOrder: run.requestOrder,
    progress,
    checks: run.checks,
    metrics: run.metrics,
    error: run.error,
    parameters: run.parameters,
    inputs: {
      fingerprint: run.inputFingerprint,
      selectedRevisionIds: (inputs.selectedRevisionIds as unknown[] | undefined) || [],
      revisions: ((inputs.revisionIds as unknown[] | undefined) || []).length,
      dependencies: (inputs.dependencies as Json | undefined) || {},
    },
    dependsOn: run.dependsOn,
    output: manifestSummary(run.outputManifest),
    candidate: manifestSummary(run.progress.candidateManifest as Json | undefined),
    reusedRunId: run.reusedRunId,
    attempt: run.attempt,
    createdAt: pyIso(run.createdAt),
    updatedAt: pyIso(run.updatedAt),
    startedAt: pyIso(run.startedAt),
    completedAt: pyIso(run.completedAt),
  };
  if (steps) doc.steps = steps.map(stepDoc);
  return doc;
}

export function revisionDoc(r: ObjectRevision): Json {
  return {
    ...envelope(r),
    revisionNumber: r.revisionNumber,
    status: r.status,
    reason: r.reason,
    // Null on generated revisions and older authored ones: "not recorded".
    changeKind: r.changeKind,
    actorId: r.actorId,
    publishedAt: pyIso(r.publishedAt),
    membershipExcluded: Boolean(extraOf(r.provenance).membershipExcluded),
  };
}

// ── recipes and runs ────────────────────────────────────────────────────

export function listRecipesDoc(): Json {
  return {
    recipes: listRecipes()
      .filter((r) => !INTERNAL_RECIPES.has(r.id))
      .map(recipeMetadata),
  };
}

export interface RunCreate {
  readonly recipe_id: string;
  readonly scope_key: string;
  readonly parameters: Json;
  readonly selected_revision_ids: string[];
  readonly mode: string;
  readonly idempotency_key: string | null;
  readonly refresh_dependencies: boolean;
  readonly retry_run_id: string | null;
}

export async function requestAnalysisRun(
  d: BffDeps,
  who: Signed,
  projectId: string,
  body: RunCreate,
) {
  await readable(d, who, projectId);
  await requireUpdate(d, who, projectId);
  if (INTERNAL_RECIPES.has(body.recipe_id))
    throw new ValidationError("This recipe runs only from its own feature.");
  await d.limiter.check(RUN_LIMIT, who.directusUserId);
  try {
    const outcome = await requestRun(
      {
        projectId,
        recipeId: body.recipe_id,
        scopeKey: body.scope_key,
        mode: body.mode,
        parameters: body.parameters,
        selectedRevisionIds: body.selected_revision_ids,
        idempotencyKey: body.idempotency_key ? `${CLIENT_KEY_PREFIX}${body.idempotency_key}` : null,
        requestedBy: who.directusUserId,
        refreshDependencies: body.refresh_dependencies,
        retryRunId: body.retry_run_id,
      },
      d.rt.executor,
    );
    return {
      run: runDoc(outcome.run),
      outcome: outcome.outcome,
      dependencies: outcome.dependencies.map((r) => runDoc(r)),
    };
  } catch (err) {
    if (err instanceof AnalysisValidationError) throw new ValidationError(err.message);
    if (err instanceof AnalysisStoreError) throw unavailable();
    throw err;
  }
}

async function runOf(d: BffDeps, who: Signed, runId: string): Promise<Run> {
  if (!isUuid(runId)) throw notFound("Run");
  const run = await guarded(() => d.rt.store.getRun(runId));
  if (!run) throw notFound("Run");
  await readable(d, who, run.projectId);
  return run;
}

export async function getAnalysisRun(d: BffDeps, who: Signed, runId: string) {
  const run = await runOf(d, who, runId);
  const steps = await guarded(() => d.rt.store.getSteps(run.id));
  return { run: runDoc(run, steps) };
}

export async function listAnalysisRuns(
  d: BffDeps,
  who: Signed,
  projectId: string,
  offset: number,
  limit: number,
) {
  await readable(d, who, projectId);
  const [runs, total, scopes] = await guarded(async () => {
    const [rs, t] = await d.rt.store.projectRuns(projectId, offset, limit);
    const sc = new Map<string, string | null>();
    for (const r of rs)
      if (!sc.has(r.scopeId))
        sc.set(r.scopeId, (await d.rt.store.getScope(r.scopeId))?.scopeKey ?? null);
    return [rs, t, sc] as const;
  });
  return {
    total,
    offset,
    limit,
    canRun: await allows(d, who, projectId, "project:update"),
    runs: runs.map((r) => ({ ...runDoc(r), scopeKey: scopes.get(r.scopeId) ?? null })),
  };
}

export async function cancelAnalysisRun(d: BffDeps, who: Signed, runId: string) {
  const run = await runOf(d, who, runId);
  await requireUpdate(d, who, run.projectId);
  const cancelled = await guarded(() => cancelRun(run.id, d.rt.executor));
  return { run: runDoc(cancelled ?? run) };
}

// ── what needs the host's eye ───────────────────────────────────────────

const ATTENTION_ORDER = ["new", "one_conversation", "one_quote", "fact_check", "reworded"];
const VERDICTS_THAT_DISAGREE = ["false", "contested"];
const attentionRank = (phrase: string | null) =>
  phrase !== null && ATTENTION_ORDER.includes(phrase)
    ? ATTENTION_ORDER.indexOf(phrase)
    : ATTENTION_ORDER.length;

interface AuthoredMark {
  readonly firstAt: string | null;
  readonly lastWordingAt: string | null;
  readonly lastWordingBy: string | null;
  readonly wordingCount: number;
}
const NO_MARK: AuthoredMark = {
  firstAt: null,
  lastWordingAt: null,
  lastWordingBy: null,
  wordingCount: 0,
};

/** An authored revision that changed the words, by kind or, before the audit trail, by what it is not. */
const WORDING_SQL = `(origin = 'authored' AND (
        change_kind IN ('typo', 'clarity', 'meaning')
        OR (change_kind IS NULL
            AND provenance -> 'extra' ->> 'authoredFrom' IS NOT NULL
            AND provenance -> 'extra' ->> 'rollbackOf' IS NULL
            AND provenance -> 'extra' ->> 'membershipExcluded' IS NULL)))`;

async function authoredMarks(
  d: BffDeps,
  projectId: string,
  objectIds: string[],
): Promise<Map<string, AuthoredMark>> {
  const wanted = sortedStrings(new Set(objectIds));
  if (!wanted.length) return new Map();
  const rows = await q(
    d.rt.store.sql,
    `SELECT object_id::text AS object_id,
            MIN(created_at) AS first_at,
            MAX(created_at) FILTER (WHERE ${WORDING_SQL}) AS last_wording_at,
            COUNT(*) FILTER (WHERE ${WORDING_SQL}) AS wording_count,
            (array_agg(actor_id ORDER BY created_at DESC, revision_number DESC)
                 FILTER (WHERE ${WORDING_SQL}))[1] AS last_wording_by
       FROM analysis_object_revision
      WHERE project_id = $1 AND status = 'published'
        AND object_id = ANY($2::uuid[])
      GROUP BY object_id`,
    [projectId, wanted.filter((id) => isUuid(id))],
  );
  return new Map(
    rows.map((r) => [
      String(r.object_id),
      {
        firstAt: (r.first_at as string | null) ?? null,
        lastWordingAt: (r.last_wording_at as string | null) ?? null,
        lastWordingBy: (r.last_wording_by as string | null) ?? null,
        wordingCount: Number(r.wording_count || 0),
      },
    ]),
  );
}

/** Quotes, and the conversations they come from. */
function evidence(r: ObjectRevision): [number, Set<string>] {
  let quotes = 0;
  const conversations = new Set<string>();
  for (const item of (r.payload.evidence as unknown[] | undefined) || []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const i = item as Json;
    quotes += ((i.quotes as unknown[] | undefined) || []).length;
    if (i.conversationId) conversations.add(String(i.conversationId));
  }
  for (const quote of (r.payload.quotes as unknown[] | undefined) || []) {
    if (!quote || typeof quote !== "object" || Array.isArray(quote)) continue;
    quotes += 1;
    const qt = quote as Json;
    if (qt.conversationId) conversations.add(String(qt.conversationId));
  }
  return [quotes, conversations];
}

/** The display name of each conversation: its title, else the participant's name. */
async function conversationNames(
  d: BffDeps,
  projectId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  try {
    const rows = await q(
      d.rt.store.sql,
      `SELECT id::text AS id, title, participant_name FROM conversation
        WHERE id = ANY($1::uuid[]) AND project_id = $2 ORDER BY id LIMIT $3`,
      [ids.filter((id) => isUuid(id)), projectId, ids.length],
    );
    const names = new Map<string, string>();
    for (const r of rows) {
      const name = String(r.title || "").trim() || String(r.participant_name || "").trim();
      if (name) names.set(String(r.id), name);
    }
    return names;
  } catch {
    // A name is a nicety, never the answer.
    return new Map();
  }
}

async function verdicts(
  d: BffDeps,
  projectId: string,
  revisions: ObjectRevision[],
): Promise<Map<string, string>> {
  const ids = revisions.filter((r) => ARGUMENT_TYPES.has(r.type)).map((r) => r.id);
  if (!ids.length) return new Map();
  const out = new Map<string, string>();
  for (const [revisionId, a] of await d.rt.store.assessmentsFor(projectId, ids)) {
    const verdict = String(a.payload.verdict || "");
    if (["true", "false", "contested", "unknown"].includes(verdict)) out.set(revisionId, verdict);
  }
  return out;
}

function attention(o: {
  revision: ObjectRevision | null;
  mark: AuthoredMark;
  verdict: string | null;
  lastOpened: string | null;
  viewer: string | null;
}): [string | null, string | null] {
  if (!o.revision) return [null, null];
  const [quotes, conversations] = evidence(o.revision);
  if (o.lastOpened && o.mark.firstAt && micros(o.mark.firstAt) > micros(o.lastOpened))
    return ["new", null];
  if (conversations.size <= 1) return ["one_conversation", null];
  if (quotes <= 1) return ["one_quote", null];
  if (o.verdict && VERDICTS_THAT_DISAGREE.includes(o.verdict)) return ["fact_check", null];
  if (
    o.lastOpened &&
    o.mark.lastWordingAt &&
    micros(o.mark.lastWordingAt) > micros(o.lastOpened) &&
    o.mark.lastWordingBy &&
    o.mark.lastWordingBy !== o.viewer
  )
    return ["reworded", o.mark.lastWordingBy];
  return [null, null];
}

// ── objects ─────────────────────────────────────────────────────────────

export interface ObjectsQuery {
  readonly type: string | null;
  readonly scope: string | null;
  readonly snapshot_id: string | null;
  readonly membership: "active" | "withdrawn" | "all";
  readonly sort: "default" | "attention";
  readonly offset: number;
  readonly limit: number;
}

export async function listAnalysisObjects(
  d: BffDeps,
  who: Signed,
  projectId: string,
  query: ObjectsQuery,
) {
  await readable(d, who, projectId);
  if (query.type !== null && !MAP_TYPES.includes(query.type))
    throw new ValidationError(`unknown object type ${pyRepr(query.type)}`);
  const store = d.rt.store;
  const reads = new MapViewReads(store);
  let snapshot: Awaited<ReturnType<typeof store.getSnapshot>> = null;
  let entries: Json[] = [];
  let page: Json[] = [];
  let revisions = new Map<string, ObjectRevision>();
  let marks = new Map<string, AuthoredMark>();
  let verdictsBy = new Map<string, string>();
  const attentionBy = new Map<string, [string | null, string | null]>();
  const counts: Record<string, number> = Object.fromEntries(MAP_TYPES.map((t) => [t, 0]));
  try {
    if (query.snapshot_id) {
      snapshot = await store.getSnapshot(query.snapshot_id);
      if (!snapshot || snapshot.projectId !== projectId) throw notFound("Snapshot");
    } else
      snapshot = await currentMapSnapshot(projectId, store, reads, {
        follow: false,
        publish: d.rt.publishMap,
      });
    entries = snapshot
      ? ((snapshot.manifest.objects as Json[] | undefined) || []).filter((o) =>
          MAP_TYPES.includes(String(o.type)),
        )
      : [];
    if (query.membership !== "active") {
      const current = await store.currentRevisions(projectId);
      const withdrawn = [...current.values()]
        .filter((r) => MAP_TYPES.includes(r.type) && extraOf(r.provenance).membershipExcluded)
        .map((r) => ({ objectId: r.objectId, revisionId: r.id, type: r.type }));
      if (query.membership === "withdrawn") entries = withdrawn;
      else {
        const active = new Set(entries.map((e) => String(e.objectId)));
        entries.push(...withdrawn.filter((e) => !active.has(String(e.objectId))));
      }
    }
    if (query.scope && snapshot) {
      const members = await scopeObjectIds(snapshot, query.scope, store);
      entries = entries.filter((o) => members.has(String(o.objectId)));
    }
    for (const e of entries) counts[String(e.type)] = (counts[String(e.type)] ?? 0) + 1;
    if (query.type !== null) entries = entries.filter((o) => o.type === query.type);
    entries.sort(
      (a, b) =>
        MAP_TYPES.indexOf(String(a.type)) - MAP_TYPES.indexOf(String(b.type)) ||
        (String(a.objectId) < String(b.objectId)
          ? -1
          : String(a.objectId) > String(b.objectId)
            ? 1
            : 0),
    );
    if (query.sort === "attention" && entries.length) {
      revisions = await store.getRevisions(
        projectId,
        entries.map((o) => String(o.revisionId)),
      );
      marks = await authoredMarks(
        d,
        projectId,
        entries.map((o) => String(o.objectId)),
      );
      verdictsBy = await verdicts(d, projectId, [...revisions.values()]);
      const lastOpened = await readLastOpened(d, projectId, who.directusUserId);
      for (const entry of entries)
        attentionBy.set(
          String(entry.objectId),
          attention({
            revision: revisions.get(String(entry.revisionId)) ?? null,
            mark: marks.get(String(entry.objectId)) ?? NO_MARK,
            verdict: verdictsBy.get(String(entry.revisionId)) ?? null,
            lastOpened,
            viewer: who.directusUserId,
          }),
        );
      // Stable: rows keep the order they had within a type and a phrase.
      entries = entries
        .map((e, i) => ({ e, i }))
        .sort(
          (a, b) =>
            MAP_TYPES.indexOf(String(a.e.type)) - MAP_TYPES.indexOf(String(b.e.type)) ||
            attentionRank(attentionBy.get(String(a.e.objectId))?.[0] ?? null) -
              attentionRank(attentionBy.get(String(b.e.objectId))?.[0] ?? null) ||
            a.i - b.i,
        )
        .map(({ e }) => e);
      page = entries.slice(query.offset, query.offset + query.limit);
    } else {
      page = entries.slice(query.offset, query.offset + query.limit);
      revisions = await store.getRevisions(
        projectId,
        page.map((o) => String(o.revisionId)),
      );
      marks = await authoredMarks(
        d,
        projectId,
        page.map((o) => String(o.objectId)),
      );
      verdictsBy = await verdicts(d, projectId, [...revisions.values()]);
    }
  } catch (err) {
    if (err instanceof UnknownResultScope) throw new ValidationError(err.message);
    if (err instanceof AnalysisStoreError) throw unavailable();
    throw err;
  }
  // A finding whose quotes all come from one conversation says which one.
  const alone = new Map<string, string>();
  for (const entry of page) {
    const r = revisions.get(String(entry.revisionId));
    if (!r) continue;
    const [, conversations] = evidence(r);
    if (conversations.size === 1) alone.set(r.id, [...conversations][0] as string);
  }
  const names = await conversationNames(d, projectId, sortedStrings(new Set(alone.values())));
  const mine = await guarded(() =>
    readFeedback(
      d,
      projectId,
      who.directusUserId,
      page.map((e) => String(e.objectId)),
    ),
  );
  const items = page.map((entry) => {
    const r = revisions.get(String(entry.revisionId));
    if (!r)
      return {
        objectId: entry.objectId,
        revisionId: entry.revisionId,
        type: entry.type,
        missing: true,
      };
    const mark = marks.get(r.objectId) ?? NO_MARK;
    const [quotes, conversations] = evidence(r);
    const [phrase, actor] = attentionBy.get(String(entry.objectId)) ?? [null, null];
    return {
      objectId: r.objectId,
      revisionId: r.id,
      type: r.type,
      label: labelOf(r),
      payload: r.payload,
      membershipExcluded: Boolean(extraOf(r.provenance).membershipExcluded),
      detail: projectDetail(r),
      attributes: r.attributes,
      lastAuthoredAt: pyIso(mark.lastWordingAt),
      lastAuthoredBy: mark.lastWordingBy,
      edited: mark.wordingCount > 0,
      quoteCount: quotes,
      conversationCount: conversations.size,
      conversationName:
        conversations.size === 1 ? (names.get(alone.get(r.id) ?? "") ?? null) : null,
      verdict: verdictsBy.get(r.id) ?? null,
      myFeedback: feedbackDoc(mine.get(r.objectId) ?? null),
      attention: phrase,
      attentionActor: actor,
      provenance: {
        ...provenanceDoc(r),
        sourceRefs: (r.provenance.sourceRefs ?? []).map(sourceRefJson),
      },
    };
  });
  return {
    snapshotId: snapshot ? snapshot.id : null,
    counts,
    total: entries.length,
    offset: query.offset,
    limit: query.limit,
    canEdit: await allows(d, who, projectId, "project:update"),
    items,
  };
}

export async function getObjectHistory(
  d: BffDeps,
  who: Signed,
  projectId: string,
  objectId: string,
) {
  await readable(d, who, projectId);
  const store = d.rt.store;
  const [record, ids, revisions] = await guarded(async () => {
    const rec = isUuid(objectId) ? await store.getObject(objectId) : null;
    if (!rec || rec.projectId !== projectId) throw notFound("Object");
    const history = await new MapViewReads(store).revisionHistory(projectId, objectId);
    return [rec, history, await store.getRevisions(projectId, history)] as const;
  });
  return {
    object: {
      id: record.id,
      type: record.type,
      currentRevisionId: record.currentRevisionId,
      revisionCount: record.revisionCount,
    },
    revisions: ids
      .filter((id) => revisions.has(id))
      .map((id) => revisionDoc(revisions.get(id) as ObjectRevision)),
  };
}

function requirePresent(d: BffDeps) {
  if (!d.enablePresent) throw new NotFoundError("Not found");
}

async function editableObject(d: BffDeps, who: Signed, projectId: string, objectId: string) {
  await readable(d, who, projectId);
  await requireUpdate(d, who, projectId);
  const record = await guarded(async () =>
    isUuid(objectId) ? d.rt.store.getObject(objectId) : null,
  );
  if (!record || record.projectId !== projectId) throw notFound("Object");
  if (!EDITABLE_TYPES.has(record.type)) throw new ValidationError("This result type is read-only.");
  return record;
}

/** Python's == over JSON values: 1 equals 1.0, dicts compare by content. */
function pyEqual(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));
  return JSON.stringify(sortDeep(norm(a))) === JSON.stringify(sortDeep(norm(b)));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Json)
        .sort()
        .map((k) => [k, sortDeep((v as Json)[k])]),
    );
  return v;
}

export interface RevisionEdit {
  readonly expected_revision_id: string;
  readonly payload: Json | null;
  readonly patch: Json | null;
  readonly reason: string | null;
  readonly change_kind: string | null;
}

async function editedPayload(
  d: BffDeps,
  projectId: string,
  recordId: string,
  type: string,
  body: RevisionEdit,
) {
  const allowed = EDITABLE_FIELDS[type] ?? new Set<string>();
  if ((body.payload === null) === (body.patch === null))
    throw new ValidationError("Send either the payload or a patch of fields to change.");
  const base = await guarded(async () =>
    (await d.rt.store.getRevisions(projectId, [body.expected_revision_id])).get(
      body.expected_revision_id,
    ),
  );
  if (!base || base.objectId !== recordId) throw notFound("Revision");
  if (body.patch !== null) {
    const refused = sortedStrings(Object.keys(body.patch).filter((k) => !allowed.has(k)));
    if (refused.length) throw new ValidationError(`${refused[0]} cannot be edited here.`);
    return { ...base.payload, ...body.patch };
  }
  let wanted: Json;
  try {
    wanted = validatePayload(type, body.payload);
  } catch (err) {
    if (err instanceof AnalysisValidationError) throw new ValidationError(err.message);
    throw err;
  }
  const changed = sortedStrings(
    new Set(
      [...Object.keys(wanted), ...Object.keys(base.payload)].filter(
        (k) => !pyEqual(wanted[k], base.payload[k]),
      ),
    ),
  );
  const refused = changed.filter((k) => !allowed.has(k));
  if (refused.length) throw new ValidationError(`${refused[0]} cannot be edited here.`);
  return wanted;
}

function revisionConflict(err: RevisionConflict): ConflictError {
  return new ConflictError("This result changed while you were reviewing it.", {
    message: "This result changed while you were reviewing it.",
    objectId: err.objectId,
    expectedRevisionId: err.expectedRevisionId,
    current: err.current ? revisionDoc(err.current) : null,
  });
}

/** Runs one authored write and maps its refusals to the Python responses. */
async function authored(write: () => Promise<ObjectRevision>) {
  try {
    return { revision: revisionDoc(await write()) };
  } catch (err) {
    if (err instanceof RevisionConflict) throw revisionConflict(err);
    if (err instanceof ReferenceViolation) throw notFound("Revision");
    if (err instanceof AnalysisValidationError) throw new ValidationError(err.message);
    if (err instanceof AnalysisStoreError) throw unavailable();
    throw err;
  }
}

export async function editAnalysisObject(
  d: BffDeps,
  who: Signed,
  projectId: string,
  objectId: string,
  body: RevisionEdit,
) {
  requirePresent(d);
  const record = await editableObject(d, who, projectId, objectId);
  const payload = await editedPayload(d, projectId, record.id, record.type, body);
  return authored(() =>
    new RevisionService(d.rt.store).authorEdit({
      projectId,
      objectId,
      expected: body.expected_revision_id,
      payload,
      actorId: who.directusUserId,
      reason: body.reason,
      changeKind: body.change_kind,
    }),
  );
}

export async function rollbackAnalysisObject(
  d: BffDeps,
  who: Signed,
  projectId: string,
  objectId: string,
  body: {
    expected_revision_id: string;
    to_revision_id: string;
    reason: string | null;
    change_kind: string | null;
  },
) {
  requirePresent(d);
  await editableObject(d, who, projectId, objectId);
  return authored(() =>
    new RevisionService(d.rt.store).rollback({
      projectId,
      objectId,
      toRevisionId: body.to_revision_id,
      expected: body.expected_revision_id,
      actorId: who.directusUserId,
      reason: body.reason,
      changeKind: body.change_kind,
    }),
  );
}

export async function setObjectMembership(
  d: BffDeps,
  who: Signed,
  projectId: string,
  objectId: string,
  body: {
    expected_revision_id: string;
    excluded: boolean;
    reason: string | null;
    change_kind: string | null;
  },
) {
  requirePresent(d);
  await editableObject(d, who, projectId, objectId);
  return authored(() =>
    new RevisionService(d.rt.store).setExcluded({
      projectId,
      objectId,
      expected: body.expected_revision_id,
      excluded: body.excluded,
      actorId: who.directusUserId,
      reason: body.reason,
      changeKind: body.change_kind,
    }),
  );
}

// ── when this host last opened the list ─────────────────────────────────

async function readLastOpened(
  d: BffDeps,
  projectId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const row = await one(
    d.rt.store.sql,
    "SELECT opened_at FROM analysis_last_opened WHERE project_id = $1 AND user_id = $2",
    [projectId, userId],
  );
  return (row?.opened_at as string | null) ?? null;
}

export async function getResultsLastOpened(d: BffDeps, who: Signed, projectId: string) {
  await readable(d, who, projectId);
  const openedAt = await guarded(() => readLastOpened(d, projectId, who.directusUserId));
  return { openedAt: pyIso(openedAt) };
}

/** The time is the server's: a clock the host cannot set decides what counts as new. */
export async function setResultsLastOpened(d: BffDeps, who: Signed, projectId: string) {
  await readable(d, who, projectId);
  if (!who.directusUserId) throw notFound("Host");
  const row = await guarded(() =>
    one(
      d.rt.store.sql,
      `INSERT INTO analysis_last_opened (id, project_id, user_id, opened_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (project_id, user_id) DO UPDATE SET opened_at = EXCLUDED.opened_at
       RETURNING opened_at`,
      [newId(), projectId, who.directusUserId],
    ),
  );
  return { openedAt: pyIso((row?.opened_at as string | null) ?? d.now().toISOString()) };
}

// ── what this host thinks of a finding ──────────────────────────────────

export const FEEDBACK_TAGS: Record<string, readonly string[]> = {
  up: ["recognizable", "relevant", "felt_heard", "other"],
  down: ["not_recognizable", "not_relevant", "tone_deaf", "other"],
};
const NOTE_TAG = "other";

function feedbackDoc(row: Json | null): Json | null {
  if (!row) return null;
  const doc: Json = {
    rating: String(row.rating),
    tags: [...((row.tags as unknown[] | undefined) || [])],
    revisionId: String(row.revision_id),
  };
  if (row.note) doc.note = String(row.note);
  return doc;
}

async function readFeedback(
  d: BffDeps,
  projectId: string,
  userId: string | null,
  objectIds: string[],
) {
  if (!userId || !objectIds.length) return new Map<string, Json>();
  const wanted = sortedStrings(new Set(objectIds.map(String)));
  const rows = await q(
    d.rt.store.sql,
    `SELECT object_id::text AS object_id, revision_id::text AS revision_id, rating, tags, note
       FROM analysis_feedback
      WHERE project_id = $1 AND actor_id = $2 AND object_id = ANY($3::uuid[])`,
    [projectId, userId, wanted.filter((id) => isUuid(id))],
  );
  return new Map(rows.map((r) => [String(r.object_id), r as Json]));
}

async function rateableObject(d: BffDeps, who: Signed, projectId: string, objectId: string) {
  await readable(d, who, projectId);
  if (!who.directusUserId) throw notFound("Host");
  const record = await guarded(async () =>
    isUuid(objectId) ? d.rt.store.getObject(objectId) : null,
  );
  if (!record || record.projectId !== projectId) throw notFound("Object");
  return record;
}

export interface FeedbackWrite {
  readonly revision_id: string;
  readonly rating: "up" | "down";
  readonly tags: string[];
  readonly note: string | null;
}

/** A tag of the other polarity is a disagreement about what was clicked, not a typo. */
function checkedFeedback(body: FeedbackWrite): [string[], string | null] {
  const allowed = FEEDBACK_TAGS[body.rating] ?? [];
  const tags: string[] = [];
  for (const tag of body.tags) {
    if (!allowed.includes(tag))
      throw new ValidationError(`${pyRepr(tag)} is not a reason for a thumbs ${body.rating}.`);
    if (!tags.includes(tag)) tags.push(tag);
  }
  const note = (body.note || "").trim();
  return [tags, note && tags.includes(NOTE_TAG) ? note : null];
}

export async function rateAnalysisObject(
  d: BffDeps,
  who: Signed,
  projectId: string,
  objectId: string,
  body: FeedbackWrite,
) {
  const record = await rateableObject(d, who, projectId, objectId);
  const [tags, note] = checkedFeedback(body);
  if (!isUuid(body.revision_id)) throw notFound("Revision");
  const row = await guarded(async () => {
    const revision = (await d.rt.store.getRevisions(projectId, [body.revision_id])).get(
      body.revision_id,
    );
    if (!revision || revision.objectId !== record.id) throw notFound("Revision");
    return one(
      d.rt.store.sql,
      `INSERT INTO analysis_feedback
              (id, project_id, object_id, revision_id, actor_id, rating, tags, note,
               created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       ON CONFLICT (project_id, object_id, actor_id)
       DO UPDATE SET revision_id = EXCLUDED.revision_id,
                     rating = EXCLUDED.rating,
                     tags = EXCLUDED.tags,
                     note = EXCLUDED.note,
                     updated_at = now()
       RETURNING object_id::text AS object_id, revision_id::text AS revision_id, rating, tags, note`,
      [
        newId(),
        projectId,
        record.id,
        body.revision_id,
        who.directusUserId,
        body.rating,
        J(tags),
        note,
      ],
    );
  });
  return { myFeedback: feedbackDoc(row) };
}

export async function clearAnalysisObjectFeedback(
  d: BffDeps,
  who: Signed,
  projectId: string,
  objectId: string,
) {
  const record = await rateableObject(d, who, projectId, objectId);
  await guarded(() =>
    q(
      d.rt.store.sql,
      "DELETE FROM analysis_feedback WHERE project_id = $1 AND object_id = $2 AND actor_id = $3",
      [projectId, record.id, who.directusUserId],
    ),
  );
  return { myFeedback: null };
}

export async function getPinnedLineage(
  d: BffDeps,
  who: Signed,
  snapshotId: string,
  revisionId: string,
) {
  const snapshot = await guarded(() => d.rt.store.getSnapshot(snapshotId));
  if (!snapshot) throw notFound("Snapshot");
  await readable(d, who, snapshot.projectId);
  const lineage = await guarded(() => pinnedLineage(snapshot, revisionId, d.rt.store));
  if (!lineage) throw notFound("Revision");
  return lineage;
}
