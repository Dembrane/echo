import { expect, test } from "bun:test";
import { NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import {
  isReadByMe,
  listAnnouncements,
  markAllAnnouncementsRead,
  markAnnouncementRead,
  markAnnouncementUnread,
} from "../src/announcements";
import type {
  ActivityRow,
  AnnouncementRow,
  AnnouncementStorage,
} from "../src/announcements-storage";

const me = "d0000000-0000-4000-8000-000000000002";
const other = "d0000000-0000-4000-8000-000000000003";
const a1 = "a1000000-0000-4000-8000-000000000001";
const a2 = "a1000000-0000-4000-8000-000000000002";
const a3 = "a1000000-0000-4000-8000-000000000003";
const user: Signed = { appUserId: "x", directusUserId: me, isStaff: false };
const staff: Signed = { ...user, isStaff: true };
const now = new Date("2026-09-28T12:00:00Z");

/** In-memory store with the storage's contract: activity reads are scoped to one user. */
type Mark = { -readonly [K in keyof ActivityRow]: ActivityRow[K] } & { user: string };

function memory(rows: AnnouncementRow[], marks: Mark[]) {
  const liveAsked: boolean[] = [];
  let n = 0;
  const store: AnnouncementStorage = {
    async list(o) {
      liveAsked.push(o.live);
      const live = rows.filter((r) => !o.live || !r.expires_at || r.expires_at >= o.nowIso);
      return live.slice(o.offset, o.limit === null ? undefined : o.offset + o.limit);
    },
    async translations(ids) {
      return ids.map((id, i) => ({
        id: i + 1,
        announcement_id: id,
        languages_code: "en-US",
        title: `t-${id}`,
        message: "m",
      }));
    },
    async activity(userId, ids) {
      return marks
        .filter((m) => m.user === userId && ids.includes(m.announcement_activity ?? ""))
        .map(({ user: _u, ...m }) => m);
    },
    async exists(id) {
      return rows.some((r) => r.id === id);
    },
    async setRead(userId, ids, read) {
      for (const m of marks) if (m.user === userId && ids.includes(m.id)) m.read = read;
    },
    async insertRead(userId, add) {
      for (const r of add)
        marks.push({
          id: `new-${++n}`,
          user: userId,
          user_id: userId,
          announcement_activity: r.announcementId,
          read: true,
        });
    },
  } as AnnouncementStorage;
  return { store, marks, liveAsked };
}

const rows: AnnouncementRow[] = [
  { id: a1, created_at: "2026-09-27 10:00:00+00", expires_at: null, level: "urgent" },
  {
    id: a2,
    created_at: "2026-09-26 10:00:00+00",
    expires_at: "2026-10-01 00:00:00",
    level: "info",
  },
  {
    id: a3,
    created_at: "2026-09-20 10:00:00+00",
    expires_at: "2026-09-01 00:00:00",
    level: "info",
  },
];

test("any read mark wins; an unmarked row is not read", () => {
  expect(isReadByMe([])).toBe(false);
  expect(isReadByMe([{ read: false }, { read: true }])).toBe(true);
  expect(isReadByMe([{ read: false }, { read: null }])).toBe(false);
});

test("list: own marks only, translations attached, times as Directus wrote them", async () => {
  const { store } = memory(rows, [
    { id: "m1", user: me, user_id: me, announcement_activity: a1, read: true },
    { id: "m2", user: other, user_id: other, announcement_activity: a1, read: true },
  ]);
  const out = await listAnnouncements(
    store,
    user,
    { limit: null, offset: 0, include_expired: false },
    now,
  );
  expect(out.map((r) => r.id)).toEqual([a1, a2]);
  expect(out[0]?.activity).toEqual([
    { id: "m1", user_id: me, announcement_activity: a1, read: true },
  ]);
  expect(out[0]?.translations[0]?.title).toBe(`t-${a1}`);
  expect(out[0]?.created_at).toBe("2026-09-27T10:00:00.000Z");
  expect(out[1]?.expires_at).toBe("2026-10-01T00:00:00");
});

test("expired announcements only for staff who ask, as Directus's permission had it", async () => {
  const q = { limit: 50, offset: 0, include_expired: true };
  expect((await listAnnouncements(memory(rows, []).store, user, q, now)).length).toBe(2);
  expect((await listAnnouncements(memory(rows, []).store, staff, q, now)).length).toBe(3);
});

test("mark read updates existing marks instead of piling up rows; unread flips them back", async () => {
  const { store, marks } = memory(rows, [
    { id: "m1", user: me, user_id: me, announcement_activity: a2, read: false },
  ]);
  await markAnnouncementRead(store, user, a2, now);
  expect(marks).toHaveLength(1);
  expect(marks[0]?.read).toBe(true);
  await markAnnouncementRead(store, user, a1, now);
  expect(marks).toHaveLength(2);
  await markAnnouncementUnread(store, user, a2, now);
  expect(marks[0]?.read).toBe(false);
  await expect(markAnnouncementRead(store, user, "nope", now)).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

test("mark all read touches only live, unread announcements and only the caller's marks", async () => {
  const { store, marks } = memory(rows, [
    { id: "m1", user: me, user_id: me, announcement_activity: a2, read: false },
    { id: "m2", user: other, user_id: other, announcement_activity: a1, read: false },
  ]);
  const out = await markAllAnnouncementsRead(store, staff, now);
  expect(out).toEqual({ status: "ok", updated: 1, created: 1 });
  expect(marks.find((m) => m.id === "m1")?.read).toBe(true);
  expect(marks.find((m) => m.id === "m2")?.read).toBe(false);
  expect(marks.filter((m) => m.announcement_activity === a3)).toEqual([]);
});
