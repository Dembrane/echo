import { newId } from "@dembrane/core";
import type postgres from "postgres";
import {
  ACTIVE_RUN_STATUSES,
  AnalysisStoreError,
  AnalysisValidationError,
  type ClaimResult,
  DEFAULT_LEASE_SECONDS,
  type Json,
  type NewRelation,
  type NewRevision,
  type NewRun,
  type NewSnapshot,
  type ObjectRecord,
  type ObjectRevision,
  type OutboxEvent,
  PublicationRejected,
  type PublishResult,
  provenanceJson,
  ReferenceViolation,
  type Relation,
  RetryConflict,
  ReuseOutdated,
  RevisionConflict,
  type Run,
  type RunStatus,
  type Scope,
  type ScopeKind,
  type Snapshot,
  SnapshotConflict,
  type Step,
  StepConflict,
  type StepWrite,
  type WakeResult,
  WriterNotOwner,
} from "./contracts";
import {
  count,
  isUuid,
  J,
  one,
  q,
  type Row,
  type Sql,
  transaction,
  UniqueViolation,
  uuids,
} from "./db";
import { contentHash, pyFloatRepr } from "./hashing";
import { sortedStrings } from "./registry";
import {
  objectOf,
  outboxOf,
  relationOf,
  revisionOf,
  runOf,
  scopeOf,
  snapshotOf,
  stepOf,
} from "./rows";

/**
 * SQL persistence for the analysis lifecycle, ported statement for statement from the
 * Python store. Every worker write (heartbeat, input pinning, step checkpoint, staged
 * revision or relation) runs in one short transaction that locks the run's scope FOR SHARE
 * and then the run FOR UPDATE, the order publication locks them in, and proceeds only
 * while the run is running under the caller's lease, before its deadline, under its
 * scope's writer fence and not overtaken by a newer ready request. A write that passes
 * extends the lease. So a checkpoint either commits before a newer publication in its
 * scope or sees it and refuses. Nothing here is held open across a model call.
 *
 * The lease is kept on purpose next to DBOS: DBOS decides which worker runs a workflow
 * after a crash, the lease decides whether a writer may still touch a run's rows once a
 * host cancelled it, a newer request published, or a retry moved it to another attempt.
 */

const ACTIVE = [...ACTIVE_RUN_STATUSES];
const WAKE_BATCH = 200;

/** Another request bound this idempotency key first. */
class KeyTaken extends Error {}

async function leaseLive(tx: Sql, runId: string): Promise<boolean> {
  // clock_timestamp, not now(): now() is the transaction's start, which can be long
  // before the lock wait ended.
  const row = await one<{ live: boolean }>(
    tx,
    "SELECT lease_expires_at > clock_timestamp() AS live FROM analysis_run WHERE id = $1",
    [runId],
  );
  return Boolean(row?.live);
}

/** Objects whose head is not the expected revision; every object row locked in id order. */
async function headConflicts(tx: Sql, expected: Map<string, string | null>): Promise<string[]> {
  if (!expected.size) return [];
  const rows = await q<{ id: string; current_revision_id: string | null }>(
    tx,
    `SELECT id::text AS id, current_revision_id::text AS current_revision_id
       FROM analysis_object WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [sortedStrings(expected.keys())],
  );
  const heads = new Map(rows.map((r) => [r.id, r.current_revision_id]));
  return sortedStrings(
    [...expected.entries()]
      .filter(([id, rev]) => (heads.get(id) ?? null) !== rev)
      .map(([id]) => id),
  );
}

/** What a run computes apart from its inputs: equal identities over equal inputs are interchangeable. */
function computationIdentity(row: Row): string {
  return contentHash({
    recipeVersion: row.recipe_version,
    definition: row.definition ?? {},
    parameters: row.parameters ?? {},
    context: row.context ?? {},
  });
}

const vectorLiteral = (vector: readonly number[]) => `[${vector.map(pyFloatRepr).join(",")}]`;

export function parseVector(text: string): number[] {
  const body = String(text).trim();
  if (!body.startsWith("[") || !body.endsWith("]"))
    throw new AnalysisStoreError("unreadable vector from the database");
  const inner = body.slice(1, -1).trim();
  return inner ? inner.split(",").map(Number) : [];
}

export interface StoreOptions {
  readonly leaseSeconds?: number;
  /** Tests only: called at named points inside publication transactions to prove rollback. */
  readonly fault?: (point: string) => void;
}

type Owner = Row & {
  id: string;
  project_id: string;
  scope_id: string;
  input_manifest: Json | null;
  input_fingerprint: string | null;
};

export class AnalysisStore {
  private readonly leaseSeconds: number;
  private readonly fault: (point: string) => void;

  constructor(
    readonly sql: postgres.Sql,
    opts: StoreOptions = {},
  ) {
    this.leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.fault = opts.fault ?? (() => {});
  }

  tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return transaction(this.sql, fn);
  }

  /** A transaction in which the run is this worker's (owner) or not (null). Extends the lease. */
  private owned<T>(runId: string, lease: string, fn: (tx: Sql, owner: Owner | null) => Promise<T>) {
    return this.tx(async (tx) => {
      let owner: Owner | null = null;
      if (isUuid(runId) && lease) {
        const located = await one<{ scope_id: string }>(
          tx,
          "SELECT scope_id FROM analysis_run WHERE id = $1",
          [runId],
        );
        if (located) {
          // FOR SHARE conflicts with every update of the scope row: a writer transfer or a
          // publication waits for this checkpoint, or this checkpoint for it.
          const scope = await one(
            tx,
            `SELECT writer, writer_fence, current_request_order FROM analysis_scope
              WHERE id = $1 FOR SHARE`,
            [located.scope_id],
          );
          const run = await one<Owner>(
            tx,
            `SELECT id::text AS id, project_id::text AS project_id, scope_id::text AS scope_id,
                    recipe_id, recipe_version, request_order, writer_fence, input_manifest,
                    input_fingerprint
               FROM analysis_run
              WHERE id = $1 AND lease = $2 AND status = 'running'
              FOR UPDATE`,
            [runId, lease],
          );
          if (
            scope &&
            run &&
            (await leaseLive(tx, runId)) &&
            scope.writer === "analysis" &&
            Number(scope.writer_fence) === Number(run.writer_fence) &&
            (scope.current_request_order === null ||
              Number(scope.current_request_order) < Number(run.request_order))
          ) {
            await q(
              tx,
              `UPDATE analysis_run
                  SET lease_expires_at = clock_timestamp() + make_interval(secs => $1),
                      updated_at = now()
                WHERE id = $2`,
              [this.leaseSeconds, runId],
            );
            owner = run;
          }
        }
      }
      return fn(tx, owner);
    });
  }

  // ── scopes ──────────────────────────────────────────────────────────

  async ensureScope(o: {
    projectId: string;
    kind: ScopeKind;
    ownerId: string;
    scopeKey: string;
  }): Promise<Scope> {
    const existing = await this.findScope(o);
    if (existing) return existing;
    const owner = o.kind === "producer" ? "recipe_id" : "view_id";
    const row = await one(
      this.sql,
      `INSERT INTO analysis_scope
              (id, project_id, kind, ${owner}, scope_key, next_request_order,
               generation_epoch, publication_sequence, writer, writer_fence,
               created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 0, 0, 'analysis', 0, now(), now())
       ON CONFLICT (project_id, ${owner}, scope_key) WHERE kind = '${o.kind}' DO NOTHING
       RETURNING *`,
      [newId(), o.projectId, o.kind, o.ownerId, o.scopeKey],
    );
    if (row) return scopeOf(row);
    const found = await this.findScope(o);
    if (!found) throw new AnalysisStoreError("scope vanished after a conflicting insert");
    return found;
  }

  async findScope(o: {
    projectId: string;
    kind: ScopeKind;
    ownerId: string;
    scopeKey: string;
  }): Promise<Scope | null> {
    const owner = o.kind === "producer" ? "recipe_id" : "view_id";
    const row = await one(
      this.sql,
      `SELECT * FROM analysis_scope
        WHERE project_id = $1 AND kind = $2 AND ${owner} = $3 AND scope_key = $4`,
      [o.projectId, o.kind, o.ownerId, o.scopeKey],
    );
    return row ? scopeOf(row) : null;
  }

  async getScope(scopeId: string): Promise<Scope | null> {
    if (!isUuid(scopeId)) return null;
    const row = await one(this.sql, "SELECT * FROM analysis_scope WHERE id = $1", [scopeId]);
    return row ? scopeOf(row) : null;
  }

  // ── runs ────────────────────────────────────────────────────────────

  private static async rememberKey(
    tx: Sql,
    o: { projectId: string; key: string; run: Run; mode: string },
  ) {
    await q(
      tx,
      `INSERT INTO analysis_request_key (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [newId(), o.projectId, o.key, o.run.id, o.run.scopeId, o.mode],
    );
  }

  /**
   * Resolves a request under its scope lock: the run its key already answers, an
   * equivalent run in flight (the key is recorded against it), or a new run with the
   * scope's next request order. A reuse run is made current, so it fences older requests.
   */
  async createRun(n: NewRun): Promise<[Run, boolean]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.tx(async (tx): Promise<[Run, boolean]> => {
          const mapped = await one(
            tx,
            `SELECT r.* FROM analysis_request_key AS k
               JOIN analysis_run AS r ON r.id = k.run_id
              WHERE k.project_id = $1 AND k.idempotency_key = $2`,
            [n.projectId, n.idempotencyKey],
          );
          if (mapped) return [runOf(mapped), false];
          const scopeRow = await one(
            tx,
            `SELECT * FROM analysis_scope
              WHERE id = $1 AND project_id = $2 AND kind = 'producer' AND recipe_id = $3
              FOR UPDATE`,
            [n.scopeId, n.projectId, n.recipeId],
          );
          if (!scopeRow)
            throw new ReferenceViolation(
              `scope ${n.scopeId} is not a ${n.recipeId} scope of this project`,
            );
          const scope = scopeOf(scopeRow);
          if (scope.writer !== "analysis")
            throw new WriterNotOwner(`scope ${scope.id} is written by ${scope.writer}`);
          if (ACTIVE_RUN_STATUSES.includes(n.status)) {
            const active = await one(
              tx,
              `SELECT * FROM analysis_run
                WHERE scope_id = $1 AND request_fingerprint = $2 AND status = ANY($3::text[])
                ORDER BY request_order DESC LIMIT 1`,
              [scope.id, n.requestFingerprint, ACTIVE],
            );
            if (active) {
              const joined = runOf(active);
              await AnalysisStore.rememberKey(tx, {
                projectId: n.projectId,
                key: n.idempotencyKey,
                run: joined,
                mode: n.mode,
              });
              return [joined, false];
            }
          }
          if (n.reusedRunId) {
            if (scope.currentRunId !== n.reusedRunId) throw new ReuseOutdated(scope.currentRunId);
            // The reused output must still be what its objects say: an edit since its
            // publication makes it stale, exactly as publication's head check would find.
            const expected = new Map<string, string | null>(
              ((n.outputManifest?.objects as Json[] | undefined) ?? []).map((o) => [
                String(o.objectId),
                String(o.revisionId),
              ]),
            );
            if ((await headConflicts(tx, expected)).length)
              throw new ReuseOutdated(scope.currentRunId);
          }
          const order = scope.nextRequestOrder;
          const epoch = n.epoch !== null ? n.epoch : scope.generationEpoch + 1;
          await q(
            tx,
            `UPDATE analysis_scope
                SET next_request_order = $1, generation_epoch = GREATEST(generation_epoch, $2),
                    updated_at = now()
              WHERE id = $3`,
            [order + 1, epoch, scope.id],
          );
          const ready = n.status === "ready";
          const row = await one(
            tx,
            `INSERT INTO analysis_run
                    (id, project_id, scope_id, recipe_id, recipe_version, definition, mode,
                     epoch, idempotency_key, request_order, request_fingerprint,
                     input_fingerprint, hash_version, input_manifest, parameters, context,
                     depends_on, status, progress, attempt, writer_fence, output_manifest,
                     metrics, reused_run_id, requested_by, created_at, updated_at,
                     completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'c14n-v1', $13, $14,
                     $15, $16, $17, $18, 0, $19, $20, $21, $22, $23, now(), now(),
                     CASE WHEN $24::boolean THEN now() END)
             RETURNING *`,
            [
              newId(),
              n.projectId,
              scope.id,
              n.recipeId,
              n.recipeVersion,
              J(n.definition),
              n.mode,
              epoch,
              n.idempotencyKey,
              order,
              n.requestFingerprint,
              n.inputFingerprint ?? null,
              J(n.inputManifest ?? null),
              J(n.parameters),
              J(n.context),
              J([...n.dependsOn]),
              n.status,
              J({ stage: n.status }),
              scope.writerFence,
              J(n.outputManifest ?? null),
              J(n.metrics ?? {}),
              n.reusedRunId ?? null,
              n.requestedBy,
              ready,
            ],
          );
          if (!row) throw new AnalysisStoreError("the run insert returned nothing");
          const run = runOf(row);
          if (ready && n.reusedRunId)
            await q(
              tx,
              `UPDATE analysis_scope
                  SET current_run_id = $1, current_request_order = $2, updated_at = now()
                WHERE id = $3`,
              [run.id, order, scope.id],
            );
          await AnalysisStore.rememberKey(tx, {
            projectId: n.projectId,
            key: n.idempotencyKey,
            run,
            mode: n.mode,
          });
          return [run, true];
        });
      } catch (err) {
        // The same key was accepted concurrently, or equivalent work raced in: resolve again.
        if (err instanceof UniqueViolation) continue;
        throw err;
      }
    }
    throw new AnalysisStoreError("could not create or find the run after three attempts");
  }

  private async oneRun(where: string, params: unknown[]): Promise<Run | null> {
    const row = await one(this.sql, `SELECT * FROM analysis_run WHERE ${where}`, params);
    return row ? runOf(row) : null;
  }

  getRun(runId: string): Promise<Run | null> {
    if (!isUuid(runId)) return Promise.resolve(null);
    return this.oneRun("id = $1", [runId]);
  }

  async runByIdempotencyKey(projectId: string, key: string): Promise<Run | null> {
    const row = await one(
      this.sql,
      `SELECT r.* FROM analysis_request_key AS k JOIN analysis_run AS r ON r.id = k.run_id
        WHERE k.project_id = $1 AND k.idempotency_key = $2`,
      [projectId, key],
    );
    return row ? runOf(row) : null;
  }

  activeRun(scopeId: string, requestFingerprint: string): Promise<Run | null> {
    return this.oneRun(
      "scope_id = $1 AND request_fingerprint = $2 AND status = ANY($3::text[]) ORDER BY request_order DESC LIMIT 1",
      [scopeId, requestFingerprint, ACTIVE],
    );
  }

  latestRun(scopeId: string, statuses: readonly RunStatus[]): Promise<Run | null> {
    return this.oneRun(
      "scope_id = $1 AND status = ANY($2::text[]) ORDER BY request_order DESC LIMIT 1",
      [scopeId, [...statuses]],
    );
  }

  async setExecutionRef(runId: string, ref: string): Promise<void> {
    await q(this.sql, "UPDATE analysis_run SET execution_ref = $1 WHERE id = $2", [
      ref.slice(0, 128),
      runId,
    ]);
  }

  /** Newest-first history of one project, for the runs list. */
  async projectRuns(projectId: string, offset: number, limit: number): Promise<[Run[], number]> {
    const total = await one<{ total: string }>(
      this.sql,
      "SELECT COUNT(*) AS total FROM analysis_run WHERE project_id = $1",
      [projectId],
    );
    const rows = await q(
      this.sql,
      `SELECT * FROM analysis_run WHERE project_id = $1
        ORDER BY created_at DESC, id DESC OFFSET $2 LIMIT $3`,
      [projectId, offset, limit],
    );
    return [rows.map(runOf), Number(total?.total ?? 0)];
  }

  /**
   * Starts a queued run, or takes over one whose lease deadline passed, under a new lease.
   * With a running limit, counting and claiming are serialised per recipe by an advisory
   * lock. A run whose scope changed writer since it was accepted fails instead.
   */
  async claimRun(runId: string, lease: string, maxRunning: number | null): Promise<ClaimResult> {
    if (!isUuid(runId)) return { outcome: "inactive", run: null };
    const fenced = await this.tx(async (tx) => {
      if (maxRunning !== null) {
        const located = await one<{ recipe_id: string }>(
          tx,
          "SELECT recipe_id FROM analysis_run WHERE id = $1",
          [runId],
        );
        if (!located) return { done: { outcome: "inactive" as const, run: null } };
        await q(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `analysis_recipe_running:${located.recipe_id}`,
        ]);
      }
      const row = await one(
        tx,
        `UPDATE analysis_run AS r
            SET status = 'running', lease = $1, attempt = r.attempt + 1,
                lease_expires_at = clock_timestamp() + make_interval(secs => $3),
                started_at = COALESCE(r.started_at, now()), updated_at = now(),
                error = NULL,
                progress = (COALESCE(r.progress::jsonb, '{}'::jsonb)
                            || jsonb_build_object('stage', 'running'))::json
          WHERE r.id = $2
            AND (r.status = 'queued'
                 OR (r.status = 'running'
                     AND COALESCE(r.lease_expires_at, '-infinity') < clock_timestamp()))
            AND EXISTS (SELECT 1 FROM analysis_scope AS s
                         WHERE s.id = r.scope_id AND s.writer = 'analysis'
                           AND s.writer_fence = r.writer_fence)
            AND ($4::int IS NULL OR (
                 SELECT count(*) FROM analysis_run AS o
                  WHERE o.recipe_id = r.recipe_id AND o.status = 'running'
                    AND o.id <> r.id AND o.lease_expires_at > clock_timestamp()
                ) < $4::int)
          RETURNING r.*`,
        [lease, runId, this.leaseSeconds, maxRunning],
      );
      if (row) return { done: { outcome: "claimed" as const, run: runOf(row) } };
      const f = await one(
        tx,
        `UPDATE analysis_run AS r
            SET status = 'failed', error = 'Another writer owns this scope now.',
                completed_at = now(), updated_at = now()
          WHERE r.id = $1 AND r.status = 'queued'
            AND NOT EXISTS (SELECT 1 FROM analysis_scope AS s
                             WHERE s.id = r.scope_id AND s.writer = 'analysis'
                               AND s.writer_fence = r.writer_fence)
          RETURNING r.*`,
        [runId],
      );
      return { fenced: f ? runOf(f) : null };
    });
    if ("done" in fenced && fenced.done) return fenced.done;
    if ("fenced" in fenced && fenced.fenced) return { outcome: "inactive", run: fenced.fenced };
    const current = await this.getRun(runId);
    if (current?.status === "queued") return { outcome: "busy", run: current };
    return { outcome: "inactive", run: current };
  }

  /** Writes a run's input manifest once; the identical manifest again is a no-op. */
  async pinInputs(
    runId: string,
    lease: string,
    manifest: Json,
    fingerprint: string,
  ): Promise<boolean> {
    if (contentHash(manifest) !== fingerprint)
      throw new AnalysisValidationError("the input fingerprint is not the manifest's hash");
    return this.owned(runId, lease, async (tx, owner) => {
      if (!owner) return false;
      if (owner.input_manifest !== null) {
        if (owner.input_fingerprint !== fingerprint)
          throw new AnalysisValidationError(
            "this run's inputs are already pinned to other revisions",
          );
        return true;
      }
      await q(
        tx,
        "UPDATE analysis_run SET input_manifest = $1, input_fingerprint = $2 WHERE id = $3",
        [J(manifest), fingerprint, runId],
      );
      return true;
    });
  }

  async heartbeatRun(runId: string, lease: string, progress: Json): Promise<boolean> {
    return this.owned(runId, lease, async (tx, owner) => {
      if (!owner) return false;
      await q(tx, "UPDATE analysis_run SET progress = $1 WHERE id = $2", [J(progress), runId]);
      return true;
    });
  }

  /**
   * Ends a running run without publishing it (failed, needs review or cancelled) while it
   * is still this worker's. Settling as superseded needs only the lease and a newer ready
   * request in the scope.
   */
  async finishRun(
    runId: string,
    lease: string,
    o: {
      status: RunStatus;
      error?: string | null;
      checks?: Json[] | null;
      metrics?: Json | null;
      candidateManifest?: Json | null;
    },
  ): Promise<boolean> {
    if (["ready", "queued", "running", "waiting_for_inputs"].includes(o.status))
      throw new Error(`finishRun cannot set ${o.status}`);
    if (!isUuid(runId) || !lease) return false;
    const progressExtra: Json = { stage: o.status };
    if (o.candidateManifest) progressExtra.candidateManifest = o.candidateManifest;
    return this.tx(async (tx) => {
      const located = await one<{ scope_id: string }>(
        tx,
        "SELECT scope_id FROM analysis_run WHERE id = $1",
        [runId],
      );
      if (!located) return false;
      const scope = await one(
        tx,
        "SELECT writer, writer_fence, current_request_order FROM analysis_scope WHERE id = $1 FOR SHARE",
        [located.scope_id],
      );
      const run = await one(
        tx,
        `SELECT request_order, writer_fence FROM analysis_run
          WHERE id = $1 AND lease = $2 AND status = 'running' FOR UPDATE`,
        [runId, lease],
      );
      if (!scope || !run) return false;
      const overtaken =
        scope.current_request_order !== null &&
        Number(scope.current_request_order) >= Number(run.request_order);
      const allowed =
        o.status === "superseded"
          ? overtaken
          : !overtaken &&
            scope.writer === "analysis" &&
            Number(scope.writer_fence) === Number(run.writer_fence) &&
            (await leaseLive(tx, runId));
      if (!allowed) return false;
      await q(
        tx,
        `UPDATE analysis_run
            SET status = $1, error = $2,
                checks = COALESCE($3::json, checks),
                metrics = COALESCE($4::json, metrics),
                progress = (COALESCE(progress::jsonb, '{}'::jsonb) || $5::jsonb)::json,
                completed_at = CASE WHEN $6::boolean THEN NULL ELSE now() END,
                updated_at = now()
          WHERE id = $7`,
        [
          o.status,
          o.error ? o.error.slice(0, 4000) : null,
          J(o.checks ?? null),
          J(o.metrics ?? null),
          J(progressExtra),
          o.status === "needs_review",
          runId,
        ],
      );
      return true;
    });
  }

  async cancelRun(runId: string): Promise<Run | null> {
    if (!isUuid(runId)) return null;
    const row = await one(
      this.sql,
      `UPDATE analysis_run
          SET status = 'cancelled', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = ANY($2::text[])
        RETURNING *`,
      [runId, [...ACTIVE, "needs_review"]],
    );
    return row ? runOf(row) : this.getRun(runId);
  }

  /**
   * Binds a retry request to its run, atomically: the run the key already answers; else
   * the failed run queued again with its saved steps and pinned inputs (lease cleared);
   * else the run as it stands. An equivalent run in flight refuses with RetryConflict.
   */
  async requeueRun(runId: string, idempotencyKey: string | null): Promise<Run | null> {
    if (!isUuid(runId)) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.tx(async (tx) => {
          const located = await one(tx, "SELECT * FROM analysis_run WHERE id = $1", [runId]);
          if (!located) return null;
          const target = runOf(located);
          if (idempotencyKey) {
            const mapped = await one(
              tx,
              `SELECT r.* FROM analysis_request_key AS k JOIN analysis_run AS r ON r.id = k.run_id
                WHERE k.project_id = $1 AND k.idempotency_key = $2`,
              [target.projectId, idempotencyKey],
            );
            if (mapped) return runOf(mapped);
          }
          await q(tx, "SELECT id FROM analysis_scope WHERE id = $1 FOR UPDATE", [target.scopeId]);
          const locked = await one(tx, "SELECT * FROM analysis_run WHERE id = $1 FOR UPDATE", [
            runId,
          ]);
          if (!locked) throw new AnalysisStoreError("the run vanished under its lock");
          let run = runOf(locked);
          if (run.status === "failed") {
            const active = await one(
              tx,
              `SELECT * FROM analysis_run
                WHERE scope_id = $1 AND request_fingerprint = $2 AND status = ANY($3::text[])
                ORDER BY request_order DESC LIMIT 1`,
              [run.scopeId, run.requestFingerprint, ACTIVE],
            );
            if (active) throw new RetryConflict(runOf(active));
            const row = await one(
              tx,
              `UPDATE analysis_run
                  SET status = 'queued', lease = NULL, lease_expires_at = NULL, error = NULL,
                      completed_at = NULL, updated_at = now(),
                      progress = (COALESCE(progress::jsonb, '{}'::jsonb)
                                  || jsonb_build_object('stage', 'queued'))::json
                WHERE id = $1
                RETURNING *`,
              [runId],
            );
            if (!row) throw new AnalysisStoreError("the requeue returned nothing");
            run = runOf(row);
          }
          if (idempotencyKey) {
            const inserted = await one(
              tx,
              `INSERT INTO analysis_request_key
                      (id, project_id, idempotency_key, run_id, scope_id, mode, created_at)
               VALUES ($1, $2, $3, $4, $5, 'retry', now())
               ON CONFLICT (project_id, idempotency_key) DO NOTHING
               RETURNING id`,
              [newId(), run.projectId, idempotencyKey, run.id, run.scopeId],
            );
            // Rolls this transaction back, requeue included.
            if (!inserted) throw new KeyTaken();
          }
          return run;
        });
      } catch (err) {
        if (err instanceof KeyTaken || err instanceof UniqueViolation) continue;
        throw err;
      }
    }
    throw new AnalysisStoreError("could not bind the retry after three attempts");
  }

  /**
   * Settles waiting runs against their dependencies' rows: all ready with a manifest,
   * queued; one failed, cancelled or gone, failed; a superseded one is re-resolved to its
   * scope's current ready run when that computes the same thing, and fails the waiter
   * otherwise. A second caller finds nothing left to change.
   */
  async wakeWaitingRuns(projectId: string | null): Promise<WakeResult> {
    const woken: Run[] = [];
    const failed: Run[] = [];
    await this.tx(async (tx) => {
      const waiting = (
        await q(
          tx,
          `SELECT r.* FROM analysis_run AS r
            WHERE r.status = 'waiting_for_inputs'
              AND ($1::uuid IS NULL OR r.project_id = $1::uuid)
              AND NOT EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements_text(COALESCE(r.depends_on::jsonb, '[]'::jsonb)) AS dep(run_id)
                    JOIN analysis_run AS d ON d.id::text = dep.run_id
                   WHERE d.status IN ('queued', 'waiting_for_inputs', 'running', 'needs_review')
                      OR (d.status = 'ready' AND d.output_manifest IS NULL))
            ORDER BY r.created_at LIMIT $2
            FOR UPDATE OF r SKIP LOCKED`,
          [projectId, WAKE_BATCH],
        )
      ).map(runOf);
      for (const run of waiting) {
        const deps = uuids(run.dependsOn);
        const rows = new Map(
          (
            await q(
              tx,
              `SELECT id::text AS id, status, scope_id::text AS scope_id, request_order,
                      output_manifest IS NOT NULL AS has_manifest,
                      recipe_version, definition, parameters, context
                 FROM analysis_run WHERE id = ANY($1::uuid[])`,
              [deps],
            )
          ).map((r) => [String(r.id), r]),
        );
        const resolved: string[] = [];
        const substituted: Record<string, string> = {};
        let broken = deps.length !== run.dependsOn.length || !deps.length;
        let pending = false;
        for (const dep of deps) {
          const row = rows.get(dep);
          if (!row || row.status === "failed" || row.status === "cancelled") {
            broken = true;
            break;
          }
          if (row.status === "ready" && row.has_manifest) resolved.push(dep);
          else if (row.status === "superseded") {
            const current = await one(
              tx,
              `SELECT r.id::text AS id, s.current_request_order, r.recipe_version,
                      r.definition, r.parameters, r.context
                 FROM analysis_scope AS s JOIN analysis_run AS r ON r.id = s.current_run_id
                WHERE s.id = $1`,
              [row.scope_id],
            );
            if (
              !current ||
              current.current_request_order === null ||
              Number(current.current_request_order) < Number(row.request_order) ||
              computationIdentity(current) !== computationIdentity(row)
            ) {
              broken = true;
              break;
            }
            resolved.push(String(current.id));
            substituted[dep] = String(current.id);
          } else {
            pending = true;
            resolved.push(dep);
          }
        }
        let status: string;
        let error: string | null;
        if (broken) {
          status = "failed";
          error = "A recipe this run depends on did not finish with a usable output.";
        } else if (pending) continue;
        else {
          status = "queued";
          error = null;
        }
        const progress: Json = { ...run.progress, stage: status };
        if (Object.keys(substituted).length)
          progress.reresolved = {
            ...((run.progress.reresolved as Json | undefined) ?? {}),
            ...substituted,
          };
        const updated = await one(
          tx,
          `UPDATE analysis_run
              SET status = $1, error = $2, depends_on = $3, progress = $4,
                  completed_at = CASE WHEN $5::boolean THEN now() END, updated_at = now()
            WHERE id = $6
            RETURNING *`,
          [
            status,
            error,
            J(broken ? run.dependsOn : resolved),
            J(progress),
            status === "failed",
            run.id,
          ],
        );
        if (!updated) continue;
        if (status === "queued") woken.push(runOf(updated));
        else failed.push(runOf(updated));
      }
    });
    return { woken, failed };
  }

  async expireStaleRuns(): Promise<string[]> {
    const rows = await q<{ id: string }>(
      this.sql,
      `UPDATE analysis_run
          SET status = 'failed', error = 'The run stopped without finishing.',
              completed_at = now(), updated_at = now()
        WHERE status = 'running' AND lease_expires_at < clock_timestamp()
        RETURNING id::text AS id`,
    );
    return rows.map((r) => r.id);
  }

  /** Queued runs nobody claimed for a while; touched so the next sweep waits again. */
  async redispatchQueuedRuns(olderThanSeconds: number, limit: number): Promise<Run[]> {
    const rows = await q(
      this.sql,
      `UPDATE analysis_run AS r SET updated_at = now()
        WHERE r.id IN (
              SELECT id FROM analysis_run
               WHERE status = 'queued'
                 AND updated_at < now() - make_interval(secs => $1)
               ORDER BY updated_at LIMIT $2
               FOR UPDATE SKIP LOCKED)
        RETURNING r.*`,
      [olderThanSeconds, limit],
    );
    return rows.map(runOf);
  }

  // ── steps ───────────────────────────────────────────────────────────

  async getSteps(runId: string): Promise<Step[]> {
    if (!isUuid(runId)) return [];
    const rows = await q(
      this.sql,
      "SELECT * FROM analysis_step WHERE run_id = $1 ORDER BY created_at",
      [runId],
    );
    return rows.map(stepOf);
  }

  async getStep(stepId: string): Promise<Step | null> {
    if (!isUuid(stepId)) return null;
    const row = await one(this.sql, "SELECT * FROM analysis_step WHERE id = $1", [stepId]);
    return row ? stepOf(row) : null;
  }

  async findReusableStep(projectId: string, cacheKey: string): Promise<Step | null> {
    const row = await one(
      this.sql,
      `SELECT * FROM analysis_step
        WHERE project_id = $1 AND cache_key = $2 AND status = 'completed'
          AND reused_step_id IS NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [projectId, cacheKey],
    );
    return row ? stepOf(row) : null;
  }

  /**
   * Saves a step's state under the run's lease. A completed step is an immutable artifact:
   * the same completed write again returns it; another cache key raises StepConflict.
   */
  async checkpointStep(runId: string, lease: string, w: StepWrite): Promise<Step | null> {
    return this.owned(runId, lease, async (tx, owner) => {
      if (!owner) return null;
      const existing = await one(
        tx,
        "SELECT * FROM analysis_step WHERE run_id = $1 AND step_key = $2 FOR UPDATE",
        [runId, w.stepKey],
      );
      if (existing && existing.status === "completed") {
        if (existing.cache_key === w.cacheKey) return stepOf(existing);
        throw new StepConflict(`step ${w.stepKey} already completed with other inputs`);
      }
      const completed = w.status === "completed";
      const values = [
        w.stepVersion,
        w.kind,
        w.cacheKey,
        w.status,
        lease,
        w.reusedStepId ?? null,
        J(w.checkpoint ?? null),
        w.output === undefined || w.output === null ? null : JSON.stringify(w.output),
        J([...(w.validation ?? [])]),
        J(w.usage ?? {}),
        w.error ? w.error.slice(0, 4000) : null,
        completed,
        runId,
        w.stepKey,
      ];
      const row = existing
        ? await one(
            tx,
            `UPDATE analysis_step SET
                    step_version = $1, kind = $2, cache_key = $3, status = $4,
                    attempt = attempt + CASE WHEN lease IS DISTINCT FROM $5 THEN 1 ELSE 0 END,
                    lease = $5, reused_step_id = $6, checkpoint = $7, output = $8,
                    validation = $9, usage = $10, error = $11, updated_at = now(),
                    completed_at = CASE WHEN $12::boolean THEN now() END
              WHERE run_id = $13 AND step_key = $14
              RETURNING *`,
            values,
          )
        : await one(
            tx,
            `INSERT INTO analysis_step
                    (id, project_id, run_id, step_key, step_version, kind, cache_key,
                     hash_version, status, attempt, lease, reused_step_id, checkpoint, output,
                     validation, usage, error, created_at, updated_at, completed_at)
             VALUES ($15, $16, $13, $14, $1, $2, $3, 'c14n-v1', $4, 1, $5, $6, $7, $8, $9, $10,
                     $11, now(), now(), CASE WHEN $12::boolean THEN now() END)
             RETURNING *`,
            [...values, newId(), owner.project_id],
          );
      return row ? stepOf(row) : null;
    });
  }

  // ── objects and revisions ───────────────────────────────────────────

  /**
   * The object of this lineage, created when new. A fixed `objectId` (a deterministic
   * import id) must name this lineage's object.
   */
  async ensureObject(o: {
    projectId: string;
    type: string;
    lineageKey: string;
    scopeId: string | null;
    objectId?: string | null;
  }): Promise<ObjectRecord> {
    let objectId = o.objectId ?? null;
    if (objectId !== null) {
      if (!isUuid(objectId))
        throw new AnalysisValidationError(`object id '${objectId}' is not a uuid`);
      objectId = canonicalUuid(objectId);
    }
    // No conflict target: a taken id is caught below, never raised.
    let row = await one(
      this.sql,
      `INSERT INTO analysis_object
              (id, project_id, type, lineage_key, scope_id, revision_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, now(), now())
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [objectId ?? newId(), o.projectId, o.type, o.lineageKey, o.scopeId],
    );
    if (!row)
      row = await one(
        this.sql,
        "SELECT * FROM analysis_object WHERE project_id = $1 AND type = $2 AND lineage_key = $3",
        [o.projectId, o.type, o.lineageKey],
      );
    if (!row) {
      if (objectId !== null)
        throw new ReferenceViolation(`object id ${objectId} names another object`);
      throw new AnalysisStoreError("object vanished after a conflicting insert");
    }
    const record = objectOf(row);
    if (objectId !== null && record.id !== objectId)
      throw new ReferenceViolation(`object '${o.lineageKey}' already exists under another id`);
    return record;
  }

  async getObject(objectId: string): Promise<ObjectRecord | null> {
    if (!isUuid(objectId)) return null;
    const row = await one(this.sql, "SELECT * FROM analysis_object WHERE id = $1", [objectId]);
    return row ? objectOf(row) : null;
  }

  async getRevisions(
    projectId: string,
    revisionIds: readonly string[],
  ): Promise<Map<string, ObjectRevision>> {
    const ids = uuids(revisionIds);
    if (!ids.length) return new Map();
    const rows = await q(
      this.sql,
      "SELECT * FROM analysis_object_revision WHERE project_id = $1 AND id = ANY($2::uuid[])",
      [projectId, ids],
    );
    return new Map(rows.map((r) => [String(r.id), revisionOf(r)]));
  }

  /** Every published head in a project, keyed by object identity. */
  async currentRevisions(
    projectId: string,
    scopeIds: readonly string[] | null = null,
  ): Promise<Map<string, ObjectRevision>> {
    const rows = await q(
      this.sql,
      `SELECT r.* FROM analysis_object AS o
         JOIN analysis_object_revision AS r ON r.id = o.current_revision_id
        WHERE o.project_id = $1 AND r.status = 'published'
          AND ($2::uuid[] IS NULL OR o.scope_id = ANY($2::uuid[]))`,
      [projectId, scopeIds ? [...scopeIds] : null],
    );
    return new Map(rows.map((r) => [String(r.object_id), revisionOf(r)]));
  }

  private static revisionValues(n: NewRevision, id: string, number: number, status: string) {
    return [
      id,
      n.projectId,
      n.objectId,
      number,
      n.type,
      n.schemaVersion,
      status,
      n.origin,
      J(n.payload),
      J(n.attributes),
      J(provenanceJson(n.provenance)),
      n.contentHash,
      n.runId ?? null,
      n.parentRevisionId ?? null,
      J(n.embeddingRefs ?? null),
      n.actorId ?? null,
      n.reason ?? null,
      n.changeKind ?? null,
      status === "published",
    ];
  }

  private static readonly INSERT_REVISION = `INSERT INTO analysis_object_revision
          (id, project_id, object_id, revision_number, type, schema_version, status, origin,
           payload, attributes, provenance, content_hash, hash_version, run_id,
           parent_revision_id, embedding_refs, actor_id, reason, change_kind, created_at,
           published_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'c14n-v1', $13, $14, $15, $16,
            $17, $18, now(), CASE WHEN $19::boolean THEN now() END)
    RETURNING *`;

  /** Stages (or, on a replay, replaces) this run's candidate revision of an object. */
  async stageRevision(
    runId: string,
    lease: string,
    n: NewRevision,
  ): Promise<ObjectRevision | null> {
    if (n.status !== "staged" && n.status !== "candidate")
      throw new Error("stageRevision writes staged or candidate revisions only");
    if (n.runId !== runId || n.provenance.runId !== runId)
      throw new ReferenceViolation("a staged revision names the run that stages it");
    return this.owned(runId, lease, async (tx, owner) => {
      if (!owner) return null;
      if (owner.project_id !== n.projectId)
        throw new ReferenceViolation("a run stages revisions of its own project only");
      const existing = await one<{ id: string }>(
        tx,
        `SELECT id::text AS id FROM analysis_object_revision
          WHERE run_id = $1 AND object_id = $2 AND status IN ('staged', 'candidate')
          FOR UPDATE`,
        [runId, n.objectId],
      );
      if (existing) {
        const row = await one(
          tx,
          `UPDATE analysis_object_revision
              SET status = $1, schema_version = $2, payload = $3, attributes = $4,
                  provenance = $5, content_hash = $6, parent_revision_id = $7,
                  embedding_refs = $8
            WHERE id = $9
            RETURNING *`,
          [
            n.status,
            n.schemaVersion,
            J(n.payload),
            J(n.attributes),
            J(provenanceJson(n.provenance)),
            n.contentHash,
            n.parentRevisionId ?? null,
            J(n.embeddingRefs ?? null),
            existing.id,
          ],
        );
        return row ? revisionOf(row) : null;
      }
      const counted = await one<{ revision_count: number }>(
        tx,
        `UPDATE analysis_object SET revision_count = revision_count + 1, updated_at = now()
          WHERE id = $1 AND project_id = $2 AND type = $3
          RETURNING revision_count`,
        [n.objectId, n.projectId, n.type],
      );
      if (!counted)
        throw new ReferenceViolation(`object ${n.objectId} is not a ${n.type} of this project`);
      const row = await one(
        tx,
        AnalysisStore.INSERT_REVISION,
        AnalysisStore.revisionValues(
          n,
          n.revisionId ?? newId(),
          Number(counted.revision_count),
          n.status,
        ),
      );
      if (!row) throw new AnalysisStoreError("the revision insert returned nothing");
      return revisionOf(row);
    });
  }

  /**
   * Publishes an authored or imported revision as the object's new head, only when the
   * head is still `expected`. The scope is locked first, as publication locks it, and the
   * head change commits with its outbox event and the scope's next publication sequence.
   */
  async appendRevision(n: NewRevision, expected: string | null): Promise<ObjectRevision> {
    if (n.origin === "generated") throw new Error("generated revisions publish through their run");
    return this.tx(async (tx) => {
      const located = await one<{ scope_id: string | null; type: string }>(
        tx,
        "SELECT scope_id::text AS scope_id, type FROM analysis_object WHERE id = $1 AND project_id = $2",
        [n.objectId, n.projectId],
      );
      if (!located || located.type !== n.type)
        throw new ReferenceViolation(`object ${n.objectId} is not a ${n.type} of this project`);
      if (located.scope_id === null)
        throw new ReferenceViolation(`object ${n.objectId} has no scope to publish its edits in`);
      if (n.embeddingRefs) {
        const embeddingId = String(n.embeddingRefs.embeddingId ?? "");
        if (!isUuid(embeddingId))
          throw new ReferenceViolation("an embedding reference names an embedding id");
        const embedding = await one<{ project_id: string; config_key: string }>(
          tx,
          "SELECT project_id::text AS project_id, config_key FROM map_embedding WHERE id = $1",
          [embeddingId],
        );
        if (!embedding || embedding.project_id !== n.projectId)
          throw new ReferenceViolation(
            "the revision references an embedding that is not this project's",
          );
        const wanted = n.embeddingRefs.configKey;
        if (wanted && embedding.config_key !== wanted)
          throw new ReferenceViolation(
            "the revision references an embedding of another configuration",
          );
      }
      const scopeRow = await one(tx, "SELECT * FROM analysis_scope WHERE id = $1 FOR UPDATE", [
        located.scope_id,
      ]);
      if (!scopeRow) throw new AnalysisStoreError("the object's scope vanished");
      const scope = scopeOf(scopeRow);
      const locked = await one(tx, "SELECT * FROM analysis_object WHERE id = $1 FOR UPDATE", [
        n.objectId,
      ]);
      if (!locked) throw new AnalysisStoreError("the object vanished under its lock");
      if (n.revisionId) {
        const already = await one(tx, "SELECT * FROM analysis_object_revision WHERE id = $1", [
          n.revisionId,
        ]);
        if (already) {
          if (String(already.object_id) !== n.objectId)
            throw new ReferenceViolation(`revision ${n.revisionId} belongs to another object`);
          return revisionOf(already);
        }
      }
      const head = (locked.current_revision_id as string | null) ?? null;
      if (head !== expected) {
        let current: ObjectRevision | null = null;
        if (head) {
          const h = await one(tx, "SELECT * FROM analysis_object_revision WHERE id = $1", [head]);
          current = h ? revisionOf(h) : null;
        }
        throw new RevisionConflict(n.objectId, expected, current);
      }
      const counted = await one<{ revision_count: number }>(
        tx,
        "UPDATE analysis_object SET revision_count = revision_count + 1 WHERE id = $1 RETURNING revision_count",
        [n.objectId],
      );
      const row = await one(
        tx,
        AnalysisStore.INSERT_REVISION,
        AnalysisStore.revisionValues(
          n,
          n.revisionId ?? newId(),
          Number(counted?.revision_count),
          "published",
        ),
      );
      if (!row) throw new AnalysisStoreError("the revision insert returned nothing");
      await q(
        tx,
        "UPDATE analysis_object SET current_revision_id = $1, updated_at = now() WHERE id = $2",
        [row.id, n.objectId],
      );
      const sequence = scope.publicationSequence + 1;
      await q(
        tx,
        "UPDATE analysis_scope SET publication_sequence = $1, updated_at = now() WHERE id = $2",
        [sequence, scope.id],
      );
      const eventId = newId();
      await q(
        tx,
        `INSERT INTO analysis_outbox
                (id, project_id, scope_id, sequence, event_type, payload, status, attempts,
                 next_attempt_at, consumers, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'revision_published', $5, 'pending', 0, now(), '{}', now(), now())`,
        [
          eventId,
          n.projectId,
          scope.id,
          sequence,
          J({
            objectId: n.objectId,
            revisionId: row.id,
            type: n.type,
            origin: n.origin,
            recipeId: n.provenance.recipeId ?? null,
            membershipExcluded: Boolean(n.provenance.extra?.membershipExcluded),
            previousRevisionId: expected,
            sequence,
          }),
        ],
      );
      this.fault("append:outbox");
      await this.afterPublication?.(tx, eventId);
      return revisionOf(row);
    });
  }

  async stageRelation(runId: string, lease: string, n: NewRelation): Promise<Relation | null> {
    if (n.runId !== runId)
      throw new ReferenceViolation("a staged relation names the run that stages it");
    return this.owned(runId, lease, async (tx, owner) => {
      if (!owner) return null;
      const row = await one(
        tx,
        `INSERT INTO analysis_relation
                (id, project_id, type, basis, status, from_revision_id, to_revision_id,
                 from_object_id, to_object_id, attributes, provenance, content_hash,
                 hash_version, run_id, created_at)
         VALUES ($1, $2, $3, $4, 'staged', $5, $6, $7, $8, $9, $10, $11, 'c14n-v1', $12, now())
         ON CONFLICT (run_id, type, from_revision_id, to_revision_id)
             WHERE status = 'staged'
         DO UPDATE SET basis = EXCLUDED.basis, attributes = EXCLUDED.attributes,
                       provenance = EXCLUDED.provenance,
                       content_hash = EXCLUDED.content_hash
         RETURNING *`,
        [
          newId(),
          owner.project_id,
          n.type,
          n.basis,
          n.fromRevisionId,
          n.toRevisionId,
          n.fromObjectId,
          n.toObjectId,
          J(n.attributes),
          J(n.provenance),
          n.contentHash,
          runId,
        ],
      );
      return row ? relationOf(row) : null;
    });
  }

  /** Publishes an imported relation between two published revisions; a repeat returns the first row. */
  async importRelation(n: NewRelation, relationIdIn: string | null = null): Promise<Relation> {
    if (n.runId) throw new ReferenceViolation("an imported relation belongs to no run");
    let relationId = relationIdIn;
    if (relationId !== null) {
      if (!isUuid(relationId))
        throw new AnalysisValidationError(`relation id '${relationId}' is not a uuid`);
      relationId = canonicalUuid(relationId);
    }
    const identity = [n.projectId, n.type, n.fromRevisionId, n.toRevisionId, n.contentHash];
    return this.tx(async (tx) => {
      await q(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `analysis_relation_import:${n.projectId}:${n.contentHash}`,
      ]);
      const existing = relationId
        ? await one(tx, "SELECT * FROM analysis_relation WHERE id = $1", [relationId])
        : await one(
            tx,
            `SELECT * FROM analysis_relation
              WHERE project_id = $1 AND type = $2 AND from_revision_id = $3
                AND to_revision_id = $4 AND content_hash = $5
                AND run_id IS NULL AND status = 'published'
              LIMIT 1`,
            identity,
          );
      if (existing) {
        const found = [
          existing.project_id,
          existing.type,
          existing.from_revision_id,
          existing.to_revision_id,
          existing.content_hash,
        ].map(String);
        if (found.join("|") !== identity.join("|") || existing.run_id !== null)
          throw new ReferenceViolation(`relation id ${relationId} names another relation`);
        return relationOf(existing);
      }
      const ends = uuids([n.fromRevisionId, n.toRevisionId]);
      const published = new Map<string, string>();
      if (ends.length === 2)
        for (const r of await q(
          tx,
          `SELECT id::text AS id, object_id::text AS object_id FROM analysis_object_revision
            WHERE project_id = $1 AND status = 'published' AND id = ANY($2::uuid[])
            FOR SHARE`,
          [n.projectId, ends],
        ))
          published.set(String(r.id), String(r.object_id));
      if (
        published.get(n.fromRevisionId) !== n.fromObjectId ||
        published.get(n.toRevisionId) !== n.toObjectId
      )
        throw new ReferenceViolation(
          "an imported relation connects published revisions of its objects in this project",
        );
      const row = await one(
        tx,
        `INSERT INTO analysis_relation
                (id, project_id, type, basis, status, from_revision_id, to_revision_id,
                 from_object_id, to_object_id, attributes, provenance, content_hash,
                 hash_version, run_id, created_at, published_at)
         VALUES ($1, $2, $3, $4, 'published', $5, $6, $7, $8, $9, $10, $11, 'c14n-v1', NULL,
                 now(), now())
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          relationId ?? newId(),
          n.projectId,
          n.type,
          n.basis,
          n.fromRevisionId,
          n.toRevisionId,
          n.fromObjectId,
          n.toObjectId,
          J(n.attributes),
          J(n.provenance),
          n.contentHash,
        ],
      );
      if (!row) throw new ReferenceViolation(`relation id ${relationId} names another relation`);
      return relationOf(row);
    });
  }

  async runCandidates(runId: string): Promise<[ObjectRevision[], Relation[]]> {
    const revisions = await q(
      this.sql,
      `SELECT * FROM analysis_object_revision
        WHERE run_id = $1 AND status IN ('staged', 'candidate') ORDER BY created_at`,
      [runId],
    );
    const relations = await q(
      this.sql,
      "SELECT * FROM analysis_relation WHERE run_id = $1 AND status = 'staged' ORDER BY created_at",
      [runId],
    );
    return [revisions.map(revisionOf), relations.map(relationOf)];
  }

  async getRelations(
    projectId: string,
    relationIds: readonly string[],
  ): Promise<Map<string, Relation>> {
    const ids = uuids(relationIds);
    if (!ids.length) return new Map();
    const rows = await q(
      this.sql,
      "SELECT * FROM analysis_relation WHERE project_id = $1 AND id = ANY($2::uuid[])",
      [projectId, ids],
    );
    return new Map(rows.map((r) => [String(r.id), relationOf(r)]));
  }

  /**
   * The latest published assessment of each exact revision, keyed by that revision's id,
   * with the `assesses` relation's id added to its provenance extra. For assembling new
   * snapshots only; an existing snapshot pins its assessments.
   */
  async assessmentsFor(
    projectId: string,
    revisionIds: readonly string[],
  ): Promise<Map<string, ObjectRevision>> {
    const ids = uuids(revisionIds);
    if (!ids.length) return new Map();
    const rows = await q(
      this.sql,
      `SELECT DISTINCT ON (rel.to_revision_id)
              rel.to_revision_id::text AS target_revision_id,
              rel.id::text AS relation_id, v.*
         FROM analysis_relation AS rel
         JOIN analysis_object_revision AS v ON v.id = rel.from_revision_id
        WHERE rel.project_id = $1 AND rel.type = 'assesses'
          AND rel.status = 'published' AND v.status = 'published'
          AND v.type = 'fact_check_assessment'
          AND rel.to_revision_id = ANY($2::uuid[])
        ORDER BY rel.to_revision_id, v.published_at DESC, v.revision_number DESC`,
      [projectId, ids],
    );
    const out = new Map<string, ObjectRevision>();
    for (const r of rows) {
      const revision = revisionOf(r);
      out.set(String(r.target_revision_id), {
        ...revision,
        provenance: {
          ...revision.provenance,
          extra: {
            ...(revision.provenance.extra ?? {}),
            assessesRelationId: String(r.relation_id),
          },
        },
      });
    }
    return out;
  }

  // ── manifest validation, inside a transaction ───────────────────────

  private async checkRevisions(
    tx: Sql,
    projectId: string,
    entries: Json[],
    stagedRunId: string | null,
    reasons: string[],
  ): Promise<Map<string, Row>> {
    const objectIds = entries.map((e) => String(e.objectId));
    const revisionIds = entries.map((e) => String(e.revisionId));
    if (new Set(objectIds).size !== objectIds.length)
      reasons.push("the manifest shows more than one revision of one object");
    if (new Set(revisionIds).size !== revisionIds.length)
      reasons.push("the manifest lists a revision twice");
    const bad = revisionIds.filter((r) => !isUuid(r));
    if (bad.length) reasons.push(`${bad.length} revision ids are not ids`);
    const rows = new Map<string, Row>();
    if (uuids(revisionIds).length)
      for (const r of await q(
        tx,
        `SELECT id::text AS id, project_id::text AS project_id, object_id::text AS object_id,
                type, status, run_id::text AS run_id,
                parent_revision_id::text AS parent_revision_id, provenance, embedding_refs
           FROM analysis_object_revision WHERE id = ANY($1::uuid[])`,
        [uuids(revisionIds)],
      ))
        rows.set(String(r.id), r);
    for (const entry of entries) {
      const rid = String(entry.revisionId);
      const row = rows.get(rid);
      if (!row) {
        if (isUuid(rid)) reasons.push(`revision ${rid} does not exist`);
        continue;
      }
      if (row.project_id !== projectId) reasons.push(`revision ${rid} belongs to another project`);
      else if (row.object_id !== entry.objectId || row.type !== entry.type)
        reasons.push(`revision ${rid} is not a ${entry.type} of object ${entry.objectId}`);
      else if (row.status === "published") continue;
      else if (row.status === "staged" && stagedRunId && row.run_id === stagedRunId) continue;
      else reasons.push(`revision ${rid} is ${row.status}, not publishable here`);
    }
    return rows;
  }

  private async checkRelations(
    tx: Sql,
    projectId: string,
    entries: Json[],
    endpoints: Set<string>,
    stagedRunId: string | null,
    reasons: string[],
  ): Promise<void> {
    const ids = entries.map((e) => String(e.relationId));
    if (new Set(ids).size !== ids.length) reasons.push("the manifest lists a relation twice");
    const rows = new Map<string, Row>();
    if (uuids(ids).length)
      for (const r of await q(
        tx,
        `SELECT id::text AS id, project_id::text AS project_id, type, status,
                run_id::text AS run_id, from_revision_id::text AS from_revision_id,
                to_revision_id::text AS to_revision_id
           FROM analysis_relation WHERE id = ANY($1::uuid[])`,
        [uuids(ids)],
      ))
        rows.set(String(r.id), r);
    for (const entry of entries) {
      const rid = String(entry.relationId);
      const row = rows.get(rid);
      if (!row) {
        reasons.push(`relation ${rid} does not exist`);
        continue;
      }
      if (row.project_id !== projectId) {
        reasons.push(`relation ${rid} belongs to another project`);
        continue;
      }
      if (
        row.type !== entry.type ||
        row.from_revision_id !== entry.from ||
        row.to_revision_id !== entry.to
      ) {
        reasons.push(`relation ${rid} does not match its manifest entry`);
        continue;
      }
      if (
        !(
          row.status === "published" ||
          (row.status === "staged" && stagedRunId && row.run_id === stagedRunId)
        )
      ) {
        reasons.push(`relation ${rid} is ${row.status}, not publishable here`);
        continue;
      }
      for (const end of [row.from_revision_id, row.to_revision_id])
        if (!endpoints.has(String(end)))
          reasons.push(`relation ${rid} points at revision ${end}, which is not in this output`);
    }
  }

  private async publishedRevisionIds(
    tx: Sql,
    projectId: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (!uuids(ids).length) return new Set();
    const rows = await q(
      tx,
      `SELECT id::text AS id FROM analysis_object_revision
        WHERE project_id = $1 AND status = 'published' AND id = ANY($2::uuid[])`,
      [projectId, uuids(ids)],
    );
    return new Set(rows.map((r) => String(r.id)));
  }

  /** Staged revisions name this run and recipe and cite only pinned inputs; embeddings are this project's. */
  private async checkStagedReferences(
    tx: Sql,
    run: Run,
    entries: Row[],
    pinned: Set<string>,
    reasons: string[],
  ): Promise<void> {
    const refs = new Map<string, Json>();
    for (const row of entries) {
      if (row.status === "staged") {
        const p = (row.provenance as Json | null) ?? {};
        if (
          p.runId !== run.id ||
          p.recipeId !== run.recipeId ||
          p.recipeVersion !== run.recipeVersion
        )
          reasons.push(`revision ${row.id} names another run or recipe in its provenance`);
        const stray = ((p.inputRevisionIds as unknown[] | undefined) ?? []).filter(
          (r) => !pinned.has(String(r)),
        );
        if (stray.length)
          reasons.push(
            `revision ${row.id} cites ${stray.length} revisions that are not pinned inputs`,
          );
      }
      const ref = (row.embedding_refs as Json | null) ?? {};
      if (ref.embeddingId) refs.set(String(row.id), ref);
    }
    const wanted = uuids([...refs.values()].map((r) => String(r.embeddingId)));
    if (wanted.length !== refs.size) reasons.push("an embedding reference is not an id");
    const found = new Map<string, Row>();
    if (wanted.length)
      for (const r of await q(
        tx,
        "SELECT id::text AS id, project_id::text AS project_id, config_key FROM map_embedding WHERE id = ANY($1::uuid[])",
        [wanted],
      ))
        found.set(String(r.id), r);
    for (const [revisionId, ref] of refs) {
      const e = found.get(String(ref.embeddingId));
      if (!e || e.project_id !== run.projectId)
        reasons.push(`revision ${revisionId} references an embedding that is not this project's`);
      else if (ref.configKey && e.config_key !== ref.configKey)
        reasons.push(`revision ${revisionId} references an embedding of another configuration`);
    }
  }

  /** Every step completed, no recorded check failed, every declared check step ran. */
  private async checkSteps(tx: Sql, run: Run, checks: Json[], reasons: string[]): Promise<void> {
    for (const outcome of checks)
      if (outcome.status === "failed" || outcome.status === "needs_review")
        reasons.push(`check ${outcome.check} is ${outcome.status}`);
    const steps = await q(
      tx,
      "SELECT step_key, status, validation FROM analysis_step WHERE run_id = $1",
      [run.id],
    );
    for (const step of steps) {
      if (step.status !== "completed") reasons.push(`step ${step.step_key} is ${step.status}`);
      for (const outcome of (step.validation as Json[] | null) ?? [])
        if (outcome.status === "failed" || outcome.status === "needs_review")
          reasons.push(
            `step ${step.step_key} recorded check ${outcome.check} as ${outcome.status}`,
          );
    }
    const declared = ((run.definition.steps as Json[] | undefined) ?? [])
      .filter((s) => s.kind === "check")
      .map((s) => String(s.key));
    const keys = steps.filter((s) => s.status === "completed").map((s) => String(s.step_key));
    for (const key of declared)
      if (!keys.some((k) => k === key || k.startsWith(`${key}:`)))
        reasons.push(`required check step ${key} did not run`);
  }

  // ── publication ─────────────────────────────────────────────────────

  /**
   * Makes a run its scope's current ready output in one transaction: lock scope and run,
   * recheck lease, deadline, fence and request order, validate the manifest against the
   * pinned inputs, staged rows, embeddings, steps, checks and every entry's expected head,
   * publish the staged rows, advance the heads and append the outbox event. Everything
   * commits together or nothing does.
   */
  async publishRun(
    runId: string,
    lease: string,
    o: { manifest: Json; checks: Json[]; metrics: Json },
  ): Promise<PublishResult> {
    const run = await this.getRun(runId);
    if (!run) return { outcome: "inactive" };
    return this.tx(async (tx): Promise<PublishResult> => {
      const scopeRow = await one(tx, "SELECT * FROM analysis_scope WHERE id = $1 FOR UPDATE", [
        run.scopeId,
      ]);
      const runRow = await one(tx, "SELECT * FROM analysis_run WHERE id = $1 FOR UPDATE", [runId]);
      if (!scopeRow || !runRow) return { outcome: "inactive" };
      const locked = runOf(runRow);
      const scope = scopeOf(scopeRow);
      if (
        locked.status !== "running" ||
        locked.lease !== lease ||
        !(await leaseLive(tx, runId)) ||
        scope.writer !== "analysis" ||
        scope.writerFence !== locked.writerFence
      )
        return { outcome: "inactive" };
      if (scope.currentRequestOrder !== null && scope.currentRequestOrder >= locked.requestOrder) {
        await q(
          tx,
          "UPDATE analysis_run SET status = 'superseded', completed_at = now(), updated_at = now() WHERE id = $1",
          [runId],
        );
        return { outcome: "superseded" };
      }
      this.fault("publish:locked");

      const reasons: string[] = [];
      const pinnedManifest = locked.inputManifest;
      const pinned = new Set(
        ((pinnedManifest?.revisionIds as unknown[] | undefined) ?? []).map(String),
      );
      const inputs = (o.manifest.inputs as Json | undefined) ?? {};
      if (!pinnedManifest) reasons.push("the run's inputs were never pinned");
      else if (
        sortedStrings(((inputs.revisionIds as unknown[] | undefined) ?? []).map(String)).join(
          "|",
        ) !== sortedStrings(pinned).join("|") ||
        inputs.fingerprint !== locked.inputFingerprint
      )
        reasons.push("the manifest's inputs are not the run's pinned inputs");
      else if (
        contentHash({ ...((inputs.dependencies as Json | undefined) ?? {}) }) !==
        contentHash({ ...((pinnedManifest.dependencies as Json | undefined) ?? {}) })
      )
        reasons.push("the manifest's input dependencies are not the run's pinned dependencies");
      const objects = [...((o.manifest.objects as Json[] | undefined) ?? [])];
      const revisionRows = await this.checkRevisions(tx, locked.projectId, objects, runId, reasons);
      const publishedInputs = await this.publishedRevisionIds(
        tx,
        locked.projectId,
        sortedStrings(pinned),
      );
      if (publishedInputs.size !== pinned.size)
        reasons.push(
          `${pinned.size - publishedInputs.size} pinned input revisions are not published in this project`,
        );
      await this.checkRelations(
        tx,
        locked.projectId,
        [...((o.manifest.relations as Json[] | undefined) ?? [])],
        new Set([...objects.map((x) => String(x.revisionId)), ...publishedInputs]),
        runId,
        reasons,
      );
      const staged = [...revisionRows.values()].filter((r) => r.status === "staged");
      const entries = [...revisionRows.values()].filter(
        (r) => r.status === "staged" || r.status === "published",
      );
      await this.checkStagedReferences(tx, locked, entries, pinned, reasons);
      await this.checkSteps(tx, locked, o.checks, reasons);
      if (reasons.length) throw new PublicationRejected(reasons);

      // Every entry expects a head: a staged revision its parent, a reused revision itself.
      const conflicts = await headConflicts(
        tx,
        new Map(
          entries.map((r) => [
            String(r.object_id),
            r.status === "staged"
              ? ((r.parent_revision_id as string | null) ?? null)
              : String(r.id),
          ]),
        ),
      );
      if (conflicts.length) return { outcome: "conflict", conflicts: sortedStrings(conflicts) };
      this.fault("publish:validated");

      const stagedIds = staged.map((r) => String(r.id));
      const relationIds = uuids(
        ((o.manifest.relations as Json[] | undefined) ?? []).map((r) => String(r.relationId)),
      );
      await q(
        tx,
        `UPDATE analysis_object_revision SET status = 'published', published_at = now()
          WHERE run_id = $1 AND status = 'staged' AND id = ANY($2::uuid[])`,
        [runId, stagedIds],
      );
      await q(
        tx,
        "UPDATE analysis_object_revision SET status = 'discarded' WHERE run_id = $1 AND status IN ('staged', 'candidate')",
        [runId],
      );
      await q(
        tx,
        `UPDATE analysis_relation SET status = 'published', published_at = now()
          WHERE run_id = $1 AND status = 'staged' AND id = ANY($2::uuid[])`,
        [runId, relationIds],
      );
      await q(
        tx,
        "UPDATE analysis_relation SET status = 'discarded' WHERE run_id = $1 AND status = 'staged'",
        [runId],
      );
      if (stagedIds.length)
        await q(
          tx,
          `UPDATE analysis_object AS o SET current_revision_id = v.id, updated_at = now()
             FROM analysis_object_revision AS v
            WHERE v.id = ANY($1::uuid[]) AND o.id = v.object_id`,
          [stagedIds],
        );
      this.fault("publish:heads");

      const sequence = scope.publicationSequence + 1;
      const finalManifest = { ...o.manifest, publicationSequence: sequence };
      await q(
        tx,
        `UPDATE analysis_run
            SET status = 'ready', output_manifest = $1, checks = $2, metrics = $3,
                progress = (COALESCE(progress::jsonb, '{}'::jsonb)
                            || jsonb_build_object('stage', 'ready'))::json,
                completed_at = now(), updated_at = now()
          WHERE id = $4`,
        [J(finalManifest), J(o.checks), J(o.metrics), runId],
      );
      await q(
        tx,
        `UPDATE analysis_scope
            SET current_run_id = $1, current_request_order = $2,
                publication_sequence = $3, updated_at = now()
          WHERE id = $4`,
        [runId, locked.requestOrder, sequence, scope.id],
      );
      const eventId = newId();
      await q(
        tx,
        `INSERT INTO analysis_outbox
                (id, project_id, scope_id, sequence, event_type, run_id, payload, status,
                 attempts, next_attempt_at, consumers, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'run_published', $5, $6, 'pending', 0, now(), '{}', now(), now())`,
        [
          eventId,
          locked.projectId,
          scope.id,
          sequence,
          runId,
          J({
            recipeId: locked.recipeId,
            recipeVersion: locked.recipeVersion,
            scopeKey: scope.scopeKey,
            runId,
            manifestHash: o.manifest.contentHash ?? null,
            sequence,
          }),
        ],
      );
      this.fault("publish:outbox");
      await this.afterPublication?.(tx, eventId);
      return { outcome: "ready", eventId, sequence };
    });
  }

  /**
   * Called inside every transaction that appends an outbox event (run publication,
   * snapshot publication), so the dispatch workflow is enqueued with the commit that
   * causes it. The executor sets it; tests leave it unset.
   */
  afterPublication: ((tx: Sql, eventId: string) => Promise<void>) | null = null;

  // ── snapshots ───────────────────────────────────────────────────────

  /**
   * Inserts a view snapshot and advances its view scope, only when the scope is still at
   * `expectedPrevious`. A snapshot already assembled for the same source event is returned
   * instead; identical content returns the current snapshot.
   */
  async publishSnapshot(n: NewSnapshot, expectedPrevious: string | null): Promise<Snapshot> {
    return this.tx(async (tx) => {
      const scopeRow = await one(
        tx,
        "SELECT * FROM analysis_scope WHERE id = $1 AND project_id = $2 AND kind = 'view' FOR UPDATE",
        [n.scopeId, n.projectId],
      );
      if (!scopeRow)
        throw new ReferenceViolation(`view scope ${n.scopeId} does not exist in this project`);
      const scope = scopeOf(scopeRow);
      if (n.sourceEventId) {
        const effect = await one(
          tx,
          "SELECT * FROM analysis_snapshot WHERE scope_id = $1 AND source_event_id = $2",
          [scope.id, n.sourceEventId],
        );
        if (effect) return snapshotOf(effect);
      }
      if (scope.currentSnapshotId !== expectedPrevious)
        throw new SnapshotConflict(scope.id, expectedPrevious, scope.currentSnapshotId);
      if (scope.currentSnapshotId) {
        const current = await one(tx, "SELECT * FROM analysis_snapshot WHERE id = $1", [
          scope.currentSnapshotId,
        ]);
        if (current && current.content_hash === n.contentHash) return snapshotOf(current);
      }

      const reasons: string[] = [];
      const objects = [...((n.manifest.objects as Json[] | undefined) ?? [])];
      await this.checkRevisions(tx, n.projectId, objects, null, reasons);
      const displayed = new Set(objects.map((o) => String(o.revisionId)));
      const vectors = [...((n.manifest.vectors as Json[] | undefined) ?? [])];
      if (vectors.length) {
        const configKey = n.embeddingConfig?.key;
        const embeddings = new Map<string, Row>();
        for (const r of await q(
          tx,
          "SELECT id::text AS id, project_id::text AS project_id, config_key FROM map_embedding WHERE id = ANY($1::uuid[])",
          [uuids(vectors.map((v) => String(v.embeddingId)))],
        ))
          embeddings.set(String(r.id), r);
        for (const entry of vectors) {
          const e = embeddings.get(String(entry.embeddingId));
          if (!displayed.has(String(entry.revisionId)))
            reasons.push(`a vector names revision ${entry.revisionId}, which is not displayed`);
          else if (!e || e.project_id !== n.projectId || (configKey && e.config_key !== configKey))
            reasons.push(`the vector of revision ${entry.revisionId} is not of this configuration`);
        }
      }
      await this.checkRelations(
        tx,
        n.projectId,
        [...((n.manifest.relations as Json[] | undefined) ?? [])],
        displayed,
        null,
        reasons,
      );
      const assessments = [...((n.manifest.assessments as Json[] | undefined) ?? [])];
      if (assessments.length) {
        const tuples = new Map<string, string>();
        for (const r of await q(
          tx,
          `SELECT rel.id::text AS id, rel.from_revision_id::text AS assessment,
                  rel.to_revision_id::text AS target
             FROM analysis_relation AS rel
             JOIN analysis_object_revision AS v ON v.id = rel.from_revision_id
            WHERE rel.project_id = $1 AND rel.type = 'assesses' AND rel.status = 'published'
              AND v.project_id = $1 AND v.status = 'published'
              AND v.type = 'fact_check_assessment' AND rel.id = ANY($2::uuid[])`,
          [n.projectId, uuids(assessments.map((a) => String(a.relationId)))],
        ))
          tuples.set(String(r.id), `${r.assessment}|${r.target}`);
        for (const entry of assessments) {
          const expected = `${entry.revisionId}|${entry.targetRevisionId}`;
          if (tuples.get(String(entry.relationId)) !== expected)
            reasons.push(
              `assessment entry ${entry.relationId} is not that assessment of that revision`,
            );
          else if (!displayed.has(String(entry.targetRevisionId)))
            reasons.push(
              `an assessment names revision ${entry.targetRevisionId}, which the snapshot does not display`,
            );
        }
      }
      const producers = ((n.manifest.producers as Json[] | undefined) ?? []).filter((p) => p.runId);
      if (producers.length) {
        const rows = await q(
          tx,
          `SELECT id::text AS id FROM analysis_run
            WHERE project_id = $1 AND status = 'ready' AND id = ANY($2::uuid[])`,
          [n.projectId, uuids(producers.map((p) => String(p.runId)))],
        );
        if (
          new Set(rows.map((r) => String(r.id))).size !==
          new Set(producers.map((p) => p.runId)).size
        )
          reasons.push("a producer output is not a ready run of this project");
      }
      if (reasons.length) throw new PublicationRejected(reasons);
      this.fault("snapshot:validated");

      const snapshotId = newId();
      const row = await one(
        tx,
        `INSERT INTO analysis_snapshot
                (id, project_id, scope_id, parent_snapshot_id, view_id, manifest_version,
                 manifest, settings, versions, embedding_config, content_hash, hash_version,
                 created_by, source_event_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'c14n-v1', $12, $13, now())
         RETURNING *`,
        [
          snapshotId,
          n.projectId,
          scope.id,
          scope.currentSnapshotId,
          n.viewId,
          n.manifestVersion ?? 1,
          J(n.manifest),
          J(n.settings ?? {}),
          J(n.versions ?? {}),
          J(n.embeddingConfig ?? null),
          n.contentHash,
          n.createdBy ?? null,
          n.sourceEventId ?? null,
        ],
      );
      if (!row) throw new AnalysisStoreError("the snapshot insert returned nothing");
      const sequence = scope.publicationSequence + 1;
      await q(
        tx,
        "UPDATE analysis_scope SET current_snapshot_id = $1, publication_sequence = $2, updated_at = now() WHERE id = $3",
        [snapshotId, sequence, scope.id],
      );
      this.fault("snapshot:advanced");
      const eventId = newId();
      await q(
        tx,
        `INSERT INTO analysis_outbox
                (id, project_id, scope_id, sequence, event_type, snapshot_id, payload, status,
                 attempts, next_attempt_at, consumers, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'snapshot_published', $5, $6, 'pending', 0, now(), '{}', now(), now())`,
        [
          eventId,
          n.projectId,
          scope.id,
          sequence,
          snapshotId,
          J({ viewId: n.viewId, scopeKey: scope.scopeKey, snapshotId, sequence }),
        ],
      );
      await this.afterPublication?.(tx, eventId);
      return snapshotOf(row);
    });
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | null> {
    if (!isUuid(snapshotId)) return null;
    const row = await one(this.sql, "SELECT * FROM analysis_snapshot WHERE id = $1", [snapshotId]);
    return row ? snapshotOf(row) : null;
  }

  // ── outbox ──────────────────────────────────────────────────────────

  /**
   * Claims due events (or the one named). A claim expires after `claimSeconds`, so an
   * event whose dispatcher died is claimed again; SKIP LOCKED keeps two dispatchers apart.
   * `dead` claims events past their last attempt, for reconciling internal effects.
   */
  async claimOutbox(o: {
    claim: string;
    limit: number;
    claimSeconds: number;
    eventId?: string | null;
    dead?: boolean;
  }): Promise<OutboxEvent[]> {
    if (o.eventId && !isUuid(o.eventId)) return [];
    const rows = await q(
      this.sql,
      `UPDATE analysis_outbox AS o
          SET status = 'dispatching', claim = $1, attempts = o.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $2),
              updated_at = now()
        WHERE o.id IN (
              SELECT id FROM analysis_outbox
               WHERE status = ANY($3::text[])
                 AND COALESCE(next_attempt_at, created_at) <= now()
                 AND ($4::uuid IS NULL OR id = $4::uuid)
               ORDER BY created_at
               LIMIT $5
               FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [
        o.claim,
        o.claimSeconds,
        o.dead ? ["dead"] : ["pending", "dispatching"],
        o.eventId ?? null,
        o.limit,
      ],
    );
    return rows.map(outboxOf);
  }

  async markConsumerDone(eventId: string, claim: string, consumer: string): Promise<boolean> {
    return (
      (await count(
        this.sql,
        `UPDATE analysis_outbox
            SET consumers = (COALESCE(consumers::jsonb, '{}'::jsonb)
                             || jsonb_build_object($1::text, now()))::json,
                updated_at = now()
          WHERE id = $2 AND claim = $3 AND status = 'dispatching'`,
        [consumer, eventId, claim],
      )) === 1
    );
  }

  async finishOutbox(eventId: string, claim: string): Promise<boolean> {
    return (
      (await count(
        this.sql,
        `UPDATE analysis_outbox
            SET status = 'delivered', delivered_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1 AND claim = $2 AND status = 'dispatching'`,
        [eventId, claim],
      )) === 1
    );
  }

  async retryOutbox(
    eventId: string,
    claim: string,
    o: { error: string; delaySeconds: number; maxAttempts: number },
  ): Promise<boolean> {
    return (
      (await count(
        this.sql,
        `UPDATE analysis_outbox
            SET status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'pending' END,
                next_attempt_at = now() + make_interval(secs => $2),
                last_error = $3, claim = NULL, updated_at = now()
          WHERE id = $4 AND claim = $5 AND status = 'dispatching'`,
        [o.maxAttempts, o.delaySeconds, o.error.slice(0, 2000), eventId, claim],
      )) === 1
    );
  }

  // ── embeddings, over Map's map_embedding table ──────────────────────

  async loadEmbeddings(
    projectId: string,
    configKey: string,
    inputHashes: readonly string[],
  ): Promise<Map<string, [string, number[]]>> {
    if (!inputHashes.length) return new Map();
    const rows = await q(
      this.sql,
      `SELECT id::text AS id, input_hash, embedding::text AS embedding
         FROM map_embedding
        WHERE project_id = $1 AND config_key = $2 AND input_hash = ANY($3::text[])`,
      [projectId, configKey, [...inputHashes]],
    );
    return new Map(
      rows.map((r) => [String(r.input_hash), [String(r.id), parseVector(String(r.embedding))]]),
    );
  }

  /**
   * Inserts once per (project, input, configuration) and returns the row id and the vector
   * as stored. A concurrent writer of the same input loses harmlessly and gets the stored
   * vector back. `dims` is recorded from the vector the model returned, and the column's
   * check (vector_dims(embedding) = dims) holds it to that.
   */
  async saveEmbedding(o: {
    projectId: string;
    inputHash: string;
    configKey: string;
    model: string;
    dims: number;
    vector: readonly number[];
  }): Promise<[string, number[]]> {
    const row = await one(
      this.sql,
      `INSERT INTO map_embedding
              (id, project_id, input_hash, config_key, model, dims, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, now())
       ON CONFLICT (project_id, input_hash, config_key) DO NOTHING
       RETURNING id::text AS id, embedding::text AS embedding`,
      [newId(), o.projectId, o.inputHash, o.configKey, o.model, o.dims, vectorLiteral(o.vector)],
    );
    if (row) return [String(row.id), parseVector(String(row.embedding))];
    const existing = await one(
      this.sql,
      `SELECT id::text AS id, embedding::text AS embedding FROM map_embedding
        WHERE project_id = $1 AND input_hash = $2 AND config_key = $3`,
      [o.projectId, o.inputHash, o.configKey],
    );
    if (!existing)
      throw new AnalysisStoreError("embedding row vanished after a conflicting insert");
    return [String(existing.id), parseVector(String(existing.embedding))];
  }

  async vectorsByIds(projectId: string, ids: readonly string[]): Promise<Map<string, number[]>> {
    const wanted = uuids(ids);
    if (!wanted.length) return new Map();
    const rows = await q(
      this.sql,
      `SELECT id::text AS id, embedding::text AS embedding FROM map_embedding
        WHERE project_id = $1 AND id = ANY($2::uuid[])`,
      [projectId, wanted],
    );
    return new Map(rows.map((r) => [String(r.id), parseVector(String(r.embedding))]));
  }
}

/** Python's str(uuid.UUID(value)): lower-case hyphenated. */
export function canonicalUuid(value: string): string {
  const hex = value
    .replace(/^urn:uuid:/i, "")
    .replace(/[{}-]/g, "")
    .toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
