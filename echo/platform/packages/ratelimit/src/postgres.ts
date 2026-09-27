import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { sql } from "drizzle-orm";
import type { RateCounter } from "./limiter";

const t = schema.platform_rate_limit;

/** One upsert per hit: resets the window when it has passed, otherwise increments. */
export class PostgresRateCounter implements RateCounter {
  constructor(private readonly db: Db) {}

  async hit(key: string, windowSeconds: number, now: Date): Promise<number> {
    const resetAt = new Date(now.getTime() + windowSeconds * 1000);
    const [row] = await this.db
      .insert(t)
      .values({ key, count: 1, resetAt })
      .onConflictDoUpdate({
        target: t.key,
        set: {
          count: sql`case when ${t.resetAt} <= ${now.toISOString()}::timestamptz then 1 else ${t.count} + 1 end`,
          resetAt: sql`case when ${t.resetAt} <= ${now.toISOString()}::timestamptz then ${resetAt.toISOString()}::timestamptz else ${t.resetAt} end`,
        },
      })
      .returning({ count: t.count });
    return row?.count ?? 1;
  }
}
