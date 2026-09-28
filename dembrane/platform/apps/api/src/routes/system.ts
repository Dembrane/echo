import { Hono } from "hono";
import type { Deps, Env } from "../deps";

/** A worker heartbeats every 10 seconds; one silent this long is not running jobs. */
export const WORKER_STALE_AFTER_S = 90;

/**
 * Liveness at /health, readiness at /ready (not /healthz: Cloud Run's front end reserves it),
 * the worker's at /ready/worker. Plus the public config.
 *
 * /ready/worker is 503 unless a worker heartbeat is newer than WORKER_STALE_AFTER_S. With
 * ?release=<tag> only a worker running that build counts: the deploy waits on it. It is
 * public, so it says a status and ages only, never which executors exist.
 */
export function systemRoutes(deps: Deps) {
  return new Hono<Env>()
    .get("/health", (c) => c.json({ status: "ok", release: deps.config.app.release }))
    .get("/ready", async (c) => {
      try {
        await withTimeout(deps.pingDb(), 2000);
        return c.json({ status: "ready" });
      } catch (err) {
        c.get("logger").warn({ err }, "not ready: database");
        return c.json({ status: "unavailable", failing: ["database"] }, 503);
      }
    })
    .get("/ready/worker", async (c) => {
      const release = c.req.query("release") || undefined;
      if (release && !/^[\w.-]{1,128}$/.test(release))
        return c.json({ status: "invalid", failing: ["release"] }, 400);
      try {
        const f = await withTimeout(deps.workerFreshness(release), 2000);
        const jobAgeS = f.jobAgeS === null ? null : Math.round(f.jobAgeS);
        if (f.ageS === null) return c.json({ status: "missing", ageS: null, jobAgeS }, 503);
        const ageS = Math.round(f.ageS);
        if (f.ageS > WORKER_STALE_AFTER_S) return c.json({ status: "stale", ageS, jobAgeS }, 503);
        return c.json({ status: "fresh", ageS, jobAgeS });
      } catch (err) {
        c.get("logger").warn({ err }, "worker freshness unavailable");
        return c.json({ status: "unavailable", failing: ["database"] }, 503);
      }
    })
    .get("/config.json", (c) => {
      c.header("cache-control", "public, max-age=60");
      return c.json(deps.publicConfig);
    });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}
