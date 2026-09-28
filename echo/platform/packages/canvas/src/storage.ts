import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type postgres from "postgres";
import type { Json } from "./py";

/**
 * SQL over the canvas tables. Directus used to fill `uuid`, `date-created` and
 * `date-updated` fields; those are written here explicitly with the same values.
 */

export type Sql = postgres.Sql | postgres.TransactionSql;
export type Row = Record<string, unknown>;

export function client(db: Db): postgres.Sql {
  return (db as unknown as { $client: postgres.Sql }).$client;
}

/** json params go in as text: the platform's client passes strings through untouched. */
export function j(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** A report id as Directus accepted it in a path: digits only. */
export const isReportId = (v: string) => /^\d{1,18}$/.test(v);

export const TASK_CANVAS_TICK = "canvas_tick";

const CONFIG_FIELDS = `id, report_id, brief, gather_spec, tabs, cadence_minutes, created_by, created_at`;
const LOOP_FIELDS = `id, project_id, report_id, name, status, expires_at, cadence_minutes,
  acting_directus_user_id, created_from_chat_id, failure_count, canvas_tabs, canvas_quotes_ledger,
  canvas_concepts_ledger, canvas_crux, canvas_host_items, canvas_story_slides, canvas_host_guide,
  canvas_board_cards, created_at, updated_at`;
const GENERATION_FIELDS = `id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at`;

export function canvasStore(sql: Sql) {
  return {
    sql,

    async project(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from project where id = ${id}`;
      return r ?? null;
    },

    async report(id: string): Promise<Row | null> {
      if (!isReportId(id)) return null;
      const [r] = await sql`select * from project_report where id = ${id}`;
      return r ?? null;
    },

    async canvasReports(projectId: string): Promise<Row[]> {
      return sql`select id, kind, user_instructions, date_created from project_report
        where project_id = ${projectId} and kind = 'canvas' and deleted_at is null
        order by date_created desc`;
    },

    async insertReport(v: {
      projectId: string;
      name: string;
      userCreated: string;
      now: string;
    }): Promise<Row> {
      const [r] = await sql`insert into project_report
        (project_id, kind, status, user_instructions, content, user_created, date_created)
        values (${v.projectId}, 'canvas', 'published', ${v.name}, '', ${v.userCreated}, ${v.now})
        returning *`;
      return r as Row;
    },

    async renameReport(id: string, name: string, now: string): Promise<void> {
      await sql`update project_report set user_instructions = ${name}, date_updated = ${now} where id = ${id}`;
    },

    async latestConfig(reportId: string): Promise<Row | null> {
      const [r] = await sql`select ${sql.unsafe(CONFIG_FIELDS)} from canvas_config_revision
        where report_id = ${reportId} order by created_at desc limit 1`;
      return r ?? null;
    },

    async insertConfig(v: {
      reportId: string;
      brief: string;
      gatherSpec: unknown;
      tabs: unknown;
      cadence: number;
      createdBy: string;
      note: string | null;
      now: string;
    }): Promise<Row> {
      const [r] = await sql`insert into canvas_config_revision
        (id, report_id, brief, gather_spec, tabs, cadence_minutes, created_by, note, created_at)
        values (${newId()}, ${v.reportId}, ${v.brief}, ${j(v.gatherSpec)}, ${j(v.tabs)}, ${v.cadence},
          ${v.createdBy}, ${v.note}, ${v.now})
        returning *`;
      return r as Row;
    },

    async loopForReport(reportId: string): Promise<Row | null> {
      const [r] = await sql`select ${sql.unsafe(LOOP_FIELDS)} from agent_loop
        where report_id = ${reportId} order by created_at desc limit 1`;
      return r ?? null;
    },

    async loop(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from agent_loop where id = ${id}`;
      return r ?? null;
    },

    async activeLoops(nowIso: string): Promise<Row[]> {
      return sql`select id, expires_at, caps from agent_loop
        where status = 'active' and expires_at > ${nowIso}`;
    },

    async insertLoop(v: {
      projectId: string;
      reportId: string;
      name: string;
      expiresAt: string;
      cadence: number;
      actingUser: string;
      createdFromChatId: string | null;
      now: string;
    }): Promise<Row> {
      const [r] = await sql`insert into agent_loop
        (id, project_id, report_id, name, status, expires_at, cadence_minutes,
         acting_directus_user_id, created_from_chat_id, failure_count, caps, created_at)
        values (${newId()}, ${v.projectId}, ${v.reportId}, ${v.name}, 'active', ${v.expiresAt},
          ${v.cadence}, ${v.actingUser}, ${v.createdFromChatId}, 0, '{}', ${v.now})
        returning *`;
      return r as Row;
    },

    /** Patches a loop; Directus stamped updated_at on every update. */
    async updateLoop(id: string, patch: Json, now: string): Promise<Row | null> {
      const cols = Object.keys(patch);
      const values: Record<string, postgres.ParameterOrJSON<never>> = {
        ...(patch as Record<string, never>),
        updated_at: now,
      };
      for (const c of cols) if (c.startsWith("canvas_") || c === "caps") values[c] = j(patch[c]);
      const [r] = await sql`update agent_loop set ${sql(values, [...cols, "updated_at"])}
        where id = ${id} returning *`;
      return r ?? null;
    },

    async latestRun(loopId: string): Promise<Row | null> {
      const [r] = await sql`select id, status, detail, started_at, finished_at from agent_loop_run
        where loop_id = ${loopId} order by started_at desc limit 1`;
      return r ?? null;
    },

    async insertRun(v: {
      id?: string;
      loopId: string;
      status: string;
      detail: string | null;
      generationId: string | null;
      startedAt: string;
      finishedAt: string;
    }): Promise<Row> {
      const [r] = await sql`insert into agent_loop_run
        (id, loop_id, status, detail, generation_id, started_at, finished_at)
        values (${v.id ?? newId()}, ${v.loopId}, ${v.status}, ${v.detail}, ${v.generationId},
          ${v.startedAt}, ${v.finishedAt})
        on conflict (id) do nothing returning *`;
      if (r) return r;
      const [existing] = await sql`select * from agent_loop_run where id = ${v.id ?? ""}`;
      return existing as Row;
    },

    async generations(reportId: string, limit: number): Promise<Row[]> {
      return sql`select ${sql.unsafe(GENERATION_FIELDS)} from canvas_generation
        where report_id = ${reportId} order by created_at desc
        limit ${Math.max(1, Math.min(limit, 50))}`;
    },

    async latestOkGeneration(reportId: string): Promise<Row | null> {
      const [r] = await sql`select id, content_html, created_at from canvas_generation
        where report_id = ${reportId} and status = 'ok' order by created_at desc limit 1`;
      return r ?? null;
    },

    async insertGeneration(v: {
      id?: string;
      reportId: string;
      configRevisionId: string | null;
      html: string;
      status: string;
      tickKind: string;
      detail: string | null;
      now: string;
    }): Promise<Row> {
      const id = v.id ?? newId();
      const [r] = await sql`insert into canvas_generation
        (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
        values (${id}, ${v.reportId}, ${v.configRevisionId}, ${v.html}, ${v.status}, ${v.tickKind},
          ${v.detail}, ${v.now})
        on conflict (id) do nothing returning *`;
      if (r) return r;
      const [existing] = await sql`select * from canvas_generation where id = ${id}`;
      return existing as Row;
    },

    async chat(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select id, project_id, deleted_at from project_chat where id = ${id}`;
      return r ?? null;
    },

    // ── scheduled_task rows of type canvas_tick ──────────────────────

    async scheduleTick(v: {
      id?: string;
      loopId: string;
      tickKind: string;
      scheduledAt: string;
      now: string;
    }): Promise<void> {
      await sql`insert into scheduled_task
        (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
        values (${v.id ?? newId()}, ${TASK_CANVAS_TICK},
          ${j({ loop_id: v.loopId, tick_kind: v.tickKind })}, ${v.scheduledAt}, 'scheduled', 0,
          ${v.now}, ${v.now})
        on conflict (id) do nothing`;
    },

    /** Cancels still-scheduled ticks of a loop, as cancel_pending_tasks matched payloads. */
    async cancelPendingTicks(loopId: string, now: string): Promise<number> {
      const rows = await sql`update scheduled_task set status = 'cancelled', updated_at = ${now}
        where task_type = ${TASK_CANVAS_TICK} and status = 'scheduled'
          and payload->>'loop_id' = ${loopId}
        returning id`;
      return rows.length;
    },

    async pendingTicks(): Promise<Row[]> {
      return sql`select id, payload, status, claimed_at from scheduled_task
        where task_type = ${TASK_CANVAS_TICK} and status in ('scheduled', 'processing')`;
    },

    async failTask(id: string, error: string, now: string): Promise<void> {
      await sql`update scheduled_task set status = 'failed', error = ${error}, updated_at = ${now}
        where id = ${id}`;
    },

    async resetStaleClaims(now: string, staleBefore: string): Promise<number> {
      const rows = await sql`update scheduled_task
        set status = 'scheduled', claimed_at = null, updated_at = ${now}
        where status = 'processing' and claimed_at < ${staleBefore}
          and task_type = ${TASK_CANVAS_TICK}
        returning id`;
      return rows.length;
    },

    async claimDueTicks(now: string, limit: number): Promise<Row[]> {
      return sql`update scheduled_task t
        set status = 'processing', claimed_at = ${now}, attempts = coalesce(t.attempts, 0) + 1,
            updated_at = ${now}
        where t.id in (
          select id from scheduled_task
          where status = 'scheduled' and scheduled_at <= ${now} and task_type = ${TASK_CANVAS_TICK}
          order by scheduled_at limit ${limit} for update skip locked)
        returning t.*`;
    },

    async settleTask(id: string, now: string, error: string | null): Promise<void> {
      if (error === null)
        await sql`update scheduled_task set status = 'completed', error = null, updated_at = ${now}
          where id = ${id}`;
      else
        await sql`update scheduled_task set status = 'failed', error = ${error.slice(0, 5000)},
          updated_at = ${now} where id = ${id}`;
    },

    // ── gather reads ─────────────────────────────────────────────────

    async goalContent(projectId: string): Promise<string | null> {
      const [r] =
        await sql`select content from project_goal_revision where project_id = ${projectId}
        order by created_at desc limit 1`;
      const c = r?.content;
      return typeof c === "string" && c.trim() ? c.trim() : null;
    },

    async gatherConversations(
      projectId: string,
      conversationIds: string[],
      tagIds: string[],
    ): Promise<Row[]> {
      const ids = conversationIds.filter(isUuid);
      const tags = tagIds.filter(isUuid);
      if (conversationIds.length && !ids.length) return [];
      if (tagIds.length && !tags.length) return [];
      return sql`select c.id, c.participant_name, c.created_at from conversation c
        where c.project_id = ${projectId} and c.deleted_at is null
          ${ids.length ? sql`and c.id = any(${ids}::uuid[])` : sql``}
          ${
            tags.length
              ? sql`and exists (select 1 from conversation_project_tag t
                  where t.conversation_id = c.id and t.project_tag_id = any(${tags}::uuid[]))`
              : sql``
          }
        order by c.created_at desc limit 200`;
    },

    async gatherChunks(conversationId: string, since: string | null): Promise<Row[]> {
      return sql`select id, transcript, created_at, timestamp from conversation_chunk
        where conversation_id = ${conversationId} and transcript is not null
          ${since ? sql`and created_at >= ${since}` : sql``}
        order by timestamp asc, created_at asc limit 1500`;
    },

    // ── history reads ────────────────────────────────────────────────

    async historyRows(reportId: string, limit: number) {
      const [loop] = await sql`select * from agent_loop where report_id = ${reportId}
        order by created_at desc limit 1`;
      const generations = await sql`select * from canvas_generation where report_id = ${reportId}
        order by created_at desc limit ${limit}`;
      const runs = loop?.id
        ? await sql`select * from agent_loop_run where loop_id = ${loop.id}
            order by started_at desc limit ${limit}`
        : [];
      const configs = await sql`select * from canvas_config_revision where report_id = ${reportId}
        order by created_at desc limit ${Math.min(limit, 20)}`;
      return {
        loop: (loop ?? {}) as Row,
        generations: [...generations],
        runs: [...runs],
        configs: [...configs],
      };
    },
  };
}

export type CanvasStore = ReturnType<typeof canvasStore>;
