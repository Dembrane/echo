import type { Logger } from "@echo/observability";
import { Hub, publish } from "@echo/realtime";
import postgres from "postgres";
import type { Row } from "./storage";

/** The realtime channel of one run; carried inside the shared echo_live notification. */
export const runChannel = (runId: string) => `agentic:run:${runId}`;

// NOTIFY payloads cap near 8000 bytes, measured by @echo/realtime in UTF-16 units. A text
// chunk of this many units stays under the cap even when every unit is a 3-byte character.
const DRAFT_CHUNK = 2_000;
const EVENT_INLINE_LIMIT = 7_000;

/**
 * Tells streams that an event was stored. Small events travel whole, so a stream forwards
 * them without a read; large ones (tool results) travel as a nudge naming the seq, and the
 * stream reads them from the table. Either way the table is the source of truth.
 */
export async function publishEvent(
  sql: postgres.Sql | postgres.TransactionSql,
  runId: string,
  event: Row,
  logger?: Logger,
) {
  const whole = JSON.stringify(event);
  const e =
    whole.length <= EVENT_INLINE_LIMIT
      ? { kind: "event", event }
      : { kind: "nudge", seq: event.seq, event_type: event.event_type };
  await publish(sql, runChannel(runId), e, logger);
}

/**
 * The streamed snapshot of an assistant message still being written. Ephemeral: never
 * stored, forwarded only to streams open now. A long snapshot is split into ordered parts
 * sent in one transaction, which Postgres delivers together and in order.
 */
export async function publishDraft(
  sql: postgres.Sql,
  runId: string,
  messageId: string,
  text: string,
  logger?: Logger,
) {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += DRAFT_CHUNK) parts.push(text.slice(i, i + DRAFT_CHUNK));
  if (!parts.length) parts.push("");
  try {
    await sql.begin(async (tx) => {
      for (const [i, part] of parts.entries())
        await publish(
          tx,
          runChannel(runId),
          { kind: "draft", message_id: messageId, part: i, of: parts.length, text: part },
          logger,
        );
    });
  } catch (err) {
    logger?.warn({ err, runId }, "draft publish failed");
  }
}

/** Reassembles draft parts per message; yields the full snapshot once every part arrived. */
export class DraftAssembler {
  private readonly pending = new Map<string, string[]>();
  add(e: { message_id: string; part: number; of: number; text: string }): string | null {
    if (e.of <= 1) return e.text;
    const parts = e.part === 0 ? [] : (this.pending.get(e.message_id) ?? []);
    parts[e.part] = e.text;
    this.pending.set(e.message_id, parts);
    if (parts.length === e.of && parts.every((p) => p !== undefined)) {
      this.pending.delete(e.message_id);
      return parts.join("");
    }
    return null;
  }
}

let hub: { hub: Hub; ready: Promise<void> } | null = null;

/** One LISTEN connection per process, started on first use by a stream. */
export function sharedHub(sql: postgres.Sql, logger: Logger): Promise<Hub> {
  if (!hub) {
    const h = new Hub(sql, logger);
    hub = { hub: h, ready: h.start() };
    hub.ready.catch(() => {
      hub = null;
    });
  }
  const { hub: h, ready } = hub;
  return ready.then(() => h);
}

// Presence: an open stream holds a shared advisory lock keyed by its run on one dedicated
// connection per API process. The worker counts holders in pg_locks to decide whether the
// host is watching. Locks vanish with their connection, so a crashed API leaves nothing.
const PRESENCE_CLASS = 72_1427;

/** A stable non-negative 31-bit key for a run id. */
export function presenceKey(runId: string): number {
  let h = 2166136261;
  for (const ch of runId) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h & 0x7fffffff;
}

let presence: postgres.Sql | null = null;

/**
 * The connection presence locks live on: its own one-connection client with the pool's
 * settings. Not a reserved pool connection: postgres.js crashes the process when a
 * reserved connection is used after the server dropped it, while a client reconnects.
 * A reconnect drops the locks, which only makes an open stream look unwatched.
 */
function presenceClient(sql: postgres.Sql): postgres.Sql {
  if (!presence) {
    const o = sql.options as unknown as Record<string, unknown>;
    presence = postgres({
      host: o.host,
      port: o.port,
      path: o.path,
      user: o.user,
      pass: o.pass,
      database: o.database,
      ssl: o.ssl,
      max: 1,
      idle_timeout: 0,
      onnotice: () => {},
    } as postgres.Options<Record<string, postgres.PostgresType>>);
  }
  return presence;
}

/** Marks one open stream on a run; the returned function ends it. Best effort. */
export async function watchRun(
  sql: postgres.Sql,
  runId: string,
  logger?: Logger,
): Promise<() => Promise<void>> {
  try {
    const conn = presenceClient(sql);
    const key = presenceKey(runId);
    await conn`select pg_advisory_lock_shared(${PRESENCE_CLASS}, ${key})`;
    return async () => {
      await conn`select pg_advisory_unlock_shared(${PRESENCE_CLASS}, ${key})`.catch(() => {});
    };
  } catch (err) {
    logger?.warn({ err, runId }, "stream presence unavailable");
    return async () => {};
  }
}

/** How many streams are open on a run across every API process right now. */
export async function watchers(sql: postgres.Sql, runId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from pg_locks
    where locktype = 'advisory' and classid = ${PRESENCE_CLASS} and objid = ${presenceKey(runId)}
      and objsubid = 2 and granted`;
  return Number(row?.n ?? 0);
}
