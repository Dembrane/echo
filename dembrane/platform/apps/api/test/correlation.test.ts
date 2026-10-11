import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { correlation, createLogger, initTracing } from "@dembrane/observability";
import { Hono } from "hono";
import type { Deps, Env } from "../src/deps";
import { correlation as middleware } from "../src/middleware/correlation";

function app() {
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const deps = {
    logger: createLogger({ service: "t", release: "r", env: "test", level: "silent" }, sink),
    tracer: initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 }).tracer,
  } as unknown as Deps;
  return new Hono<Env>()
    .use("*", middleware(deps))
    .use("/api/*", async (_c, next) => next())
    .get("/api/things/:id", (c) => c.text(correlation()?.operation ?? "none"))
    .post("/api/things/:id/reply", (c) => c.text(correlation()?.operation ?? "none"));
}

test("a handler runs under its route pattern as the operation, not the path", async () => {
  const a = app();
  expect(await (await a.request("/api/things/abc-123")).text()).toBe("GET /api/things/:id");
  expect(await (await a.request("/api/things/abc-123/reply", { method: "POST" })).text()).toBe(
    "POST /api/things/:id/reply",
  );
});

test("an unmatched path keeps its own path as the operation", async () => {
  const a = app().notFound((c) => c.text(correlation()?.operation ?? "none", 404));
  expect(await (await a.request("/nowhere")).text()).toBe("GET /nowhere");
});
