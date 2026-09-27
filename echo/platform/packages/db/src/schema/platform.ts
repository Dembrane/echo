import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One row per live worker process; a stale row marks a dead worker whose workflows get resumed. */
export const dbos_executor_heartbeat = pgTable("dbos_executor_heartbeat", {
  executor_id: text("executor_id").primaryKey(),
  last_seen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});
