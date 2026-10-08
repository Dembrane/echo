import type { Access } from "@dembrane/access";
import {
  AnalysisStoreError,
  ARGUMENTS_RECIPE_ID,
  analysisRuntime,
  BudgetError,
  budgetsPayload,
  clientOf,
  countConversationsWithTranscripts,
  currentMapSnapshot,
  type GraphQuery,
  graphPayload,
  type JobSink,
  type Json,
  legacyGraphPayload,
  liveChannel,
  MapViewReads,
  mapChannel,
  PAYLOAD_VERSION,
  parseTypes,
  pyIso,
  resolveBudgets,
  SelectionTooLarge,
  SelectionTooSmall,
  UnknownMapType,
  UnknownResultScope,
  VIEW_SCOPE_KEY,
} from "@dembrane/analysis";
import {
  ConflictError,
  NotFoundError,
  PlatformError,
  StatusError,
  UnavailableError,
  ValidationError,
} from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Env, projectFor, requireUser, type Signed } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import type { Completer, Embedder } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { sharedHub, sseResponse } from "@dembrane/realtime";
import { type Context, Hono } from "hono";
import { mapFactCheck } from "./factcheck";
import { mapGroup } from "./groups";
import { titleSelection } from "./model";
import * as service from "./service";
import { MapStore, MapStoreError } from "./store";

export interface MapRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly jobs: JobSink;
  readonly completer: Completer;
  readonly embedder: Embedder;
  readonly embeddingModel: string;
  readonly embeddingLocation: string;
  readonly nodeLimitCeiling: number | null;
  readonly edgeLimitCeiling: number | null;
  /** Wakes the screens outside the Map page that show a project's groups. */
  readonly onGroupChanged?: (projectId: string) => Promise<void>;
}

const GENERATE_LIMIT = { name: "map_generate", capacity: 10, windowSeconds: 600 };
const TITLE_LIMIT = { name: "map_title", capacity: 60, windowSeconds: 60 };
const FACT_CHECK_LIMIT = { name: "map_fact_check", capacity: 120, windowSeconds: 60 };
// A group is one title call, like a title, and a host makes them by the dozen.
const GROUP_LIMIT = { name: "map_group", capacity: 60, windowSeconds: 60 };
const BASE = "/api/v2/bff/map";

const unavailable = () => new UnavailableError("map.storage_unavailable");

/** Python json.dumps(value, sort_keys=True) with its default separators, for ETag inputs. */
function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string")
    return JSON.stringify(v).replace(
      /[\u0080-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${pyDumps(k)}: ${pyDumps(o[k])}`)
    .join(", ")}}`;
}

const sha24 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 24);

function graphEtag(kind: string, identity: string, stamp: string, query: GraphQuery): string {
  const parts = [
    String(PAYLOAD_VERSION),
    kind,
    identity,
    stamp,
    query.types !== null ? query.types.join(",") : "*",
    query.scope ?? "",
    pyDumps(budgetsPayload(query.budgets)),
  ];
  return `W/"map-graph-${sha24(parts.join("|"))}"`;
}

const etagMatches = (header: string | undefined, etag: string) =>
  !!header && header.split(",").some((c) => [etag, "*"].includes(c.trim()));

function intParam(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const t = raw.trim().replaceAll("_", "");
  if (!/^[+-]?\d+$/.test(t))
    throw new BudgetError(name, `${name} must be a positive whole number, got '${raw}'`);
  return Number(t);
}

/** Python's str(datetime) for a Postgres timestamptz text value ("None" when absent). */
const pyStr = (ts: unknown) =>
  typeof ts === "string" ? (pyIso(ts) ?? ts).replace("T", " ") : "None";

/**
 * Map: saved maps, the bounded graph, generation, selection titles, groups, fact-checks,
 * and the live stream. Reading needs project and conversation read access; starting a
 * generation, a group or a fact-check needs project:update. Result-scoped routes resolve the result to its
 * project first, so a result id of another project is a 404.
 */
export function mapRoutes(deps: MapRoutesDeps) {
  const rt = analysisRuntime({
    db: deps.db,
    logger: deps.logger,
    completer: deps.completer,
    embedder: deps.embedder,
    jobs: deps.jobs,
    config: { embeddingModel: deps.embeddingModel, embeddingLocation: deps.embeddingLocation },
  });
  const store = new MapStore(clientOf(deps.db));
  const d: service.FactCheckDeps & service.TitleDeps & service.GroupDeps = {
    store,
    rt,
    cache: new service.TitleCache(),
    modelIdentity: deps.completer.modelIdentity("multi_modal_fast"),
    generate: (lines, projectName, projectContext) =>
      titleSelection(deps.completer, { lines, projectName, projectContext }),
    dispatch: (job) =>
      deps.jobs.enqueue(mapFactCheck, job, { singletonKey: `${job.factCheckId}:${job.attempt}` }),
    dispatchGroup: (job) =>
      deps.jobs.enqueue(mapGroup, job, { singletonKey: `${job.groupId}:${job.attempt}` }),
    onGroupChanged: deps.onGroupChanged,
  };
  const ceilings = { nodeLimit: deps.nodeLimitCeiling, edgeLimit: deps.edgeLimitCeiling };
  const app = new Hono<Env>();

  const readable = async (who: Signed, projectId: string) => {
    await projectFor(deps.access, who, projectId, "project:read");
    await projectFor(deps.access, who, projectId, "conversation:read");
  };

  /** Store failures are 503 "Map storage is unavailable." wherever the Python caught them. */
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      throw err;
    }
  };

  const target = async (who: Signed, resultId: string) => {
    const t = await guarded(() => service.resolveTarget(d, resultId));
    if (!t) throw new NotFoundError("map.not_found");
    await readable(who, service.targetProject(t));
    return t;
  };

  app.get(`${BASE}/projects/:project_id`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { metadata_only: p.optional(p.bool(), false) },
    });
    const projectId = c.req.param("project_id");
    await readable(who, projectId);
    const [current, attempt] = await guarded(() => service.projectRows(d, projectId));
    let conversations: number | null;
    try {
      conversations = await countConversationsWithTranscripts(rt.store, projectId);
    } catch {
      // The count is a hint; the map itself still loads.
      conversations = null;
    }
    let etag = service.stateEtag(current, attempt, conversations);
    if (query.metadata_only) etag = `${etag.slice(0, -1)}-metadata"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    const payload = await guarded(() =>
      service.statePayload(d, current, attempt, query.metadata_only),
    );
    payload.source = { conversations_with_transcripts: conversations };
    return c.json(payload, 200, headers);
  });

  app.get(`${BASE}/projects/:project_id/graph`, async (c) => {
    const who = requireUser(c);
    const projectId = c.req.param("project_id");
    await readable(who, projectId);
    let query: GraphQuery;
    try {
      query = {
        types: parseTypes(c.req.query("types")),
        scope: c.req.query("scope") || null,
        budgets: resolveBudgets(
          intParam("node_limit", c.req.query("node_limit")),
          intParam("edge_limit", c.req.query("edge_limit")),
          ceilings,
        ),
      };
    } catch (err) {
      if (err instanceof UnknownMapType || err instanceof BudgetError)
        throw new ValidationError("map.invalid_request", { message: err.message });
      throw err;
    }
    const reads = new MapViewReads(rt.store);
    try {
      const snapshot = await currentMapSnapshot(projectId, rt.store, reads, {
        publish: rt.publishMap,
      });
      const legacy = (await reads.legacyResults(projectId)).filter((l) => !l.snapshotId);
      const newest = legacy[legacy.length - 1] ?? null;
      let legacyRow: Record<string, unknown> | null = null;
      if (
        newest &&
        (!snapshot ||
          (newest.createdAt !== null &&
            snapshot.createdAt !== null &&
            service.compareTimestamps(newest.createdAt, snapshot.createdAt) > 0))
      )
        legacyRow = await store.getResult(newest.id);
      let etag: string;
      if (legacyRow)
        etag = graphEtag("legacy", String(legacyRow.id), pyStr(legacyRow.completed_at), query);
      else if (snapshot) etag = graphEtag("snapshot", snapshot.id, "", query);
      else throw new NotFoundError("map.no_map_yet");
      const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
      if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
      let payload: Json;
      if (legacyRow) payload = await legacyGraphPayload(legacyRow, query, rt.store);
      else if (snapshot) {
        const resultId = await reads.ensureV2Result(snapshot);
        payload = await graphPayload(snapshot, query, rt.store, resultId);
      } else throw new NotFoundError("map.no_map_yet");
      return c.json(payload, 200, headers);
    } catch (err) {
      if (err instanceof UnknownResultScope)
        throw new ValidationError("analysis.unknown_scope", { message: err.message });
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      throw err;
    }
  });

  app.post(`${BASE}/projects/:project_id/generate`, async (c) => {
    const who = requireUser(c);
    const projectId = c.req.param("project_id");
    await readable(who, projectId);
    await projectFor(deps.access, who, projectId, "project:update");
    await deps.limiter.check(GENERATE_LIMIT, who.directusUserId);
    let row: Record<string, unknown> | null;
    try {
      row = await service.requestGeneration(d, projectId, who.directusUserId);
    } catch (err) {
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      deps.logger.error(
        { project_id: projectId, err: { name: (err as Error)?.name } },
        "map generation not started",
      );
      throw new UnavailableError("map.generation_not_started");
    }
    return c.json({ attempt: service.attemptPayload(row) }, 202);
  });

  app.get(`${BASE}/projects/:project_id/events`, async (c) => {
    const who = requireUser(c);
    const projectId = c.req.param("project_id");
    await readable(who, projectId);
    const runs =
      ["1", "true"].includes(c.req.query("runs") ?? "") || (await followsRuns(projectId));
    const hub = await sharedHub(clientOf(deps.db), deps.logger);
    return sseResponse(c as unknown as Context, hub, [
      mapChannel(projectId),
      ...(runs ? [liveChannel(projectId)] : []),
    ]);
  });

  /** Executor runs join the stream by themselves once the project has an arguments scope. */
  async function followsRuns(projectId: string): Promise<boolean> {
    try {
      return (
        (await rt.store.findScope({
          projectId,
          kind: "producer",
          ownerId: ARGUMENTS_RECIPE_ID,
          scopeKey: VIEW_SCOPE_KEY,
        })) !== null
      );
    } catch {
      return false;
    }
  }

  app.post(`${BASE}/results/:result_id/title`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: p.model({
        node_ids: p.required(p.list(p.str(), { min: 1, max: 2000 })),
        snapshot_id: p.optional(p.nullable(p.str()), null),
        revision_ids: p.optional(p.nullable(p.list(p.str(), { max: 2000 })), null),
      }),
    });
    const t = await target(who, c.req.param("result_id"));
    await deps.limiter.check(TITLE_LIMIT, who.directusUserId);
    const project = await guarded(() => store.projectContext(service.targetProject(t)));
    try {
      if (t.kind === "snapshot") {
        if (body.data.snapshot_id && body.data.snapshot_id !== t.snapshot.id)
          throw new ConflictError("map.selection_other_snapshot");
        const ids = body.data.revision_ids?.length ? body.data.revision_ids : body.data.node_ids;
        return c.json(await service.snapshotSelectionTitle(d, t, ids, project));
      }
      return c.json(await service.selectionTitle(d, t.row, body.data.node_ids, project));
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      if (err instanceof service.NotReady) throw new ConflictError("map.not_ready");
      if (err instanceof service.UnknownArguments)
        throw new ValidationError("map.selection_not_in_map", { message: err.message });
      if (err instanceof SelectionTooSmall)
        throw new ValidationError("map.selection_too_small", { message: err.message });
      if (err instanceof SelectionTooLarge)
        throw new StatusError(413, "map.selection_too_large", { message: err.message });
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      deps.logger.warn(
        { result_id: c.req.param("result_id"), err: { name: (err as Error)?.name } },
        "map title failed",
      );
      throw new StatusError(502, "map.title_failed");
    }
  });

  app.get(`${BASE}/results/:result_id/groups`, async (c) => {
    const who = requireUser(c);
    const t = await target(who, c.req.param("result_id"));
    const rows = await guarded(() => store.listGroups(service.targetProject(t)));
    return c.json({ items: rows.map(service.groupDoc) });
  });

  app.post(`${BASE}/results/:result_id/groups`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: p.model({
        snapshot_id: p.required(p.str()),
        revision_ids: p.required(p.list(p.str(), { min: 1, max: 2000 })),
      }),
    });
    const t = await target(who, c.req.param("result_id"));
    await projectFor(deps.access, who, service.targetProject(t), "project:update");
    if (t.kind !== "snapshot") throw new ConflictError("map.groups_need_snapshot");
    if (body.data.snapshot_id !== t.snapshot.id)
      throw new ConflictError("map.selection_other_snapshot");
    await deps.limiter.check(GROUP_LIMIT, who.directusUserId);
    try {
      const group = await service.requestGroup(d, t, body.data.revision_ids, who.directusUserId);
      return c.json({ group }, 202);
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      if (err instanceof service.UnknownArguments)
        throw new ValidationError("map.selection_not_in_map", { message: err.message });
      if (err instanceof SelectionTooSmall)
        throw new ValidationError("map.selection_too_small", { message: err.message });
      if (err instanceof SelectionTooLarge)
        throw new StatusError(413, "map.selection_too_large", { message: err.message });
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      deps.logger.error({ err: { name: (err as Error)?.name } }, "map group not started");
      throw new UnavailableError("map.group_not_started");
    }
  });

  app.get(`${BASE}/results/:result_id/fact-checks`, async (c) => {
    const who = requireUser(c);
    const t = await target(who, c.req.param("result_id"));
    try {
      const states =
        t.kind === "snapshot"
          ? await service.snapshotFactCheckStates(d, t)
          : await service.factCheckStates(d, t.row);
      return c.json({ fact_checks: states });
    } catch (err) {
      if (err instanceof service.NotReady) throw new ConflictError("map.not_ready");
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      throw err;
    }
  });

  app.post(`${BASE}/results/:result_id/fact-checks/:node_id`, async (c) => {
    const who = requireUser(c);
    const raw = await c.req.text();
    let force = false;
    if (raw.trim() !== "" && raw.trim() !== "null") {
      const parsed = await p.validate(
        { param: () => ({}), query: () => ({}), text: async () => raw },
        { body: p.model({ force: p.optional(p.bool(), false) }) },
      );
      force = parsed.body.data.force;
    }
    const t = await target(who, c.req.param("result_id"));
    await projectFor(deps.access, who, service.targetProject(t), "project:update");
    await deps.limiter.check(FACT_CHECK_LIMIT, who.directusUserId);
    try {
      return c.json(
        await service.startFactCheck(d, t, c.req.param("node_id"), who.directusUserId, force),
      );
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      if (err instanceof service.NotReady) throw new ConflictError("map.not_ready");
      if (err instanceof service.UnknownArguments)
        throw new ValidationError("map.selection_not_in_map", { message: err.message });
      if (err instanceof service.NotAClaim)
        throw new ValidationError("map.not_a_claim", { message: err.message });
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      deps.logger.error({ err: { name: (err as Error)?.name } }, "map fact-check not started");
      throw new UnavailableError("map.fact_check_not_started");
    }
  });

  app.delete(`${BASE}/results/:result_id/fact-checks/:node_id`, async (c) => {
    const who = requireUser(c);
    const t = await target(who, c.req.param("result_id"));
    await projectFor(deps.access, who, service.targetProject(t), "project:update");
    try {
      return c.json(await service.cancelFactCheck(d, t, c.req.param("node_id")));
    } catch (err) {
      if (err instanceof service.NotReady) throw new ConflictError("map.not_ready");
      if (err instanceof service.UnknownArguments)
        throw new ValidationError("map.selection_not_in_map", { message: err.message });
      if (err instanceof service.NotAClaim)
        throw new ValidationError("map.not_a_claim", { message: err.message });
      if (err instanceof MapStoreError || err instanceof AnalysisStoreError) throw unavailable();
      throw err;
    }
  });

  return app;
}
