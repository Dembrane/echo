import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, not, or } from "drizzle-orm";
import { HANDOVER_SET_VERSION } from "./service";

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

    /**
     * The enquiry outbox: submitted rows with an email and no booking, submitted before
     * `before` and not yet forwarded, oldest first. A row without an email is an anonymous
     * website visit and is never sent.
     */
    async unforwardedEnquiries(before: Date, limit: number): Promise<PricingRow[]> {
      return db
        .select()
        .from(pc)
        .where(
          and(
            eq(pc.status, "submitted"),
            isNull(pc.booking_uid),
            isNotNull(pc.email),
            ne(pc.email, ""),
            isNotNull(pc.submitted_at),
            lte(pc.submitted_at, before.toISOString()),
            isNull(pc.enquiry_notified_at),
          ),
        )
        .orderBy(asc(pc.submitted_at), asc(pc.id))
        .limit(limit);
    },

    /**
     * External enquiries with an email that changed after `since`, oldest first: what sam's
     * daily pricing digest reads. Internal (dembrane.com) rows are left out, and so are the
     * app's handover rows: one per prompt shown, with no answers; the website row has the plan.
     */
    async recentEnquiries(since: Date): Promise<PricingRow[]> {
      return db
        .select()
        .from(pc)
        .where(
          and(
            not(pc.is_internal),
            isNotNull(pc.email),
            ne(pc.email, ""),
            gt(pc.updated_at, since.toISOString()),
            or(isNull(pc.question_set_version), ne(pc.question_set_version, HANDOVER_SET_VERSION)),
          ),
        )
        .orderBy(asc(pc.created_at), asc(pc.id));
    },
  };
}

export type PricingStore = ReturnType<typeof pricingStorage>;
