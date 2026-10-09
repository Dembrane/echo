import {
  type AnalysisRuntime,
  AnalysisStoreError,
  BudgetError,
  type Ceilings,
  currentMapSnapshot,
  graphPayload,
  legacyGraphPayload,
  MapViewReads,
  micros,
  type ResolvedBudgets,
  type ResultLink,
  resolveBudgets,
  type Snapshot,
} from "@dembrane/analysis";
import { NotFoundError, UnavailableError, ValidationError } from "@dembrane/core";
import {
  assessmentState,
  factCheckStates,
  groupDoc,
  type MapStore as MapRows,
  MapStoreError,
  requestGeneration,
} from "@dembrane/map";
import { dict, isRecord, type Json, list, pyStr, type Row } from "@dembrane/popcorn";

/**
 * The map a presentation shows the room: the audience projection (sanitize_map and the
 * rules around it) over the graph @dembrane/analysis draws, and the seam to the stores.
 * `MapStore` is everything Present needs from them; `analysisMapStore` answers it from the
 * analysis runtime and Map's own rows, as present.py did from SqlAnalysisStore and
 * SqlMapStore. A store failure answers 503, as the host's graph endpoint does.
 */

export interface GraphAndChecks {
  readonly payload: Json;
  readonly factChecks: Json;
}

export interface MapStore {
  snapshot(id: string): Promise<Snapshot | null>;
  /** The map view's current snapshot, never advanced by an audience read. */
  currentSnapshot(projectId: string): Promise<Snapshot | null>;
  /** Ready v1 results of the project, oldest first. */
  legacyResults(projectId: string): Promise<ResultLink[]>;
  /** A snapshot's graph, with the assessments pinned to exactly its revisions. */
  graph(snapshot: Snapshot, budgets: ResolvedBudgets): Promise<GraphAndChecks>;
  /** A legacy result's graph with its fact-check states; null when the row is gone. */
  legacyGraph(resultId: string, budgets: ResolvedBudgets): Promise<GraphAndChecks | null>;
  /** Starts a map generation for the project, as the host's Generate does. */
  requestGeneration(projectId: string, actorId: string | null): Promise<void>;
  /** The project's groups as stored, newest first: the host map's History. */
  groups(projectId: string): Promise<Row[]>;
  /** The deployment's budget ceilings (ANALYSIS_NODE_LIMIT_CEILING and the edge one). */
  readonly ceilings: Ceilings;
}

export function analysisMapStore(rt: AnalysisRuntime, rows: MapRows, ceilings: Ceilings): MapStore {
  const store = rt.store;
  const reads = new MapViewReads(store);
  const deps = { store: rows, rt };
  const query = (budgets: ResolvedBudgets) => ({ types: null, scope: null, budgets });
  return {
    ceilings,
    snapshot: (id) => store.getSnapshot(id),
    currentSnapshot: (projectId) =>
      currentMapSnapshot(projectId, store, reads, { follow: false, publish: rt.publishMap }),
    legacyResults: (projectId) => reads.legacyResults(projectId),
    async graph(snapshot, budgets) {
      const payload = await graphPayload(snapshot, query(budgets), store);
      // Only the assessments pinned to these exact revisions: no cold cache or audience
      // interaction can start a factual check.
      const pinned = new Map(
        list(snapshot.manifest.assessments)
          .map(dict)
          .map((a) => [pyStr(a.targetRevisionId), pyStr(a.revisionId)] as const),
      );
      const assessments = pinned.size
        ? await store.getRevisions(snapshot.projectId, [...new Set(pinned.values())])
        : new Map();
      const factChecks: Json = {};
      for (const [target, rid] of pinned) {
        const a = assessments.get(rid);
        if (a) factChecks[target] = assessmentState(a);
      }
      return { payload, factChecks };
    },
    async legacyGraph(resultId, budgets) {
      const row = await rows.getResult(resultId);
      if (!row) return null;
      return {
        payload: await legacyGraphPayload(row, query(budgets), store),
        factChecks: await factCheckStates(deps, row),
      };
    },
    async requestGeneration(projectId, actorId) {
      await requestGeneration(deps, projectId, actorId);
    },
    groups: (projectId) => rows.listGroups(projectId),
  };
}

/** resolve_budgets with the deployment's ceilings; a bad value answers 422. */
export function audienceBudgets(
  nodeLimit: number | null,
  edgeLimit: number | null,
  ceilings: Ceilings,
): ResolvedBudgets {
  try {
    return resolveBudgets(nodeLimit, edgeLimit, ceilings);
  } catch (err) {
    if (err instanceof BudgetError)
      throw new ValidationError("map.invalid_request", { message: err.message });
    throw err;
  }
}

// ── the audience projection ─────────────────────────────────────────

/** One detail's evidence documents, whichever shape carried them. */
function evidenceOf(detail: unknown): Json[] {
  const d = dict(detail);
  if (Array.isArray(d.evidence))
    return d.evidence.filter(
      (item): item is Json => isRecord(item) && Boolean(item.conversationId),
    );
  if (Array.isArray(d.quotes)) {
    const grouped = new Map<string, string[]>();
    for (const quote of d.quotes)
      if (isRecord(quote) && quote.conversationId && quote.text) {
        const cid = pyStr(quote.conversationId);
        grouped.set(cid, [...(grouped.get(cid) ?? []), pyStr(quote.text)]);
      }
    return [...grouped].map(([conversationId, quotes]) => ({ conversationId, quotes }));
  }
  return [];
}

/** The member documents of a deduplicated argument, or nothing. */
function memberDetails(detail: unknown): Json[] {
  const consolidation = dict(detail).consolidation;
  const members = isRecord(consolidation) ? consolidation.members : null;
  return list(members).filter(isRecord);
}

/** The conversations behind one node, one entry per contributing member. */
function nodeConversations(node: Json): string[] {
  const named = (evidence: Json[]) => evidence.map((item) => pyStr(item.conversationId));
  const detail = dict(node.detail);
  const members = memberDetails(detail);
  if (members.length) return members.flatMap((m) => named(evidenceOf(m)));
  return named(evidenceOf(detail));
}

/** Evidence as the room may read it: quotes under a palette slot, nothing traceable. */
function audienceEvidence(evidence: Json[], slotOf: Map<string, number>): Json[] {
  const grouped = new Map<number, string[]>();
  for (const item of evidence) {
    const slot = slotOf.get(pyStr(item.conversationId));
    if (slot === undefined) continue;
    const quotes = list(item.quotes).filter((q): q is string => typeof q === "string" && q !== "");
    grouped.set(slot, [...(grouped.get(slot) ?? []), ...quotes]);
  }
  return [...grouped]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, quotes]) => ({ conversation: slot, quotes }));
}

function slotMap(
  payload: Json,
  order: readonly string[],
): [Map<string, number>, Map<string, number[]>] {
  const slotOf = new Map<string, number>(order.map((cid, i) => [pyStr(cid), i]));
  const slots = new Map<string, number[]>();
  for (const node of list(payload.nodes).map(dict)) {
    const found: number[] = [];
    for (const cid of nodeConversations(node)) {
      if (!slotOf.has(cid)) slotOf.set(cid, slotOf.size);
      found.push(slotOf.get(cid) as number);
    }
    slots.set(
      pyStr(node.revisionId ?? null),
      found.sort((a, b) => a - b),
    );
  }
  return [slotOf, slots];
}

/** A palette slot per conversation, per node: the deck's own marker order. */
export function conversationSlots(payload: Json, order: readonly string[]): Json {
  return Object.fromEntries(slotMap(payload, order)[1]);
}

/** The explicit audience projection: the evidence, never its sources. */
export function sanitizeMap(
  payload: Json,
  order: readonly string[] = [],
  names: Record<string, string> | null = null,
): Json {
  const [slotOf, slots] = slotMap(payload, order);
  const nodes: Json[] = [];
  for (const node of list(payload.nodes).map(dict)) {
    const detail = dict(node.detail);
    const consolidation = dict(detail.consolidation);
    const projected: Json = {};
    const memberCount = consolidation.memberCount;
    if (memberCount) {
      const merged: Json = { memberCount };
      const members = memberDetails(detail).map((m) => ({
        statement: m.statement ? pyStr(m.statement) : "",
        evidence: audienceEvidence(evidenceOf(m), slotOf),
      }));
      // A lineage read only in part would count members the room cannot see.
      if (members.length && members.length === memberCount) merged.members = members;
      projected.consolidation = merged;
    }
    const evidence = audienceEvidence(evidenceOf(detail), slotOf);
    if (evidence.length) projected.evidence = evidence;
    nodes.push({
      objectId: node.objectId ?? null,
      revisionId: node.revisionId ?? null,
      type: node.type ?? null,
      label: node.label ?? null,
      embedding: node.embedding ?? null,
      attributes: node.attributes ?? null,
      detail: projected,
      conversations: slots.get(pyStr(node.revisionId ?? null)) ?? [],
      provenance: {},
      factCheck: { eligible: false },
    });
  }
  const conversationNames: Json = {};
  if (names)
    for (const [cid, slot] of slotOf) {
      const name = (names[cid] ?? "").trim();
      if (name) conversationNames[String(slot)] = name;
    }
  const snapshot = dict(payload.snapshot);
  const out: Json = { conversationNames };
  for (const k of ["version", "budgets", "counts", "scope", "overBudget", "embedding", "unplaced"])
    out[k] = payload[k] ?? null;
  out.snapshot = { id: snapshot.id ?? null, createdAt: snapshot.createdAt ?? null };
  out.nodes = nodes;
  // No semantic relations are implied by the audience's spatial layout.
  out.relations = [];
  out.related = [];
  return out;
}

/** `payload` without the hidden objects' nodes and what only they carried. */
export function withoutNodes(payload: Json, hidden: ReadonlySet<string>): Json {
  if (!hidden.size) return payload;
  const nodes = list(payload.nodes)
    .map(dict)
    .filter((n) => !hidden.has(n.objectId as string));
  const visible = new Set(nodes.map((n) => n.revisionId));
  const projected: Json = {
    ...payload,
    nodes,
    unplaced: list(payload.unplaced).filter((rid) => visible.has(rid)),
  };
  if (isRecord(payload.conversationNames)) {
    const standing = new Set(nodes.flatMap((n) => list(n.conversations).map((s) => pyStr(s))));
    projected.conversationNames = Object.fromEntries(
      Object.entries(payload.conversationNames).filter(([slot]) => standing.has(slot)),
    );
  }
  if ("fact_checks" in payload)
    projected.fact_checks = Object.fromEntries(
      Object.entries(dict(payload.fact_checks)).filter(([rid]) => visible.has(rid)),
    );
  return projected;
}

export function audienceAssessments(states: Json, graph: Json): Json {
  const visible = new Set(list(graph.nodes).map((n) => dict(n).revisionId));
  const out: Json = {};
  for (const [rid, raw] of Object.entries(states)) {
    const state = dict(raw);
    if (
      visible.has(rid) &&
      state.status === "done" &&
      ["true", "false", "contested", "unknown"].includes(state.verdict as string)
    )
      out[rid] = {
        status: "done",
        verdict: state.verdict,
        justification: state.justification ? pyStr(state.justification) : "",
        checkedAt: state.checkedAt ?? null,
        sources: [],
      };
  }
  return out;
}

function hiddenItems(settings: Json | null): string[] {
  return list(dict(dict(settings).presentation).hidden_items).map((x) => pyStr(x));
}

function curateMap(payload: Json, settings: Json | null): Json {
  return withoutNodes(payload, new Set(hiddenItems(settings)));
}

const AUDIENCE_GROUP_STATUSES = new Set(["ready", "pending", "failed"]);

/**
 * The project's groups as the room may read them: the host map's History, read-only. A
 * group stays out when any of its members is an object the room is not shown, because
 * its title was written over that member. Never who made a group, nor why one failed.
 */
export function audienceGroups(rows: readonly Row[], hidden: ReadonlySet<string>): Json[] {
  const groups: Json[] = [];
  for (const row of rows) {
    if (!AUDIENCE_GROUP_STATUSES.has(String(row.status))) continue;
    const members = list(row.members)
      .filter(isRecord)
      .map((m) => ({
        revisionId: m.revisionId ? pyStr(m.revisionId) : null,
        objectId: m.objectId ? pyStr(m.objectId) : null,
        type: m.type ? pyStr(m.type) : null,
      }))
      .filter((m) => m.revisionId !== null);
    if (!members.length || members.some((m) => m.objectId !== null && hidden.has(m.objectId)))
      continue;
    const doc = groupDoc(row);
    groups.push({
      id: doc.id,
      status: doc.status,
      title: doc.status === "ready" ? (doc.title ?? null) : null,
      error: null,
      members,
      snapshotId: doc.snapshotId ?? null,
      createdAt: doc.createdAt ?? null,
    });
  }
  return groups;
}

export interface AudienceMapArgs {
  readonly projectId: string;
  readonly settings: Json | null;
  readonly nodeLimit: number | null;
  readonly edgeLimit: number | null;
  /** The popcorn session's conversation order and legend names, from its state. */
  readonly legend: { order: string[]; names: Record<string, string> };
  readonly excluded: () => Promise<Set<string>>;
}

/**
 * audience_map: the bound or current map snapshot, or a newer legacy result, projected for
 * the room. Audience reads never advance a snapshot or start processing.
 */
export async function audienceMap(store: MapStore, a: AudienceMapArgs): Promise<Json> {
  const budgets = audienceBudgets(a.nodeLimit, a.edgeLimit, store.ceilings);
  try {
    const names = dict(a.settings).public_labels === "names" ? a.legend.names : null;
    const bound = dict(dict(dict(a.settings).presentation).result_bindings).map;
    const snapshot = bound
      ? await store.snapshot(pyStr(bound))
      : await store.currentSnapshot(a.projectId);
    if (snapshot && snapshot.projectId !== a.projectId)
      throw new NotFoundError("present.map_results_unavailable");
    const legacy = (await store.legacyResults(a.projectId)).filter((l) => !l.snapshotId);
    const newest = legacy.at(-1);
    const project = async ({ payload, factChecks }: GraphAndChecks) => {
      const projected = curateMap(sanitizeMap(payload, a.legend.order, names), a.settings);
      projected.fact_checks = audienceAssessments(factChecks, projected);
      const excluded = await a.excluded();
      const shown = withoutNodes(projected, excluded);
      shown.groups = audienceGroups(
        await store.groups(a.projectId),
        new Set([...hiddenItems(a.settings), ...excluded]),
      );
      return shown;
    };
    if (
      !bound &&
      newest &&
      (snapshot === null ||
        (newest.createdAt &&
          snapshot.createdAt &&
          micros(newest.createdAt) > micros(snapshot.createdAt)))
    ) {
      const drawn = await store.legacyGraph(newest.id, budgets);
      if (drawn) return await project(drawn);
    }
    if (snapshot) return await project(await store.graph(snapshot, budgets));
  } catch (err) {
    // The host's graph endpoint answers a store failure with 503; the room gets the same,
    // and keeps what it shows until the store is back.
    if (err instanceof MapStoreError || err instanceof AnalysisStoreError)
      throw new UnavailableError("map.storage_unavailable");
    throw err;
  }
  throw new NotFoundError("present.map_results_not_ready");
}

export type { Row };
