import type { Db } from "@dembrane/db";
import { directusRow } from "@dembrane/legacy-shape";
import type postgres from "postgres";

export type Row = Record<string, unknown>;
export type RunStatus = "queued" | "running" | "completed" | "failed" | "timeout";
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "timeout",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

/** One page of history reads; matches the Python service's default page. */
export const EVENT_PAGE = 500;

/**
 * project_agentic_run and its events. Rows come back the way Directus served them (every
 * column, timestamps in ISO, bigint ids as strings, and the run's o2m `events` id list),
 * because the dashboard reads them verbatim.
 */
export function runsStorage(db: Db) {
  const sql = (db as unknown as { $client: postgres.Sql }).$client;

  const eventRow = (r: Row): Row => {
    const out = directusRow(r);
    // json columns come back parsed from postgres.js; Directus cast-json did the same.
    return out;
  };

  const self = {
    sql,

    async create(v: {
      id: string;
      projectId: string;
      chatId: string | null;
      directusUserId: string;
      now: Date;
    }): Promise<Row> {
      const at = v.now.toISOString();
      await sql`
        insert into project_agentic_run
          (id, project_id, project_chat_id, directus_user_id, status, last_event_seq,
           latest_output, latest_error, latest_error_code, started_at, completed_at,
           created_at, updated_at)
        values (${v.id}, ${v.projectId}, ${v.chatId}, ${v.directusUserId}, 'queued', 0,
                null, null, null, null, null, ${at}, null)`;
      return (await self.get(v.id)) as Row;
    },

    /** The run as Directus returned it, including the `events` id list. */
    async get(id: string): Promise<Row | null> {
      if (!isUuid(id)) return null;
      const [row] = await sql`select * from project_agentic_run where id = ${id}`;
      if (!row) return null;
      const ids = await sql`
        select id from project_agentic_run_event where project_agentic_run_id = ${id} order by id`;
      return { ...directusRow(row as Row), events: ids.map((r) => String(r.id)) };
    },

    async latestForChat(chatId: string): Promise<Row | null> {
      if (!isUuid(chatId)) return null;
      const [row] = await sql`
        select id from project_agentic_run where project_chat_id = ${chatId}
        order by created_at desc nulls last limit 1`;
      return row ? self.get(String(row.id)) : null;
    },

    /**
     * The status transitions of the Python service: started_at on the first run, a cleared
     * completed_at when a turn is queued again, completed_at on a terminal status. `ifStatus`
     * makes the write conditional, so a turn that finishes after Stop never overwrites the
     * stop; the return is null when the condition did not hold.
     */
    async setStatus(
      id: string,
      status: RunStatus,
      now: Date,
      extra: {
        latestOutput?: string | null;
        latestError?: string | null;
        latestErrorCode?: string | null;
        ifStatus?: readonly RunStatus[];
      } = {},
    ): Promise<Row | null> {
      const at = now.toISOString();
      const terminal = TERMINAL_RUN_STATUSES.has(status);
      const cond = extra.ifStatus ? [...extra.ifStatus] : null;
      const rows = await sql`
        update project_agentic_run set
          status = ${status},
          started_at = case when ${status} = 'running' and started_at is null then ${at}::timestamptz else started_at end,
          completed_at = case when ${status} = 'queued' then null
                              when ${terminal} then ${at}::timestamptz
                              else completed_at end,
          latest_output = coalesce(${extra.latestOutput ?? null}, latest_output),
          latest_error = coalesce(${extra.latestError ?? null}, latest_error),
          latest_error_code = coalesce(${extra.latestErrorCode ?? null}, latest_error_code),
          updated_at = ${at}
        where id = ${id} ${cond ? sql`and status = any(${cond})` : sql``}
        returning id`;
      if (!rows.length) return null;
      return self.get(id);
    },

    /**
     * Appends an event under the next sequence number. The run row is locked for the
     * allocation, so concurrent writers (the turn, a new host message, Stop) never share
     * a seq; the Python service read max(seq)+1 unlocked and could.
     */
    async appendEvent(runId: string, eventType: string, payload: unknown, now: Date): Promise<Row> {
      return (await sql.begin(async (tx) => {
        const [run] = await tx`
          select coalesce(last_event_seq, 0) as last from project_agentic_run
          where id = ${runId} for update`;
        const [max] = await tx`
          select coalesce(max(seq), 0) as m from project_agentic_run_event
          where project_agentic_run_id = ${runId}`;
        const seq = Math.max(Number(run?.last ?? 0), Number(max?.m ?? 0)) + 1;
        const [row] = await tx`
          insert into project_agentic_run_event
            (project_agentic_run_id, seq, event_type, payload, timestamp)
          values (${runId}, ${seq}, ${eventType}, ${JSON.stringify(payload ?? null)}::json, ${now.toISOString()})
          returning *`;
        await tx`
          update project_agentic_run set last_event_seq = ${seq}, updated_at = ${now.toISOString()}
          where id = ${runId}`;
        return eventRow(row as Row);
      })) as Row;
    },

    async listEvents(runId: string, afterSeq = 0, limit = EVENT_PAGE): Promise<Row[]> {
      if (!isUuid(runId)) return [];
      const rows = await sql`
        select * from project_agentic_run_event
        where project_agentic_run_id = ${runId} and (${afterSeq} <= 0 or seq > ${afterSeq})
        order by seq limit ${limit}`;
      return rows.map((r) => eventRow(r as Row));
    },

    async latestEvent(runId: string, eventType?: string): Promise<Row | null> {
      const [row] = eventType
        ? await sql`
            select * from project_agentic_run_event
            where project_agentic_run_id = ${runId} and event_type = ${eventType}
            order by seq desc limit 1`
        : await sql`
            select * from project_agentic_run_event
            where project_agentic_run_id = ${runId} order by seq desc limit 1`;
      return row ? eventRow(row as Row) : null;
    },

    /**
     * The chat's copy of an assistant message. The id is derived from the turn and step, so
     * a step replayed after a crash rewrites the same row instead of adding a second one.
     * Directus stamped date_created on create and date_updated only on a later update.
     */
    async persistChatMessage(v: {
      id: string;
      chatId: string;
      from: "assistant" | "user";
      text: string;
      now: Date;
    }): Promise<void> {
      const at = v.now.toISOString();
      await sql`
        insert into project_chat_message (id, project_chat_id, message_from, text, date_created, date_updated)
        values (${v.id}, ${v.chatId}, ${v.from}, ${v.text}, ${at}, null)
        on conflict (id) do update set text = excluded.text, date_updated = ${at}`;
    },
    /**
     * Removes what a crashed attempt of an agent step wrote after `afterSeq`, so the step
     * can run again without doubling tool activity in the chat. Only agent-written event
     * types go; a host message or a Stop that landed meanwhile stays.
     */
    async deleteAgentEventsAfter(
      runId: string,
      afterSeq: number,
      types: readonly string[],
    ): Promise<number> {
      const rows = await sql`
        delete from project_agentic_run_event
        where project_agentic_run_id = ${runId} and seq > ${afterSeq}
          and event_type = any(${[...types]})
        returning id`;
      return rows.length;
    },
  };
  return self;
}

export type RunsStorage = ReturnType<typeof runsStorage>;
