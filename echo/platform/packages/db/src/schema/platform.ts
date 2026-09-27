import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Fixed-window counters for rate limits (per user or per IP). Unlogged: a crash may
// forget recent counts, which only ever loosens a limit for one window.
export const platform_rate_limit = pgTable("platform_rate_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});
