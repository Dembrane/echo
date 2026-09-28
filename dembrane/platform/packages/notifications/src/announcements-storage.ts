import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";

const { announcement, announcement_activity, announcement_translations } = schema;

export interface AnnouncementRow {
  readonly id: string;
  readonly created_at: string | null;
  readonly expires_at: string | null;
  readonly level: string | null;
}

export interface ActivityRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly announcement_activity: string | null;
  readonly read: boolean | null;
}

export interface TranslationRow {
  readonly id: number;
  readonly announcement_id: string | null;
  readonly languages_code: string | null;
  readonly title: string | null;
  readonly message: string | null;
}

/**
 * Product announcements and each user's read marks. A read mark is an announcement_activity
 * row keyed by the Directus user id, as Directus wrote them; every query here is scoped to
 * one user's marks so an admin never touches someone else's.
 */
export function announcementStorage(db: Db) {
  return {
    /** Newest first; `live` keeps rows that have not expired (expires_at is UTC, no zone). */
    async list(opts: {
      nowIso: string;
      live: boolean;
      limit: number | null;
      offset: number;
    }): Promise<AnnouncementRow[]> {
      const q = db
        .select({
          id: announcement.id,
          created_at: announcement.created_at,
          expires_at: announcement.expires_at,
          level: announcement.level,
        })
        .from(announcement)
        .where(
          opts.live
            ? or(isNull(announcement.expires_at), gte(announcement.expires_at, opts.nowIso))
            : undefined,
        )
        .orderBy(desc(announcement.created_at), asc(announcement.id))
        .offset(opts.offset);
      return opts.limit === null ? q : q.limit(opts.limit);
    },

    async translations(ids: readonly string[]): Promise<TranslationRow[]> {
      if (!ids.length) return [];
      return db
        .select({
          id: announcement_translations.id,
          announcement_id: announcement_translations.announcement_id,
          languages_code: announcement_translations.languages_code,
          title: announcement_translations.title,
          message: announcement_translations.message,
        })
        .from(announcement_translations)
        .where(inArray(announcement_translations.announcement_id, [...ids]))
        .orderBy(asc(announcement_translations.id));
    },

    /** One user's read marks on these announcements. */
    async activity(userId: string, ids: readonly string[]): Promise<ActivityRow[]> {
      if (!ids.length) return [];
      return db
        .select({
          id: announcement_activity.id,
          user_id: announcement_activity.user_id,
          announcement_activity: announcement_activity.announcement_activity,
          read: announcement_activity.read,
        })
        .from(announcement_activity)
        .where(
          and(
            eq(announcement_activity.user_id, userId),
            inArray(announcement_activity.announcement_activity, [...ids]),
          ),
        )
        .orderBy(asc(announcement_activity.sort), asc(announcement_activity.id));
    },

    async exists(id: string): Promise<boolean> {
      const [row] = await db
        .select({ id: announcement.id })
        .from(announcement)
        .where(eq(announcement.id, id))
        .limit(1);
      return Boolean(row);
    },

    async setRead(userId: string, activityIds: readonly string[], read: boolean, nowIso: string) {
      if (!activityIds.length) return;
      await db
        .update(announcement_activity)
        .set({ read, updated_at: nowIso, user_updated: userId })
        .where(
          and(
            eq(announcement_activity.user_id, userId),
            inArray(announcement_activity.id, [...activityIds]),
          ),
        );
    },

    /** A new announcement and its translations, in one transaction. */
    async create(
      row: { id: string; level: string; expiresAt: string; userId: string; nowIso: string },
      texts: readonly { languages_code: string; title: string; message: string }[],
    ) {
      await db.transaction(async (tx) => {
        await tx.insert(announcement).values({
          id: row.id,
          level: row.level,
          expires_at: row.expiresAt,
          created_at: row.nowIso,
          updated_at: row.nowIso,
          user_created: row.userId,
        });
        await tx
          .insert(announcement_translations)
          .values(texts.map((t) => ({ announcement_id: row.id, ...t })));
      });
    },

    /** Moves the end: now to take it down, later to keep it up. False when there is no such row. */
    async setExpiry(id: string, expiresAt: string, userId: string, nowIso: string) {
      const rows = await db
        .update(announcement)
        .set({ expires_at: expiresAt, updated_at: nowIso, user_updated: userId })
        .where(eq(announcement.id, id))
        .returning({ id: announcement.id });
      return rows.length > 0;
    },

    async insertRead(
      userId: string,
      rows: readonly { id: string; announcementId: string }[],
      nowIso: string,
    ) {
      if (!rows.length) return;
      await db.insert(announcement_activity).values(
        rows.map((r) => ({
          id: r.id,
          announcement_activity: r.announcementId,
          read: true,
          user_id: userId,
          user_created: userId,
          created_at: nowIso,
        })),
      );
    },
  };
}

export type AnnouncementStorage = ReturnType<typeof announcementStorage>;
