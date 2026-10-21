import type { Db } from "@dembrane/db";
import { type ScheduledTask, scheduledTasks } from "@dembrane/queue";
import type postgres from "postgres";

export type Row = Record<string, unknown>;
type Sql = postgres.Sql | postgres.TransactionSql;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);
/** Report ids are bigserial; anything else names no row, like a missing one. */
export const isReportId = (v: string) => /^\d{1,18}$/.test(v);

const quote = (c: string) => `"${c.replaceAll('"', '""')}"`;

export function reportsStorage(db: Db) {
  const client = (db as unknown as { $client: postgres.Sql }).$client;
  return {
    ...queries(client),
    /** One transaction; `sql` of the scope lets a job be enqueued in the same commit. */
    async transaction<T>(fn: (s: Queries) => Promise<T>): Promise<T> {
      return (await client.begin((tx) => fn(queries(tx)))) as T;
    },
  };
}

export type ReportsStorage = ReturnType<typeof reportsStorage>;
export type Queries = ReturnType<typeof queries>;

/** The task type of a report booked for a time. */
export const TASK_GENERATE_REPORT = "generate_report";

function queries(sql: Sql) {
  const tasks = scheduledTasks(sql);
  const self = {
    sql,

    // ── reports ───────────────────────────────────────────────────────

    async report(id: string): Promise<Row | null> {
      if (!isReportId(id)) return null;
      const [row] = await sql`select * from project_report where id = ${id}`;
      return row ?? null;
    },

    async projectReports(projectId: string, columns: readonly string[], limit: number) {
      return sql.unsafe(
        `select ${columns.map(quote).join(", ")} from project_report
          where project_id = $1 and kind = 'report' and deleted_at is null
          order by date_created nulls last, id limit $2`,
        [projectId, limit],
      ) as Promise<Row[]>;
    },

    /** Free (stamped) drafts untouched since `before` move to error; returns their ids. */
    async failStuckDrafts(before: string, now: string, code: string, message: string) {
      const rows = await sql`update project_report r
        set status = 'error', error_code = ${code}, error_message = ${message}, date_updated = ${now}
        from project p
        where p.id = r.project_id and p.is_sample is not true
          and r.kind = 'report' and r.status = 'draft' and r.deleted_at is null
          and r.free_period_start is not null
          and coalesce(r.date_updated, r.date_created) < ${before}
        returning r.id::int`;
      return rows.map((r) => r.id as number).sort((a, b) => a - b);
    },

    /**
     * Starts a run: a scheduled report becomes a draft; a free draft is timed from now.
     * False when the report moved on since it was read.
     */
    async startRun(id: number, now: string, free: boolean) {
      const rows = await sql`update project_report set status = 'draft', date_updated = ${now}
        where id = ${id} and (status = 'scheduled' or (status = 'draft' and ${free}))
        returning id`;
      if (rows.length) return true;
      const [row] = await sql`select status from project_report where id = ${id}`;
      return !free && row?.status === "draft";
    },

    /** The scheduler's flip to draft; false when the report is no longer scheduled. */
    async flipScheduled(id: number, now: string) {
      const rows = await sql`update project_report set status = 'draft', date_updated = ${now}
        where id = ${id} and status = 'scheduled' and deleted_at is null returning id`;
      return rows.length > 0;
    },

    /** Ends a run in error; false when the report is no longer draft or scheduled. */
    async failRun(id: number, code: string, message: string, now: string) {
      const rows = await sql`update project_report
        set status = 'error', error_code = ${code}, error_message = ${message}, date_updated = ${now}
        where id = ${id} and status in ('draft', 'scheduled') returning id`;
      return rows.length > 0;
    },

    /** Saves a draft's content; false when it is no longer a draft (cancelled, deleted, swept). */
    async archiveDraft(id: number, content: string, now: string) {
      const rows = await sql`update project_report
        set content = ${content}, status = 'archived', date_created = ${now}, date_updated = ${now}
        where id = ${id} and status = 'draft' returning id`;
      return rows.length > 0;
    },

    async updateReport(id: number, fields: Row) {
      const keys = Object.keys(fields);
      await sql.unsafe(
        `update project_report set ${keys.map((k, i) => `${quote(k)} = $${i + 2}`).join(", ")} where id = $1`,
        [id, ...keys.map((k) => fields[k] as never)],
      );
    },

    async project(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [row] = await sql`select * from project where id = ${id}`;
      return row ?? null;
    },

    async liveConversations(projectId: string) {
      return sql`select id, created_at from conversation
        where project_id = ${projectId} and deleted_at is null order by id limit 1000` as Promise<
        Row[]
      >;
    },

    async chunkCounts(conversationIds: string[]) {
      if (!conversationIds.length) return [] as Row[];
      return sql`select conversation_id, count(id)::int as n from conversation_chunk
        where conversation_id = any(${conversationIds}::uuid[]) group by conversation_id` as Promise<
        Row[]
      >;
    },

    /** Metrics of every report of the project (deleted and canvas reports included, as before). */
    async projectMetrics(projectId: string) {
      return sql`select m.id, m.date_created, m.project_report_id from project_report_metric m
        join project_report r on r.id = m.project_report_id
        where r.project_id = ${projectId} order by m.date_created nulls last, m.id limit 1000` as Promise<
        Row[]
      >;
    },

    // ── generation reads ──────────────────────────────────────────────

    /** Live conversations, newest update first, with their chunk counts (Directus count(chunks)). */
    async conversationsForReport(projectId: string) {
      return sql`select c.id, c.participant_name, c.summary, c.created_at, c.updated_at,
          c.is_finished, c.is_over_cap, c.is_all_chunks_transcribed,
          (select count(*)::int from conversation_chunk k where k.conversation_id = c.id) as chunks_count,
          coalesce((select array_agg(t.text order by ct.id) from conversation_project_tag ct
             join project_tag t on t.id = ct.project_tag_id
             where ct.conversation_id = c.id), '{}') as tag_texts
        from conversation c
        where c.project_id = ${projectId} and c.deleted_at is null
        order by c.updated_at desc nulls first, c.id` as Promise<Row[]>;
    },

    /** Directus get_items(conversation_chunk) with limit 1500 and sort timestamp, joined by newlines. */
    async transcript(conversationId: string): Promise<string> {
      const [record] = await sql`
        select text from conversation_record_transcript where conversation_id = ${conversationId}`;
      if (record) return String(record.text);
      const rows = await sql`select transcript from conversation_chunk
        where conversation_id = ${conversationId} order by timestamp nulls last, id limit 1500`;
      return rows
        .map((r) => r.transcript as string | null)
        .filter((t): t is string => Boolean(t))
        .join("\n");
    },

    // ── report subscribers ────────────────────────────────────────────

    /** Gives every opted-in subscriber of a project without an unsubscribe token one. */
    async fillUnsubscribeTokens(projectId: string) {
      await sql`update project_report_notification_participants set email_opt_out_token = gen_random_uuid()
        where project_id = ${projectId} and email_opt_in and email_opt_out_token is null`;
    },

    /**
     * Subscribers of a project, one per address, whose latest choice across that address's
     * rows is opted in: unsubscribing through one row of a duplicate counts for all.
     */
    async reportSubscribers(projectId: string) {
      return sql`select id, email, token, conversation_name from (
          select distinct on (lower(s.email)) s.id, s.email, s.email_opt_in,
            s.email_opt_out_token::text as token, coalesce(c.participant_name, '') as conversation_name
          from project_report_notification_participants s
          left join conversation c on c.id = s.conversation_id and c.deleted_at is null
          where s.project_id = ${projectId} and s.email is not null
          order by lower(s.email), coalesce(s.date_updated, s.date_submitted) desc nulls last, s.id
        ) latest
        where email_opt_in
        order by lower(email)` as Promise<
        { id: string; email: string; token: string; conversation_name: string }[]
      >;
    },

    async appUserByDirectusId(directusUserId: string) {
      const [row] = await sql`select id, email from app_user
        where directus_user_id = ${directusUserId} limit 1`;
      return (row as { id: string; email: string | null } | undefined) ?? null;
    },

    async processingStatus(row: {
      project_id: string | null;
      conversation_id?: string | null;
      event: string;
      message: string;
      duration_ms: number;
      now: string;
    }) {
      await sql`insert into processing_status
          (project_id, conversation_id, event, message, duration_ms, timestamp)
        values (${row.project_id}, ${row.conversation_id ?? null}, ${row.event}, ${row.message},
                ${row.duration_ms}, ${row.now})`;
    },

    // ── scheduled_task rows of type generate_report ───────────────────

    async resetStaleClaims(nowIso: string, staleBefore: string) {
      await tasks.resetStaleClaims([TASK_GENERATE_REPORT], nowIso, staleBefore);
    },

    async claimDueTasks(nowIso: string, limit: number) {
      return tasks.claimDue([TASK_GENERATE_REPORT], nowIso, limit);
    },

    async settleTask(id: string, nowIso: string, error: string | null) {
      await tasks.settle(id, nowIso, error);
    },

    async pendingTasks(): Promise<ScheduledTask[]> {
      return tasks.pending(TASK_GENERATE_REPORT);
    },

    async bookTask(payload: Record<string, unknown>, at: string, nowIso: string) {
      await tasks.book({ taskType: TASK_GENERATE_REPORT, payload, at, now: nowIso });
    },
  };
  return self;
}
