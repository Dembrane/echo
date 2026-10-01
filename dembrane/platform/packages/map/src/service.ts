import {
  type AnalysisRuntime,
  AnalysisStoreError,
  ARGUMENT_TYPES,
  ARGUMENTS_RECIPE_ID,
  claimOf,
  isV2Manifest,
  type Json,
  LEGACY_VIEW_ID,
  labelOf,
  loadVectors,
  MAP_VIEW_ID,
  MAX_TITLE_CHARS,
  MIN_TITLE_NODES,
  micros,
  type ObjectRevision,
  pyIso,
  type Run,
  requestRun,
  round6,
  SelectionTooLarge,
  SelectionTooSmall,
  type Snapshot,
  snapshotRevision,
  sortedStrings,
  titleLines,
  titleSelectionKey,
  VIEW_SCOPE_KEY,
} from "@dembrane/analysis";
import { ACTIVE_STATUSES, type MapStore, type Row } from "./store";

/**
 * Map as the API uses it: page state, generation requests, titles, fact-checks. Callers
 * check project access first. A result id names a v1 map_result row, a v2 row that points
 * at a map view snapshot, or the snapshot itself; v2 titles and fact-checks name exact
 * revision ids. Generation is a run of the arguments recipe through the executor; a v1
 * attempt still running is returned first.
 */

export const STALE_ATTEMPT_SECONDS = 20 * 60;
/** A check still processing after this long is abandoned; a new request may start it again. */
export const FACT_CHECK_STALE_SECONDS = 15 * 60;
export const MANIFEST_VERSION = 1;
const PROGRESS_KEYS = [
  "stage",
  "conversations_total",
  "conversations_done",
  "conversations_failed",
  "conversations_resumed",
  "embeddings_total",
  "embeddings_done",
  "embeddings_reused",
];

export class NotReady extends Error {}
export class UnknownArguments extends Error {}
export class NotAClaim extends Error {}

export interface SnapshotTarget {
  readonly kind: "snapshot";
  readonly snapshot: Snapshot;
  readonly resultId: string | null;
}
export type Target = { readonly kind: "row"; readonly row: Row } | SnapshotTarget;

export const targetProject = (t: Target) =>
  t.kind === "row" ? String(t.row.project_id) : t.snapshot.projectId;

export interface MapDeps {
  readonly store: MapStore;
  readonly rt: AnalysisRuntime;
}

export function attemptPayload(row: Row | null): Json | null {
  if (!row) return null;
  const progress = (row.progress as Json | null) ?? {};
  return {
    id: row.id,
    status: row.status,
    created_at: pyIso(row.created_at as string | null),
    updated_at: pyIso(row.updated_at as string | null),
    completed_at: pyIso(row.completed_at as string | null),
    error: row.error ?? null,
    progress: Object.fromEntries(
      PROGRESS_KEYS.filter((k) => k in progress).map((k) => [k, progress[k]]),
    ),
  };
}

/** An arguments run as the attempt the page shows; a ready, superseded or cancelled run is none. */
export function runAttempt(run: Run | null): Row | null {
  if (!run) return null;
  const stage = String(run.progress.stage || "");
  let status: string;
  if (run.status === "queued" || run.status === "waiting_for_inputs") status = "queued";
  else if (run.status === "running")
    status = stage === "extracting" || stage === "embedding" ? stage : "extracting";
  else if (run.status === "failed") status = "failed";
  else return null;
  return {
    id: run.id,
    status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt,
    error: run.error,
    progress: {
      ...Object.fromEntries(
        Object.entries(run.progress).filter(([k]) => PROGRESS_KEYS.includes(k)),
      ),
      stage: stage || status,
    },
  };
}

/** A ready v1 revision with every argument, its evidence and its vector. */
export async function resultPayload(d: MapDeps, row: Row): Promise<Json> {
  const manifest = (row.manifest as Json | null) ?? {};
  const args = (manifest.arguments as Json[] | undefined) ?? [];
  const vectors = await d.rt.store.vectorsByIds(
    String(row.project_id),
    args.filter((a) => a.embedding_id).map((a) => String(a.embedding_id)),
  );
  const missing: unknown[] = [];
  const shaped = args.map((a) => {
    const vector = vectors.get(String(a.embedding_id || "")) ?? null;
    if (!vector) missing.push(a.id);
    return {
      id: a.id,
      statement: a.statement,
      kind: a.kind,
      valence: a.valence,
      claim_key: a.claim_key ?? null,
      evidence: (a.evidence as unknown[] | undefined) || [],
      created_at: a.created_at ?? null,
      embedding: vector ? vector.map(round6) : null,
    };
  });
  const config = (row.embedding_config as Json | null) ?? {};
  return {
    id: row.id,
    status: row.status,
    created_at: pyIso(row.created_at as string | null),
    completed_at: pyIso(row.completed_at as string | null),
    recipe_version: row.recipe_version ?? null,
    source_fingerprint: row.source_fingerprint ?? null,
    embedding: { model: config.model ?? null, dims: config.dims ?? null, key: config.key ?? null },
    stats: (manifest.stats as Json | undefined) || {},
    conversations: (manifest.conversations as unknown[] | undefined) || [],
    arguments: shaped,
    missing_embeddings: missing,
  };
}

/** A v2 row in the v1 result shape, for readers of the project state that predate the graph payload. */
export async function snapshotResultPayload(d: MapDeps, row: Row): Promise<Json> {
  const store = d.rt.store;
  const snapshot = await store.getSnapshot(String((row.manifest as Json).snapshotId));
  const objects = snapshot ? ((snapshot.manifest.objects as Json[] | undefined) ?? []) : [];
  const kind = objects.some((o) => o.type === "deduplicated_argument")
    ? "deduplicated_argument"
    : "argument";
  const ids = objects.filter((o) => o.type === kind).map((o) => String(o.revisionId));
  const projectId = String(row.project_id);
  const revisions = snapshot
    ? await store.getRevisions(projectId, ids)
    : new Map<string, ObjectRevision>();
  const config = snapshot?.embeddingConfig ?? {};
  const vectors = await loadVectors(projectId, revisions.values(), config, store);
  const shaped: Json[] = [];
  for (const id of ids) {
    const r = revisions.get(id);
    if (!r) continue;
    const claim = claimOf(r);
    const vector = vectors.get(id) ?? null;
    const evidence = (r.payload.evidence as Json[] | undefined) ?? [];
    const created = evidence.filter((e) => e.createdAt).map((e) => String(e.createdAt));
    shaped.push({
      id,
      statement: r.payload.statement,
      kind: r.payload.epistemicKind,
      valence: r.payload.valence ?? null,
      claim_key: claim ? claim[2] : null,
      evidence: evidence.map((item) => ({
        conversation_id: item.conversationId ?? null,
        label: item.label || "",
        created_at: item.createdAt ?? null,
        quotes: (item.quotes as unknown[] | undefined) || [],
      })),
      created_at: created.length ? created.reduce((a, b) => (a >= b ? a : b)) : null,
      embedding: vector ? vector.map(round6) : null,
    });
  }
  return {
    id: row.id,
    status: row.status,
    created_at: pyIso(row.created_at as string | null),
    completed_at: pyIso(row.completed_at as string | null),
    recipe_version: row.recipe_version ?? null,
    source_fingerprint: row.source_fingerprint ?? null,
    embedding: { model: config.model ?? null, dims: config.dims ?? null, key: config.key ?? null },
    stats: { arguments: shaped.length },
    conversations: [],
    arguments: shaped,
    missing_embeddings: shaped.filter((a) => a.embedding === null).map((a) => a.id),
    snapshot_id: snapshot ? snapshot.id : null,
  };
}

async function argumentsRun(d: MapDeps, projectId: string): Promise<Run | null> {
  const scope = await d.rt.store.findScope({
    projectId,
    kind: "producer",
    ownerId: ARGUMENTS_RECIPE_ID,
    scopeKey: VIEW_SCOPE_KEY,
  });
  if (!scope) return null;
  return d.rt.store.latestRun(scope.id, ["queued", "waiting_for_inputs", "running", "failed"]);
}

/** Orders two Postgres timestamps to the microsecond, as the Python compared datetimes. */
export const compareTimestamps = (a: unknown, b: unknown) =>
  micros(typeof a === "string" ? a : null) - micros(typeof b === "string" ? b : null);

/** The current ready revision, and an attempt newer than it (a v1 attempt, or the latest arguments run). */
export async function projectRows(
  d: MapDeps,
  projectId: string,
): Promise<[Row | null, Row | null]> {
  await d.store.expireStale(projectId, STALE_ATTEMPT_SECONDS);
  const current = await d.store.latestReady(projectId);
  const latest = await d.store.latestAttempt(projectId);
  let attempt: Row | null = null;
  if (
    latest &&
    [...ACTIVE_STATUSES, "failed"].includes(String(latest.status)) &&
    (!current || compareTimestamps(latest.created_at, current.created_at) > 0)
  )
    attempt = latest;
  if (!(attempt && ACTIVE_STATUSES.includes(String(attempt.status)))) {
    let run: Row | null = null;
    try {
      run = runAttempt(await argumentsRun(d, projectId));
    } catch (err) {
      // The attempt is a hint beside the saved map, like the source count.
      if (!(err instanceof AnalysisStoreError)) throw err;
    }
    const newer =
      run !== null && (!current || compareTimestamps(run.created_at, current.created_at) > 0);
    if (run && newer && (attempt === null || run.status !== "failed")) attempt = run;
  }
  return [current, attempt];
}

export async function statePayload(
  d: MapDeps,
  current: Row | null,
  attempt: Row | null,
  metadataOnly: boolean,
): Promise<Json> {
  let shaped: Json | null;
  if (current && metadataOnly) {
    const manifest = (current.manifest as Json | null) ?? {};
    const config = (current.embedding_config as Json | null) ?? {};
    shaped = {
      id: current.id,
      status: current.status,
      created_at: pyIso(current.created_at as string | null),
      completed_at: pyIso(current.completed_at as string | null),
      recipe_version: current.recipe_version ?? null,
      source_fingerprint: current.source_fingerprint ?? null,
      snapshot_id: manifest.snapshotId ?? null,
      metadata_only: true,
      embedding: {
        model: config.model ?? null,
        dims: config.dims ?? null,
        key: config.key ?? null,
      },
      stats: (manifest.stats as Json | undefined) || {},
      conversations: [],
      arguments: [],
      missing_embeddings: [],
    };
  } else if (current && isV2Manifest(current.manifest))
    shaped = await snapshotResultPayload(d, current);
  else shaped = current ? await resultPayload(d, current) : null;
  return { current: shaped, attempt: attemptPayload(attempt) };
}

/** Names everything the project map response is built from. */
export function stateEtag(
  current: Row | null,
  attempt: Row | null,
  conversations: number | null,
): string {
  const parts = [
    String(MANIFEST_VERSION),
    `${current?.id ?? "None"}:${pyIso((current?.completed_at as string | null) ?? null) ?? "None"}`,
    `${attempt?.id ?? "None"}:${attempt?.status ?? "None"}:${pyIso((attempt?.updated_at as string | null) ?? null) ?? "None"}`,
    conversations === null ? "None" : String(conversations),
  ];
  const digest = new Bun.CryptoHasher("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
  return `W/"map-${digest}"`;
}

/**
 * Starts a generation, or returns the one already running: a v1 attempt still running
 * first, else a refresh of the arguments recipe (null when its ready output already
 * answers the current transcripts).
 */
export async function requestGeneration(
  d: MapDeps,
  projectId: string,
  requestedBy: string | null,
): Promise<Row | null> {
  await d.store.expireStale(projectId, STALE_ATTEMPT_SECONDS);
  const active = await d.store.activeAttempt(projectId);
  if (active) return active;
  const outcome = await requestRun(
    {
      projectId,
      recipeId: ARGUMENTS_RECIPE_ID,
      scopeKey: VIEW_SCOPE_KEY,
      mode: "refresh",
      requestedBy,
    },
    d.rt.executor,
  );
  await d.rt.publishMap(projectId, {
    type: "queued",
    run_id: outcome.run.id,
    outcome: outcome.outcome,
  });
  return runAttempt(outcome.run);
}

/** What a result id names: a v1 row, or a map snapshot (by its v2 row or by its own id). */
export async function resolveTarget(d: MapDeps, resultId: string): Promise<Target | null> {
  const row = await d.store.getResult(resultId);
  if (row) {
    const manifest = row.manifest;
    if (!isV2Manifest(manifest)) return { kind: "row", row };
    const snapshot = await d.rt.store.getSnapshot(String((manifest as Json).snapshotId));
    if (!snapshot || snapshot.projectId !== row.project_id) return null;
    return { kind: "snapshot", snapshot, resultId: String(row.id) };
  }
  const snapshot = await d.rt.store.getSnapshot(resultId);
  if (!snapshot || (snapshot.viewId !== MAP_VIEW_ID && snapshot.viewId !== LEGACY_VIEW_ID))
    return null;
  return { kind: "snapshot", snapshot, resultId: null };
}

function ready(row: Row): Json {
  if (row.status !== "ready") throw new NotReady();
  return (row.manifest as Json | null) ?? {};
}

// ── selection titles ────────────────────────────────────────────────────

export const TITLE_CACHE_MS = 7 * 24 * 3600 * 1000;

/**
 * One title per cache key, generated once. The Python kept these in Redis across the
 * deployment; here each API instance keeps its own (a second instance may pay for one
 * more title per selection, never a different answer for the same key within one).
 */
export class TitleCache {
  private readonly titles = new Map<string, { title: string; until: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  constructor(private readonly now: () => number = Date.now) {}

  async once(
    key: string,
    produce: () => Promise<string>,
  ): Promise<{ title: string; cached: boolean }> {
    const hit = this.titles.get(key);
    if (hit && hit.until > this.now()) return { title: hit.title, cached: true };
    const running = this.inflight.get(key);
    if (running) return { title: await running, cached: true };
    const p = produce();
    this.inflight.set(key, p);
    try {
      const title = await p;
      this.titles.set(key, { title, until: this.now() + TITLE_CACHE_MS });
      return { title, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}

const RELATION_PHRASES: Record<string, string> = {
  supports_pole_a: "supports pole A of",
  supports_pole_b: "supports pole B of",
  holds_position: "holds the position in",
  affected_by: "is affected by",
  stakeholder_relation: "is related to",
  derived_from: "is derived from",
};

function titleText(r: ObjectRevision): string {
  const p = r.payload;
  if (r.type === "tension") return `${p.poleA} / ${p.poleB}: ${p.knot}`;
  if (r.type === "stakeholder") return `${p.name} (${p.role}): ${p.stake}`;
  return labelOf(r);
}

/** One tagged line per selected revision, naming every explicit relation inside the selection. */
export function typedTitleLines(
  revisions: readonly ObjectRevision[],
  verdicts: Readonly<Record<string, string | null>>,
  relations: readonly Json[],
): string[] {
  const numbers = new Map(revisions.map((r, i) => [r.id, i + 1]));
  const notes = new Map<string, string[]>();
  for (const relation of relations) {
    const start = String(relation.from);
    const end = String(relation.to);
    if (numbers.has(start) && numbers.has(end)) {
      const phrase =
        RELATION_PHRASES[String(relation.type)] ?? String(relation.type).replaceAll("_", " ");
      const list = notes.get(start) ?? [];
      list.push(`${phrase} ${numbers.get(end)}`);
      notes.set(start, list);
    }
  }
  const lines = revisions.map((r, i) => {
    const prefix = r.type === "deduplicated_argument" ? "deduplicated " : "";
    let tag: string[];
    if (claimOf(r)) tag = [`${prefix}claim`, verdicts[r.id] || "unverified"];
    else if (ARGUMENT_TYPES.has(r.type)) tag = [`${prefix}argument`];
    else tag = [r.type.replaceAll("_", " ")];
    return `${i + 1}. [${[...tag, ...(notes.get(r.id) ?? [])].join(", ")}] ${titleText(r)}`;
  });
  const total = lines.reduce((n, l) => n + [...l].length + 1, 0);
  if (lines.length < MIN_TITLE_NODES)
    throw new SelectionTooSmall(`a title needs at least ${MIN_TITLE_NODES} objects`);
  if (total > MAX_TITLE_CHARS)
    throw new SelectionTooLarge(
      `the selection is ${total} characters; the limit is ${MAX_TITLE_CHARS}`,
    );
  return lines;
}

export interface TitleDeps extends MapDeps {
  readonly cache: TitleCache;
  readonly modelIdentity: string;
  readonly generate: (
    lines: string[],
    projectName: string,
    projectContext: string,
  ) => Promise<string>;
}

export const TITLE_PROMPT = "map-title-v2";

export async function selectionTitle(
  d: TitleDeps,
  row: Row,
  nodeIds: readonly string[],
  project: [string, string],
): Promise<Json> {
  const manifest = ready(row);
  const byId = new Map(
    ((manifest.arguments as Json[] | undefined) ?? []).map((a) => [String(a.id), a]),
  );
  const ordered = [...new Set(nodeIds)];
  const unknown = ordered.filter((id) => !byId.has(id));
  if (unknown.length)
    throw new UnknownArguments(`${unknown.length} selected arguments are not in this map`);
  const selected = ordered.map((id) => byId.get(id) as Json);
  const claimKeys = selected.filter((a) => a.claim_key).map((a) => String(a.claim_key));
  const checks = await d.store.factChecksFor(String(row.project_id), claimKeys);
  const verdicts: Record<string, string | null> = {};
  for (const [key, check] of checks)
    if (check.status === "done") verdicts[key] = (check.verdict as string | null) ?? null;
  const lines = titleLines(selected, verdicts);
  const verdictState = sortedStrings(Object.keys(verdicts))
    .map((k) => `${k}=${verdicts[k] || "unverified"}`)
    .join(",");
  const config = `${TITLE_PROMPT}|${d.modelIdentity}|${verdictState}`;
  const key = `map:title:${titleSelectionKey(String(row.id), ordered, config)}`;
  return d.cache.once(key, () => d.generate(lines, project[0], project[1]));
}

export async function snapshotSelectionTitle(
  d: TitleDeps,
  target: SnapshotTarget,
  revisionIds: readonly string[],
  project: [string, string],
): Promise<Json> {
  const snapshot = target.snapshot;
  const manifest = snapshot.manifest;
  const ordered = [...new Set(revisionIds)];
  const displayed = new Set(
    ((manifest.objects as Json[] | undefined) ?? []).map((o) => String(o.revisionId)),
  );
  const unknown = ordered.filter((id) => !displayed.has(id));
  if (unknown.length)
    throw new UnknownArguments(`${unknown.length} selected objects are not in this map`);
  const revisions = await d.rt.store.getRevisions(snapshot.projectId, ordered);
  if (revisions.size !== ordered.length)
    throw new UnknownArguments(
      `${ordered.length - revisions.size} selected objects are no longer available`,
    );
  const selected = new Set(ordered);
  const pinned = new Map<string, string>();
  for (const a of (manifest.assessments as Json[] | undefined) ?? [])
    if (selected.has(String(a.targetRevisionId)))
      pinned.set(String(a.targetRevisionId), String(a.revisionId));
  const assessments = pinned.size
    ? await d.rt.store.getRevisions(snapshot.projectId, sortedStrings(new Set(pinned.values())))
    : new Map<string, ObjectRevision>();
  const verdicts: Record<string, string | null> = {};
  for (const [target_, aid] of pinned) {
    const a = assessments.get(aid);
    if (a) verdicts[target_] = (a.payload.verdict as string | null) ?? null;
  }
  const relations = ((manifest.relations as Json[] | undefined) ?? []).filter(
    (r) => selected.has(String(r.from)) && selected.has(String(r.to)),
  );
  const lines = typedTitleLines(
    ordered.map((id) => revisions.get(id) as ObjectRevision),
    verdicts,
    relations,
  );
  const config = `${TITLE_PROMPT}|${d.modelIdentity}|${sortedStrings(pinned.values()).join(",")}`;
  const key = `map:title:v2:${titleSelectionKey(snapshot.id, ordered, config)}`;
  return d.cache.once(key, () => d.generate(lines, project[0], project[1]));
}

// ── fact-checks ─────────────────────────────────────────────────────────

/** The FactCheckState shape, from a stored row. */
export function factCheckState(row: Row | null): Json {
  if (!row) return { status: "idle" };
  const status = row.status;
  if (status === "processing")
    return { status: "processing", startedAt: pyIso(row.started_at as string | null) };
  if (status === "done")
    return {
      status: "done",
      verdict: row.verdict || "unknown",
      justification: row.justification || "",
      sources: row.sources || [],
      checkedAt: pyIso(row.completed_at as string | null),
    };
  if (status === "error")
    return {
      status: "error",
      message: row.error || "The fact-check failed.",
      at: pyIso(((row.completed_at || row.updated_at) as string | null) ?? null),
    };
  return { status: "idle" };
}

/** A pinned assessment revision in the FactCheckState shape. */
export function assessmentState(a: ObjectRevision): Json {
  return {
    status: "done",
    verdict: a.payload.verdict || "unknown",
    justification: a.payload.justification || "",
    sources: a.payload.sources || [],
    checkedAt: pyIso(a.publishedAt || a.createdAt),
    assessmentRevisionId: a.id,
  };
}

export async function factCheckStates(d: MapDeps, row: Row): Promise<Json> {
  const manifest = ready(row);
  const claims = ((manifest.arguments as Json[] | undefined) ?? []).filter((a) => a.claim_key);
  const stored = await d.store.factChecksFor(
    String(row.project_id),
    claims.map((a) => String(a.claim_key)),
  );
  return Object.fromEntries(
    claims.map((a) => [String(a.id), factCheckState(stored.get(String(a.claim_key)) ?? null)]),
  );
}

/** States by revision id; a check in progress shows as such, otherwise the pinned assessment wins. */
export async function snapshotFactCheckStates(d: MapDeps, target: SnapshotTarget): Promise<Json> {
  const snapshot = target.snapshot;
  const manifest = snapshot.manifest;
  const ids = ((manifest.objects as Json[] | undefined) ?? [])
    .filter((o) => ARGUMENT_TYPES.has(String(o.type)))
    .map((o) => String(o.revisionId));
  const revisions = ids.length ? await d.rt.store.getRevisions(snapshot.projectId, ids) : new Map();
  const claims = new Map<string, [string, string[], string]>();
  for (const id of ids) {
    const r = revisions.get(id);
    const claim = r ? claimOf(r) : null;
    if (claim) claims.set(id, claim);
  }
  const operational = await d.store.factChecksFor(
    snapshot.projectId,
    sortedStrings(new Set([...claims.values()].map((c) => c[2]))),
  );
  const pinned = new Map(
    ((manifest.assessments as Json[] | undefined) ?? []).map((a) => [
      String(a.targetRevisionId),
      String(a.revisionId),
    ]),
  );
  const wanted = sortedStrings(
    new Set(
      [...claims.keys()].filter((id) => pinned.has(id)).map((id) => pinned.get(id) as string),
    ),
  );
  const assessments = wanted.length
    ? await d.rt.store.getRevisions(snapshot.projectId, wanted)
    : new Map();
  const out: Json = {};
  for (const [id, claim] of claims) {
    let state = factCheckState(operational.get(claim[2]) ?? null);
    const a = assessments.get(pinned.get(id) ?? "");
    if (a && state.status !== "processing") state = assessmentState(a);
    out[id] = state;
  }
  return out;
}

function v1Claim(row: Row, nodeId: string): Json {
  const manifest = ready(row);
  for (const a of (manifest.arguments as Json[] | undefined) ?? []) {
    if (a.id === nodeId) {
      if (a.kind !== "claim" || !a.claim_key) throw new NotAClaim("only claims are fact-checked");
      return a;
    }
  }
  throw new UnknownArguments("the argument is not in this map");
}

async function snapshotClaim(d: MapDeps, target: SnapshotTarget, revisionId: string) {
  const revision = await snapshotRevision(target.snapshot, revisionId, d.rt.store);
  if (!revision) throw new UnknownArguments("the object is not in this map");
  const claim = claimOf(revision);
  if (!claim) throw new NotAClaim("only claims are fact-checked");
  return claim;
}

export interface FactCheckDeps extends MapDeps {
  /** Hands one attempt to a worker; one workflow per (check, attempt). */
  readonly dispatch: (job: {
    factCheckId: string;
    attempt: number;
    resultId: string;
    nodeId: string;
  }) => Promise<unknown>;
}

async function start(
  d: FactCheckDeps,
  o: {
    projectId: string;
    claimKey: string;
    statement: string;
    job: [string, string];
    requestedBy: string | null;
    force: boolean;
  },
): Promise<Json> {
  const [check, shouldDispatch] = await d.store.startFactCheck({
    projectId: o.projectId,
    claimKey: o.claimKey,
    statement: o.statement,
    requestedBy: o.requestedBy,
    force: o.force,
    staleSeconds: FACT_CHECK_STALE_SECONDS,
  });
  if (shouldDispatch) {
    try {
      await d.dispatch({
        factCheckId: String(check.id),
        attempt: Number(check.attempt),
        resultId: o.job[0],
        nodeId: o.job[1],
      });
    } catch (err) {
      await d.store.failFactCheck(
        String(check.id),
        Number(check.attempt),
        "The fact-check could not be started.",
      );
      throw err;
    }
    await d.rt.publishMap(o.projectId, { type: "fact_check", claim_key: o.claimKey });
  }
  return factCheckState(check);
}

export async function startFactCheck(
  d: FactCheckDeps,
  target: Target,
  nodeId: string,
  requestedBy: string | null,
  force: boolean,
) {
  if (target.kind === "row") {
    const a = v1Claim(target.row, nodeId);
    return start(d, {
      projectId: String(target.row.project_id),
      claimKey: String(a.claim_key),
      statement: String(a.statement),
      job: [String(target.row.id), nodeId],
      requestedBy,
      force,
    });
  }
  const [statement, , key] = await snapshotClaim(d, target, nodeId);
  return start(d, {
    projectId: target.snapshot.projectId,
    claimKey: key,
    statement,
    job: [target.snapshot.id, nodeId],
    requestedBy,
    force,
  });
}

export async function cancelFactCheck(d: MapDeps, target: Target, nodeId: string) {
  const projectId = targetProject(target);
  const key =
    target.kind === "row"
      ? String(v1Claim(target.row, nodeId).claim_key)
      : (await snapshotClaim(d, target, nodeId))[2];
  const check = await d.store.cancelFactCheck(projectId, key);
  await d.rt.publishMap(projectId, { type: "fact_check", claim_key: key });
  return factCheckState(check);
}
