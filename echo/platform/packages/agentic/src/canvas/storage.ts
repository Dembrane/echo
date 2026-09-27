import type { Db } from "@echo/db";
import { directusRow } from "@echo/legacy-shape";
import type postgres from "postgres";

export type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string) => UUID.test(v);
const isReportId = (v: string) => /^\d{1,18}$/.test(v);

const LOOP_FIELDS = [
  "id",
  "project_id",
  "report_id",
  "name",
  "status",
  "expires_at",
  "cadence_minutes",
  "acting_directus_user_id",
  "created_from_chat_id",
  "failure_count",
  "canvas_tabs",
  "canvas_quotes_ledger",
  "canvas_concepts_ledger",
  "canvas_crux",
  "canvas_host_items",
  "canvas_story_slides",
  "canvas_host_guide",
  "canvas_board_cards",
  "created_at",
  "updated_at",
];
const CONFIG_FIELDS = [
  "id",
  "report_id",
  "brief",
  "gather_spec",
  "tabs",
  "cadence_minutes",
  "created_by",
  "created_at",
];

const rows = (list: readonly Row[]) => list.map((r) => directusRow(r));

/**
 * Canvas rows: reports of kind canvas, their config revisions, generations, the agent
 * loop that ticks them, loop runs, and the scheduled_task rows that trigger ticks.
 */
export function canvasStorage(db: Db) {
  const sql = (db as unknown as { $client: postgres.Sql }).$client;
  let ledgerColumns: Promise<boolean> | null = null;

  const self = {
    sql,

    /**
     * Whether the canvas ledger columns exist (agent_loop.canvas_* and
     * canvas_config_revision.tabs, added by directus/migrations/
     * add_smart_loop_wave28_canvas_ledgers.py). Without them every read naming those
     * fields failed in Directus and the Python service answered "no loop" and "no config";
     * the loop and config reads below do the same, and start working once the columns land.
     */
    hasLedgerColumns(): Promise<boolean> {
      ledgerColumns ??= sql`
        select count(*)::int as n from information_schema.columns
        where table_schema = current_schema()
          and ((table_name = 'agent_loop' and column_name = 'canvas_tabs')
            or (table_name = 'canvas_config_revision' and column_name = 'tabs'))`
        .then(([r]) => Number(r?.n ?? 0) === 2)
        .catch(() => {
          ledgerColumns = null;
          return false;
        });
      return ledgerColumns;
    },

    async projectFlag(projectId: string): Promise<boolean | null> {
      if (!isUuid(projectId)) return null;
      const [row] = await sql`select is_canvas_enabled from project where id = ${projectId}`;
      return row ? Boolean(row.is_canvas_enabled) : null;
    },

    async report(id: string): Promise<Row | null> {
      if (!isReportId(id)) return null;
      const [row] = await sql`select * from project_report where id = ${id}`;
      return row ? directusRow(row as Row) : null;
    },

    async canvasReports(projectId: string): Promise<Row[]> {
      return rows(
        await sql`
        select id, kind, user_instructions, date_created from project_report
        where project_id = ${projectId} and kind = 'canvas' and deleted_at is null
        order by date_created desc`,
      );
    },

    async reportInstructions(ids: readonly string[]): Promise<Row[]> {
      const valid = ids.filter(isReportId);
      if (!valid.length) return [];
      return rows(
        await sql`
        select id, user_instructions from project_report where id = any(${valid}::bigint[])`,
      );
    },

    async loopForReport(reportId: string): Promise<Row | null> {
      if (!(await self.hasLedgerColumns())) return null;
      const [row] = await sql`
        select ${sql(LOOP_FIELDS)} from agent_loop where report_id = ${reportId}
        order by created_at desc limit 1`;
      return row ? directusRow(row as Row) : null;
    },

    async latestConfig(reportId: string): Promise<Row | null> {
      if (!(await self.hasLedgerColumns())) return null;
      const [row] = await sql`
        select ${sql(CONFIG_FIELDS)} from canvas_config_revision where report_id = ${reportId}
        order by created_at desc limit 1`;
      return row ? directusRow(row as Row) : null;
    },

    async latestLoopRun(loopId: string): Promise<Row | null> {
      const [row] = await sql`
        select id, status, detail, started_at, finished_at from agent_loop_run
        where loop_id = ${loopId} order by started_at desc limit 1`;
      return row ? directusRow(row as Row) : null;
    },

    async generations(reportId: string, limit: number): Promise<Row[]> {
      return rows(
        await sql`
        select id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at
        from canvas_generation where report_id = ${reportId}
        order by created_at desc limit ${Math.max(1, Math.min(limit, 50))}`,
      );
    },

    async projectLoops(projectId: string): Promise<Row[]> {
      return rows(
        await sql`
        select id, project_id, report_id, name from agent_loop
        where project_id = ${projectId} order by id`,
      );
    },

    async recentLoopRuns(loopId: string, limit: number): Promise<Row[]> {
      return rows(
        await sql`
        select status, detail, started_at from agent_loop_run
        where loop_id = ${loopId} order by started_at desc limit ${limit}`,
      );
    },

    async chat(chatId: string): Promise<Row | null> {
      if (!isUuid(chatId)) return null;
      const [row] = await sql`
        select id, project_id, deleted_at, is_private, user_created from project_chat
        where id = ${chatId}`;
      return row ? directusRow(row as Row) : null;
    },

    // ── history reads (every column, as `fields: ["*"]` returned) ────────

    async historyLoop(reportId: string): Promise<Row | null> {
      const [row] = await sql`
        select * from agent_loop where report_id = ${reportId} order by created_at desc limit 1`;
      return row ? directusRow(row as Row) : null;
    },
    async historyGenerations(reportId: string, limit: number): Promise<Row[]> {
      return rows(
        await sql`
        select * from canvas_generation where report_id = ${reportId}
        order by created_at desc limit ${limit}`,
      );
    },
    async historyRuns(loopId: string, limit: number): Promise<Row[]> {
      return rows(
        await sql`
        select * from agent_loop_run where loop_id = ${loopId}
        order by started_at desc limit ${limit}`,
      );
    },
    async historyConfigs(reportId: string, limit: number): Promise<Row[]> {
      return rows(
        await sql`
        select * from canvas_config_revision where report_id = ${reportId}
        order by created_at desc limit ${limit}`,
      );
    },

    // ── writes ──────────────────────────────────────────────────────────

    async insertConfigRevision(v: {
      id: string;
      reportId: string;
      brief: string;
      gatherSpec: unknown;
      tabs: unknown;
      cadenceMinutes: number;
      createdBy: string;
      note: string | null;
      now: Date;
    }): Promise<Row> {
      const [row] = await sql`
        insert into canvas_config_revision
          (id, report_id, brief, gather_spec, tabs, cadence_minutes, created_by, note, created_at)
        values (${v.id}, ${v.reportId}, ${v.brief}, ${sql.json(v.gatherSpec as postgres.JSONValue)},
                ${sql.json(v.tabs as postgres.JSONValue)}, ${v.cadenceMinutes}, ${v.createdBy},
                ${v.note}, ${v.now.toISOString()})
        returning *`;
      return directusRow(row as Row);
    },

    async insertGeneration(v: {
      id: string;
      reportId: string;
      configRevisionId: string;
      contentHtml: string;
      tickKind: string;
      detail: string;
      now: Date;
    }): Promise<Row> {
      const [row] = await sql`
        insert into canvas_generation
          (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
        values (${v.id}, ${v.reportId}, ${v.configRevisionId}, ${v.contentHtml}, 'ok',
                ${v.tickKind}, ${v.detail}, ${v.now.toISOString()})
        returning *`;
      return directusRow(row as Row);
    },

    async insertLoopRun(v: {
      id: string;
      loopId: string;
      detail: string;
      generationId: string;
      at: string;
    }) {
      await sql`
        insert into agent_loop_run (id, loop_id, status, detail, generation_id, started_at, finished_at)
        values (${v.id}, ${v.loopId}, 'ok', ${v.detail}, ${v.generationId}, ${v.at}, ${v.at})`;
    },

    /** Updates a loop and returns every column, as Directus update_item did (updated_at is date-updated). */
    async updateLoop(loopId: string, patch: Row, now: Date): Promise<Row> {
      const values: Row = { ...patch, updated_at: now.toISOString() };
      for (const [k, v] of Object.entries(values))
        if (v !== null && typeof v === "object") values[k] = sql.json(v as postgres.JSONValue);
      const [row] = await sql`
        update agent_loop set ${sql(values as Record<string, postgres.ParameterOrJSON<never>>)}
        where id = ${loopId} returning *`;
      return row ? directusRow(row as Row) : {};
    },

    async scheduleTask(v: { id: string; taskType: string; payload: Row; at: string; now: string }) {
      await sql`
        insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
        values (${v.id}, ${v.taskType}, ${sql.json(v.payload as postgres.JSONValue)}, ${v.at},
                'scheduled', 0, ${v.now}, ${v.now})`;
    },

    /** Cancels still-scheduled tasks of a type whose payload holds every key/value of `match`. */
    async cancelPendingTasks(taskType: string, match: Row, now: string): Promise<number> {
      const pending = await sql`
        select id, payload from scheduled_task where task_type = ${taskType} and status = 'scheduled'`;
      let n = 0;
      for (const r of pending) {
        const payload = (r.payload ?? {}) as Row;
        if (!Object.entries(match).every(([k, v]) => payload[k] === v)) continue;
        await sql`update scheduled_task set status = 'cancelled', updated_at = ${now} where id = ${r.id}`;
        n++;
      }
      return n;
    },
  };
  return self;
}

export type CanvasStorage = ReturnType<typeof canvasStorage>;
