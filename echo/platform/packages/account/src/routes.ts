import type { Db } from "@echo/db";
import { type Env, requireUser } from "@echo/http";
import { Hono } from "hono";
import { getMe } from "./service";
import { accountStorage } from "./storage";

/** /api/v2/me: the signed-in user's own profile. */
export function accountRoutes(deps: { db: Db }) {
  const store = accountStorage(deps.db);
  return new Hono<Env>().get("/api/v2/me", async (c) => {
    const who = requireUser(c);
    return c.json(await getMe(store, who, new Date()));
  });
}
