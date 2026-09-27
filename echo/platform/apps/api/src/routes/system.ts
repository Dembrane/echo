import { Hono } from "hono";
import type { Deps, Env } from "../deps";

/** Liveness at /health, readiness at /ready (not /healthz: Cloud Run's front end reserves it). Plus the public config. */
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
