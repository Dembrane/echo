import type { Db } from "@echo/db";
import { type Env, requireUser, v } from "@echo/http";
import { Hono } from "hono";
import { listNotifications, markAllRead, markRead, unreadCount } from "./service";
import { notificationStorage } from "./storage";

/** /api/v2/me/notifications: the caller's own inbox. */
export function notificationRoutes(deps: { db: Db }) {
  const store = notificationStorage(deps.db);
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
    });
}
