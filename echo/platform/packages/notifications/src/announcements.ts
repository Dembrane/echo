import { NotFoundError, newId } from "@echo/core";
import { directusTime, type Signed } from "@echo/http";
import type { ActivityRow, AnnouncementStorage } from "./announcements-storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any read mark wins: unmarking leaves `read: false`, which is not read. */
export function isReadByMe(activity: readonly Pick<ActivityRow, "read">[]): boolean {
  return activity.some((a) => a.read === true);
}

/** Directus wrote a timestamp without zone as "2026-09-28T10:00:00", never with a space. */
function naive(v: string | null): string | null {
  return v ? v.replace(" ", "T") : null;
}

/**
 * Directus scoped Basic Users to unexpired announcements by permission and let admins read
 * all of them; a caller asking for expired ones gets them only if staff, as before.
 */
export async function listAnnouncements(
  store: AnnouncementStorage,
  who: Signed,
  q: { limit: number | null; offset: number; include_expired: boolean },
  now: Date,
) {
  const rows = await store.list({
    nowIso: now.toISOString(),
    live: !(q.include_expired && who.isStaff),
    limit: q.limit,
    offset: q.offset,
  });
  const ids = rows.map((r) => r.id);
  const [translations, activity] = await Promise.all([
    store.translations(ids),
    store.activity(who.directusUserId, ids),
  ]);
  return rows.map((r) => ({
    id: r.id,
    created_at: directusTime(r.created_at),
    expires_at: naive(r.expires_at),
    level: r.level,
    translations: translations
      .filter((t) => t.announcement_id === r.id)
      .map((t) => ({
        id: t.id,
        languages_code: t.languages_code,
        title: t.title,
        message: t.message,
      })),
    activity: activity.filter((a) => a.announcement_activity === r.id),
  }));
}

/** Marks one announcement read for the caller: updates their marks, or adds the first one. */
export async function markAnnouncementRead(
  store: AnnouncementStorage,
  who: Signed,
  announcementId: string,
  now: Date,
) {
  if (!UUID.test(announcementId) || !(await store.exists(announcementId)))
    throw new NotFoundError("Announcement not found");
  const mine = await store.activity(who.directusUserId, [announcementId]);
  const iso = now.toISOString();
  if (mine.length)
    await store.setRead(
      who.directusUserId,
      mine.map((a) => a.id),
      true,
      iso,
    );
  else await store.insertRead(who.directusUserId, [{ id: newId(), announcementId }], iso);
  return { status: "ok" };
}

export async function markAnnouncementUnread(
  store: AnnouncementStorage,
  who: Signed,
  announcementId: string,
  now: Date,
) {
  if (!UUID.test(announcementId)) throw new NotFoundError("Announcement not found");
  const mine = await store.activity(who.directusUserId, [announcementId]);
  await store.setRead(
    who.directusUserId,
    mine.map((a) => a.id),
    false,
    now.toISOString(),
  );
  return { status: "ok" };
}

/** Every unexpired announcement the caller has not read becomes read. */
export async function markAllAnnouncementsRead(store: AnnouncementStorage, who: Signed, now: Date) {
  const iso = now.toISOString();
  const live = await store.list({ nowIso: iso, live: true, limit: null, offset: 0 });
  const mine = await store.activity(
    who.directusUserId,
    live.map((r) => r.id),
  );
  const unread = live.filter(
    (r) => !isReadByMe(mine.filter((a) => a.announcement_activity === r.id)),
  );
  const toUpdate = mine
    .filter((a) => unread.some((r) => r.id === a.announcement_activity))
    .map((a) => a.id);
  const toCreate = unread
    .filter((r) => !mine.some((a) => a.announcement_activity === r.id))
    .map((r) => ({ id: newId(), announcementId: r.id }));
  await store.setRead(who.directusUserId, toUpdate, true, iso);
  await store.insertRead(who.directusUserId, toCreate, iso);
  return { status: "ok", updated: toUpdate.length, created: toCreate.length };
}
