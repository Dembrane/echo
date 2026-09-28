import { newId } from "@dembrane/core";
import type postgres from "postgres";

/**
 * SQL for Map's own tables: map_result (v1 revisions and v2 pointers to snapshots) and
 * map_fact_check (one operational state per claim revision per project). Every write is
 * one statement guarded by its status and attempt, so a cancelled or superseded check
 * that finishes late changes nothing. Embeddings live with the analysis store.
 */

export const ACTIVE_STATUSES = ["queued", "extracting", "embedding"];

export type Row = Record<string, unknown>;

/** The database failed a Map read or write; the routes answer 503. */
export class MapStoreError extends Error {}

const RESULT_COLUMNS =
  "id::text AS id, project_id::text AS project_id, status, execution_ref, source_fingerprint, recipe_version, embedding_config, progress, manifest, error, requested_by, created_at, updated_at, completed_at";
const FACT_CHECK_COLUMNS =
  "id::text AS id, project_id::text AS project_id, claim_key, statement, status, attempt, verdict, justification, sources, error, model, prompt_version, requested_by, started_at, completed_at, updated_at";

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export class MapStore {
  constructor(readonly sql: postgres.Sql) {}

  private async q<T extends Row = Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    try {
      return (await this.sql.unsafe(text, params as never[])) as unknown as T[];
    } catch (err) {
      throw new MapStoreError(String((err as Error)?.message ?? err).trim());
    }
  }

  private async one<T extends Row = Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    return (await this.q<T>(text, params))[0] ?? null;
  }

  async getResult(resultId: string): Promise<Row | null> {
    if (!UUID.test(resultId.replace(/^\{|\}$/g, ""))) return null;
    return this.one(`SELECT ${RESULT_COLUMNS} FROM map_result WHERE id = $1`, [resultId]);
  }

  activeAttempt(projectId: string): Promise<Row | null> {
    return this.one(
      `SELECT ${RESULT_COLUMNS} FROM map_result WHERE project_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
      [projectId, ACTIVE_STATUSES],
    );
  }

  latestReady(projectId: string): Promise<Row | null> {
    return this.one(
      `SELECT ${RESULT_COLUMNS} FROM map_result WHERE project_id = $1 AND status = 'ready' ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
  }

  latestAttempt(projectId: string): Promise<Row | null> {
    return this.one(
      `SELECT ${RESULT_COLUMNS} FROM map_result WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
  }

  /** A v1 attempt whose worker went quiet is failed, so the page stops showing it as running. */
  async expireStale(projectId: string, staleSeconds: number): Promise<string[]> {
    const rows = await this.q<{ id: string }>(
      `UPDATE map_result
          SET status = 'failed', error = 'The generation stopped without finishing.',
              updated_at = now(), completed_at = now()
        WHERE project_id = $1 AND status = ANY($2::text[])
          AND updated_at < now() - make_interval(secs => $3)
        RETURNING id::text AS id`,
      [projectId, ACTIVE_STATUSES, staleSeconds],
    );
    return rows.map((r) => r.id);
  }

  // ── fact checks ─────────────────────────────────────────────────────

  async factChecksFor(projectId: string, claimKeys: readonly string[]): Promise<Map<string, Row>> {
    if (!claimKeys.length) return new Map();
    const rows = await this.q(
      `SELECT ${FACT_CHECK_COLUMNS} FROM map_fact_check WHERE project_id = $1 AND claim_key = ANY($2::text[])`,
      [projectId, [...claimKeys]],
    );
    return new Map(rows.map((r) => [String(r.claim_key), r]));
  }

  getFactCheck(id: string): Promise<Row | null> {
    return this.one(`SELECT ${FACT_CHECK_COLUMNS} FROM map_fact_check WHERE id = $1`, [id]);
  }

  /**
   * Moves a claim revision to processing, or leaves a running check alone. True when the
   * caller should dispatch the work: a new check, a retry after an error, a forced re-check
   * of a finished one, or a check whose worker went quiet past `staleSeconds`.
   */
  async startFactCheck(o: {
    projectId: string;
    claimKey: string;
    statement: string;
    requestedBy: string | null;
    force: boolean;
    staleSeconds: number;
  }): Promise<[Row, boolean]> {
    const row = await this.one(
      `INSERT INTO map_fact_check
              (id, project_id, claim_key, statement, status, attempt,
               requested_by, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'processing', 1, $5, now(), now(), now())
       ON CONFLICT (project_id, claim_key) DO UPDATE SET
           status = 'processing',
           attempt = map_fact_check.attempt + 1,
           statement = EXCLUDED.statement,
           verdict = NULL, justification = NULL, sources = NULL, error = NULL,
           requested_by = EXCLUDED.requested_by,
           started_at = now(), completed_at = NULL, updated_at = now()
       WHERE map_fact_check.status IN ('idle', 'error')
          OR ($6::boolean AND map_fact_check.status = 'done')
          OR (map_fact_check.status = 'processing'
              AND map_fact_check.started_at < now() - make_interval(secs => $7))
       RETURNING ${FACT_CHECK_COLUMNS}`,
      [newId(), o.projectId, o.claimKey, o.statement, o.requestedBy, o.force, o.staleSeconds],
    );
    if (row) return [row, true];
    const existing = await this.one(
      `SELECT ${FACT_CHECK_COLUMNS} FROM map_fact_check WHERE project_id = $1 AND claim_key = $2`,
      [o.projectId, o.claimKey],
    );
    if (!existing) throw new MapStoreError("fact-check row vanished after a conflicting insert");
    return [existing, false];
  }

  /** Writes a verdict only for the attempt still running. */
  async completeFactCheck(
    id: string,
    attempt: number,
    o: {
      verdict: string;
      justification: string;
      sources: unknown[];
      model: string;
      promptVersion: string;
    },
  ): Promise<boolean> {
    const rows = await this.q(
      `UPDATE map_fact_check
          SET status = 'done', verdict = $1, justification = $2, sources = $3,
              model = $4, prompt_version = $5, error = NULL,
              completed_at = now(), updated_at = now()
        WHERE id = $6 AND attempt = $7 AND status = 'processing'
        RETURNING id`,
      [
        o.verdict,
        o.justification,
        JSON.stringify(o.sources),
        o.model,
        o.promptVersion,
        id,
        attempt,
      ],
    );
    return rows.length === 1;
  }

  async failFactCheck(id: string, attempt: number, error: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE map_fact_check
          SET status = 'error', error = $1, completed_at = now(), updated_at = now()
        WHERE id = $2 AND attempt = $3 AND status = 'processing'
        RETURNING id`,
      [error.slice(0, 2000), id, attempt],
    );
    return rows.length === 1;
  }

  async cancelFactCheck(projectId: string, claimKey: string): Promise<Row | null> {
    const row = await this.one(
      `UPDATE map_fact_check
          SET status = 'idle', attempt = attempt + 1, updated_at = now()
        WHERE project_id = $1 AND claim_key = $2 AND status = 'processing'
        RETURNING ${FACT_CHECK_COLUMNS}`,
      [projectId, claimKey],
    );
    if (row) return row;
    return this.one(
      `SELECT ${FACT_CHECK_COLUMNS} FROM map_fact_check WHERE project_id = $1 AND claim_key = $2`,
      [projectId, claimKey],
    );
  }

  /** The project's name and context, which the title and fact-check prompts carry. */
  async projectContext(projectId: string): Promise<[string, string]> {
    const row = await this.one("SELECT name, context FROM project WHERE id = $1", [projectId]);
    return [String(row?.name ?? ""), String(row?.context ?? "")];
  }
}
