import { NotFoundError, UnavailableError, ValidationError } from "@echo/core";
import { dict, directusTime, isRecord, type Json, list, pyStr, type Row, type Sql } from "@echo/popcorn";

/**
 * The map a presentation shows the room, and the seam to the map store.
 *
 * The audience projection (sanitize_map and the rules around it) is pure and ported whole.
 * Drawing a map graph from a snapshot or a legacy result, reading its fact checks and
 * requesting a new map belong to @echo/analysis and @echo/map, which are on port/analysis.
 * `MapStore` is everything Present needs from them. `sqlMapStore` answers the plain reads
 * (which snapshot or legacy result exists) directly, so a project with no map answers
 * exactly as before; where a graph would have to be drawn it answers the way the Python
 * answered when its map store was unavailable (503). Next: implement `graph`, `legacyGraph`
 * and `requestGeneration` with @echo/map once port/analysis lands; nothing else changes.
 */

export interface MapSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string | null;
  readonly manifest: Json;
}

export interface LegacyResult {
  readonly id: string;
  readonly createdAt: string | null;
  readonly snapshotId: string | null;
}

export interface Budgets {
  readonly nodeLimit: number;
  readonly edgeLimit: number;
}

export interface MapStore {
  snapshot(id: string): Promise<MapSnapshot | null>;
  /** The map view's current snapshot, never advanced by an audience read. */
  currentSnapshot(projectId: string): Promise<MapSnapshot | null>;
  /** Ready v1 results of the project, oldest first. */
  legacyResults(projectId: string): Promise<LegacyResult[]>;
  /** The host payload of a snapshot's graph, with the fact-check states pinned to it. */
  graph(snapshot: MapSnapshot, budgets: Budgets): Promise<{ payload: Json; factChecks: Json }>;
  /** The host payload of a legacy result's graph, with its fact-check states. */
  legacyGraph(resultId: string, budgets: Budgets): Promise<{ payload: Json; factChecks: Json }>;
  /** Starts a map generation for the project, as the host's Generate does. */
  requestGeneration(projectId: string, actorId: string): Promise<void>;
}

/** The map store is unreachable (or, on this branch, not ported): the room keeps its screen. */
export class MapUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAP_VIEW_ID = "map";
const VIEW_SCOPE_KEY = "project";
const iso = (v: unknown) => directusTime(v);

export function sqlMapStore(sql: Sql): MapStore {
  const snapshot = async (id: string): Promise<MapSnapshot | null> => {
    if (!UUID.test(id)) return null;
    const [r] =
      await sql`select id, project_id, created_at, manifest from analysis_snapshot where id = ${id}`;
    return r
      ? {
          id: String(r.id),
          projectId: String(r.project_id),
          createdAt: iso(r.created_at),
          manifest: dict(r.manifest),
        }
      : null;
  };
  const unported = () => {
    throw new MapUnavailable("the map graph is drawn by @echo/map, not on this branch");
  };
  return {
    snapshot,
    async currentSnapshot(projectId) {
      const [scope] = await sql`select current_snapshot_id from analysis_scope
        where project_id = ${projectId} and kind = 'view' and view_id = ${MAP_VIEW_ID}
          and scope_key = ${VIEW_SCOPE_KEY}`;
      return scope?.current_snapshot_id ? snapshot(String(scope.current_snapshot_id)) : null;
    },
    async legacyResults(projectId) {
      const rows = await sql`select id, created_at, snapshot_id from map_result
        where status = 'ready' and manifest_version = 1 and project_id = ${projectId}
        order by project_id, created_at, id`;
      return rows.map((r) => ({
        id: String(r.id),
        createdAt: iso(r.created_at),
        snapshotId: r.snapshot_id ? String(r.snapshot_id) : null,
      }));
    },
    graph: async () => unported(),
    legacyGraph: async () => unported(),
    requestGeneration: async () => unported(),
  };
}

// ── budgets ──────────────────────────────────────────────────────────

const DEFAULT_NODE_LIMIT = 150;
const DEFAULT_EDGE_LIMIT = 450;

/**
 * resolve_budgets without deployment ceilings: the ceilings are declared by the analysis
 * config section on port/analysis and are unset everywhere today. A bad value answers 422.
 */
export function resolveBudgets(nodeLimit: number | null, edgeLimit: number | null): Budgets {
  const positive = (field: string, v: number) => {
    if (v < 1) throw new ValidationError(`${field} must be a positive whole number, got ${v}`);
    return v;
  };
  const node = nodeLimit === null ? DEFAULT_NODE_LIMIT : positive("nodeLimit", nodeLimit);
  let edge: number;
  if (edgeLimit === null) edge = Math.max(DEFAULT_EDGE_LIMIT, node - 1);
  else edge = positive("edgeLimit", edgeLimit);
  if (edge < node - 1)
    throw new ValidationError(
      `edgeLimit must be at least nodeLimit - 1 (${node - 1}) so every tree edge fits, got ${edge}`,
    );
  return { nodeLimit: node, edgeLimit: edge };
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

function curateMap(payload: Json, settings: Json | null): Json {
  const hidden = list(dict(dict(settings).presentation).hidden_items).map((x) => pyStr(x));
  return withoutNodes(payload, new Set(hidden));
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
  const budgets = resolveBudgets(a.nodeLimit, a.edgeLimit);
  try {
    const names = dict(a.settings).public_labels === "names" ? a.legend.names : null;
    const bound = dict(dict(dict(a.settings).presentation).result_bindings).map;
    const snapshot = bound
      ? await store.snapshot(pyStr(bound))
      : await store.currentSnapshot(a.projectId);
    if (snapshot && snapshot.projectId !== a.projectId)
      throw new NotFoundError("Map results are not available.");
    const legacy = (await store.legacyResults(a.projectId)).filter((l) => !l.snapshotId);
    const newest = legacy.at(-1);
    if (
      !bound &&
      newest &&
      (snapshot === null ||
        (newest.createdAt &&
          snapshot.createdAt &&
          Date.parse(newest.createdAt) > Date.parse(snapshot.createdAt)))
    ) {
      const { payload, factChecks } = await store.legacyGraph(newest.id, budgets);
      const projected = curateMap(sanitizeMap(payload, a.legend.order, names), a.settings);
      projected.fact_checks = audienceAssessments(factChecks, projected);
      return withoutNodes(projected, await a.excluded());
    }
    if (snapshot) {
      const { payload, factChecks } = await store.graph(snapshot, budgets);
      const projected = curateMap(sanitizeMap(payload, a.legend.order, names), a.settings);
      projected.fact_checks = audienceAssessments(factChecks, projected);
      return withoutNodes(projected, await a.excluded());
    }
  } catch (err) {
    // The host's graph endpoint answers a store failure with 503; the room gets the same.
    if (err instanceof MapUnavailable) throw new UnavailableError("Map storage is unavailable.");
    throw err;
  }
  throw new NotFoundError("Map results are not ready.");
}

export type { Row };
