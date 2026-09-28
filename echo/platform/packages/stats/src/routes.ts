import type { Db } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import type { Limit, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { computeStats, StatsCache } from "./service";
import { statsStorage } from "./storage";

/** The website reads these from any origin. */
const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/**
 * First address in X-Forwarded-For, else the peer, as the old limiter keyed it. Trusting
 * the header is spec 7 L-20; the fix belongs with the load balancer's trusted hop.
 */
function clientIp(c: Parameters<typeof getConnInfo>[0]): string {
  const header = c.req.header("x-forwarded-for");
  if (header) return header.split(",")[0]?.trim() ?? "";
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * GET /api/stats/: public aggregate numbers, 10 requests per address per minute, cached an
 * hour. Preflights are answered by the API's CORS middleware, not here.
 */
/** Ten per minute per client address, as the old limiter allowed. */
export const STATS_LIMIT: Limit = { name: "stats", capacity: 10, windowSeconds: 60 };

export function statsRoutes(deps: { db: Db; limiter: RateLimiter }) {
  const cache = new StatsCache(() => computeStats(statsStorage(deps.db)));
  return new Hono<Env>().get("/api/stats/", async (c) => {
    await deps.limiter.check(STATS_LIMIT, clientIp(c));
    return c.json(await cache.get(), 200, PUBLIC_CORS);
  });
}
