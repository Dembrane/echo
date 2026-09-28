import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import type postgres from "postgres";
import { directusTime, type Json } from "./py";

/**
 * SQL over the rows a popcorn session lives in: project_report (kind popcorn), its
 * canvas_config_revision (settings), its agent_loop (mode, expiry, extraction state), the
 * loop's agent_loop_run rows, saved runs in canvas_generation and scheduled_task rows of
 * type popcorn_tick. Directus filled `date-created`, `date-updated` and `uuid` fields; they
 * are written here explicitly with the same values.
 */

export type Sql = postgres.Sql | postgres.TransactionSql;
export type Row = Record<string, unknown>;

export function client(db: Db): postgres.Sql {
  return (db as unknown as { $client: postgres.Sql }).$client;
}

/** JSON goes in as text: the column keeps exactly what Directus's JSON.stringify wrote. */
export function j(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
/** A report id as Directus accepted it in a path: digits only. */
export const isReportId = (v: string) => /^\d{1,18}$/.test(v);

export const TASK_POPCORN_TICK = "popcorn_tick";

export function popcornStore(sql: Sql) {
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

    /** The project's live popcorn report, newest first (Directus sorted nulls first on desc). */
    async popcornReport(projectId: string): Promise<Row | null> {
      if (!isUuid(projectId)) return null;
      const [r] = await sql`select * from project_report
        where project_id = ${projectId} and kind = 'popcorn' and deleted_at is null
        order by date_created desc limit 1`;
      return r ?? null;
    },

    async reportByToken(token: string): Promise<Row | null> {
      const [r] = await sql`select * from project_report
        where public_token = ${token} and kind = 'popcorn' and deleted_at is null
        order by id limit 1`;
      return r ?? null;
    },

    async insertReport(v: {
      projectId: string;
      title: string;
      token: string;
      userCreated: string;
      now: string;
    }): Promise<Row> {
      const [r] = await sql`insert into project_report
        (project_id, kind, status, user_instructions, content, public_token, user_created, date_created)
        values (${v.projectId}, 'popcorn', 'published', ${v.title}, '', ${v.token}, ${v.userCreated},
          ${v.now})
        returning *`;
      return r as Row;
    },

    async updateReport(id: string, patch: Json, now: string): Promise<void> {
      const values: Record<string, postgres.ParameterOrJSON<never>> = {
        ...(patch as Record<string, never>),
        date_updated: now,
      };
      await sql`update project_report set ${sql(values, [...Object.keys(patch), "date_updated"])}
        where id = ${id}`;
    },

    async latestConfig(reportId: string): Promise<Row | null> {
      const [r] = await sql`select * from canvas_config_revision
        where report_id = ${reportId} order by created_at desc limit 1`;
      return r ?? null;
    },

    async config(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from canvas_config_revision where id = ${id}`;
      return r ?? null;
    },

    /** A config row with a deterministic id; a second writer's insert converges on the first. */
    async insertConfigOnce(v: {
      id: string;
      reportId: string;
      brief: string;
      settings: Json;
      cadence: number;
      createdBy: string;
      note: string;
      now: string;
    }): Promise<Row> {
      await sql`insert into canvas_config_revision
        (id, report_id, brief, gather_spec, popcorn_settings, cadence_minutes, created_by, note, created_at)
        values (${v.id}, ${v.reportId}, ${v.brief}, ${j({ full_history: true })}, ${j(v.settings)},
          ${v.cadence}, ${v.createdBy}, ${v.note}, ${v.now})
        on conflict (id) do nothing`;
      const [r] = await sql`select * from canvas_config_revision where id = ${v.id}`;
      return r as Row;
    },

    async writeSettings(configId: string, settings: Json): Promise<void> {
      await sql`update canvas_config_revision set popcorn_settings = ${j(settings)}
        where id = ${configId}`;
    },

    async loopForReport(reportId: string): Promise<Row | null> {
      const [r] = await sql`select * from agent_loop
        where report_id = ${reportId} order by created_at desc limit 1`;
      return r ?? null;
    },

    async loop(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from agent_loop where id = ${id}`;
      return r ?? null;
    },

    async insertLoopOnce(v: {
      id: string;
      projectId: string;
      reportId: string;
      name: string;
      expiresAt: string;
      cadence: number;
      actingUser: string;
      state: Json;
      now: string;
    }): Promise<Row> {
      await sql`insert into agent_loop
        (id, project_id, report_id, name, status, expires_at, cadence_minutes,
         acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
        values (${v.id}, ${v.projectId}, ${v.reportId}, ${v.name}, 'paused', ${v.expiresAt},
          ${v.cadence}, ${v.actingUser}, 0, ${j({ kind: "popcorn" })}, ${j(v.state)}, ${v.now})
        on conflict (id) do nothing`;
      const [r] = await sql`select * from agent_loop where id = ${v.id}`;
      return r as Row;
    },

    /** Patches a loop; Directus stamped updated_at on every update. */
    async updateLoop(id: string, patch: Json, now: string): Promise<Row | null> {
      const cols = Object.keys(patch);
      const values: Record<string, postgres.ParameterOrJSON<never>> = {
        ...(patch as Record<string, never>),
        updated_at: now,
      };
      for (const c of cols) if (c === "popcorn_state" || c === "caps") values[c] = j(patch[c]);
      const [r] = await sql`update agent_loop set ${sql(values, [...cols, "updated_at"])}
        where id = ${id} returning *`;
      return r ?? null;
    },

    async latestRun(loopId: string): Promise<Row | null> {
      const [r] = await sql`select * from agent_loop_run
        where loop_id = ${loopId} order by started_at desc limit 1`;
      return r ?? null;
    },

    /** When the next tick is due: every pending popcorn tick, Directus's text, earliest first. */
    async pendingTickTimes(loopId: string): Promise<string[]> {
      const rows = await sql`select payload, scheduled_at from scheduled_task
        where task_type = ${TASK_POPCORN_TICK} and status in ('scheduled', 'processing')`;
      return rows
        .filter((r) => (r.payload as Json | null)?.loop_id === loopId && r.scheduled_at)
        .map((r) => directusTime(r.scheduled_at) as string)
        .sort();
    },

    async scheduleTick(v: {
      id: string;
      payload: Json;
      scheduledAt: string;
      now: string;
    }): Promise<void> {
      await sql`insert into scheduled_task
        (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
        values (${v.id}, ${TASK_POPCORN_TICK}, ${j(v.payload)}, ${v.scheduledAt}, 'scheduled', 0,
          ${v.now}, ${v.now})`;
    },

    /** cancel_pending_tasks: still-scheduled popcorn ticks whose payload names this loop. */
    async cancelPendingTicks(loopId: string, now: string): Promise<number> {
      const rows = await sql`update scheduled_task set status = 'cancelled', updated_at = ${now}
        where task_type = ${TASK_POPCORN_TICK} and status = 'scheduled'
          and payload->>'loop_id' = ${loopId}
        returning id`;
      return rows.length;
    },

    async versions(reportId: string, limit: number): Promise<Row[]> {
      return sql`select id, created_at, detail, tick_kind from canvas_generation
        where report_id = ${reportId} and status = 'ok'
        order by created_at desc limit ${limit}`;
    },

    async version(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [r] = await sql`select * from canvas_generation where id = ${id}`;
      return r ?? null;
    },

    /** Conversations oldest first with their transcribed chunks, as gather_transcripts read them. */
    async transcripts(projectId: string): Promise<{ conversations: Row[]; chunks: Row[] }> {
      const conversations = await sql`select id, participant_name, created_at, duration
        from conversation where project_id = ${projectId} and deleted_at is null
        order by created_at`;
      if (!conversations.length) return { conversations: [], chunks: [] };
      const ids = conversations.map((c) => String(c.id));
      const chunks = await sql`select id, conversation_id, transcript, created_at, timestamp
        from conversation_chunk
        where conversation_id in ${sql(ids)} and transcript is not null
        order by timestamp, created_at`;
      return { conversations: [...conversations], chunks: [...chunks] };
    },

    /** The legal-basis cascade rows the data screen resolves through. */
    async legalCascade(project: Row): Promise<{ workspace: Row | null; owner: Row | null }> {
      let workspace: Row | null = null;
      let owner: Row | null = null;
      if (isUuid(project.workspace_id)) {
        const [w] = await sql`select legal_basis, privacy_policy_url from workspace
          where id = ${project.workspace_id} and deleted_at is null limit 1`;
        workspace = w ?? null;
      }
      if (isUuid(project.directus_user_id)) {
        const [u] = await sql`select legal_basis, privacy_policy_url from directus_users
          where id = ${project.directus_user_id} limit 1`;
        owner = u ?? null;
      }
      return { workspace, owner };
    },
  };
}

export type PopcornStore = ReturnType<typeof popcornStore>;

export { newId };
