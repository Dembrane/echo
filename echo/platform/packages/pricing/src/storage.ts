import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

const { pricing_configuration: pc, directus_users } = schema;

export type PricingRow = typeof pc.$inferSelect;
export type PricingInsert = typeof pc.$inferInsert;

export function pricingStorage(db: Db) {
  return {
    async directusEmail(directusUserId: string): Promise<string | null> {
      const [row] = await db
        .select({ email: directus_users.email })
        .from(directus_users)
        .where(eq(directus_users.id, directusUserId));
      return row?.email ?? null;
    },

    async bySession(sessionId: string): Promise<PricingRow | null> {
      const [row] = await db.select().from(pc).where(eq(pc.config_session_id, sessionId)).limit(1);
      return row ?? null;
    },

    async insert(row: PricingInsert): Promise<PricingRow> {
      const [created] = await db.insert(pc).values(row).returning();
      return created as PricingRow;
    },

    async update(id: string, patch: Partial<PricingInsert>, now: Date): Promise<PricingRow | null> {
      const [row] = await db
        .update(pc)
        .set({ ...patch, updated_at: now.toISOString() })
        .where(eq(pc.id, id))
        .returning();
      return row ?? null;
    },

    /** The booking outbox: rows with a booking the team has not heard about, oldest first. */
    async unforwardedBookings(limit: number): Promise<PricingRow[]> {
      return db
        .select()
        .from(pc)
        .where(and(isNotNull(pc.booking_uid), isNull(pc.booking_notified_at)))
        .orderBy(asc(pc.created_at), asc(pc.id))
        .limit(limit);
    },
  };
}

export type PricingStore = ReturnType<typeof pricingStorage>;
