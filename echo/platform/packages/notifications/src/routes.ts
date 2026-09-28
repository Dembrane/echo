import type { Db } from "@dembrane/db";
import { type Env, requireUser, v } from "@dembrane/http";
import { Hono } from "hono";
import {
  listAnnouncements,
  markAllAnnouncementsRead,
  markAnnouncementRead,
  markAnnouncementUnread,
} from "./announcements";
import { announcementStorage } from "./announcements-storage";
import { listNotifications, markAllRead, markRead, unreadCount } from "./service";
import { notificationStorage } from "./storage";

/**
 * /api/v2/me/notifications and /api/v2/me/announcements: the caller's own inbox. Both read
 * and write only rows keyed to the caller's ids from the session, so no project, workspace
 * or org access applies.
 */
export function notificationRoutes(deps: { db: Db }) {
  const store = notificationStorage(deps.db);
  const announcements = announcementStorage(deps.db);
  return new Hono<Env>()
    .get("/api/v2/me/notifications", async (c) => {
      const who = requireUser(c);
      const { query } = await v.validate(c, {
        query: {
          unread_only: v.withDefault(v.bool(), false),
          limit: v.withDefault(v.int(), 50),
        },
      });
      return c.json(await listNotifications(store, who, query, new Date()));
    })
    .get("/api/v2/me/notifications/unread-count", async (c) => {
      const who = requireUser(c);
      return c.json(await unreadCount(store, who, new Date()));
    })
    .post("/api/v2/me/notifications/read-all", async (c) => {
      const who = requireUser(c);
      return c.json(await markAllRead(store, who, new Date()));
    })
    .post("/api/v2/me/notifications/:id/read", async (c) => {
      const who = requireUser(c);
      return c.json(await markRead(store, who, c.req.param("id"), new Date()));
    })
    .get("/api/v2/me/announcements", async (c) => {
      const who = requireUser(c);
      const { query } = await v.validate(c, {
        query: {
          // Absent means every row, as Directus's limit -1 did for the unread count.
          limit: v.optional(v.int({ ge: 1, le: 200 })),
          offset: v.withDefault(v.int({ ge: 0 }), 0),
          include_expired: v.withDefault(v.bool(), false),
        },
      });
      return c.json(await listAnnouncements(announcements, who, query, new Date()));
    })
    .post("/api/v2/me/announcements/read-all", async (c) => {
      const who = requireUser(c);
      return c.json(await markAllAnnouncementsRead(announcements, who, new Date()));
    })
    .post("/api/v2/me/announcements/:id/read", async (c) => {
      const who = requireUser(c);
      return c.json(await markAnnouncementRead(announcements, who, c.req.param("id"), new Date()));
    })
    .post("/api/v2/me/announcements/:id/unread", async (c) => {
      const who = requireUser(c);
      return c.json(
        await markAnnouncementUnread(announcements, who, c.req.param("id"), new Date()),
      );
    });
}
