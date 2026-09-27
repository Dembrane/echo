import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, MemoryAccessStore } from "@echo/access";
import { loadConfig, publicValues } from "@echo/config";
import { NotFoundError } from "@echo/core";
import { createLogger, initTracing } from "@echo/observability";
import { MemoryRateCounter, RateLimiter } from "@echo/ratelimit";
import { buildApp } from "../src/app";
import type { Deps } from "../src/deps";

const loaded = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: "postgres://u@h/d",
  AUTH_SECRET: "s".repeat(48),
  INVITE_HASH_SECRET: "i".repeat(32),
});
const lines: Record<string, unknown>[] = [];
const sink = new Writable({
  write(chunk, _e, cb) {
    lines.push(JSON.parse(chunk.toString()));
    cb();
  },
});

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    config: loaded.values,
    publicConfig: publicValues(loaded),
    logger: createLogger({ service: "t", release: "r", env: "test", level: "info" }, sink),
    tracer: initTracing({ service: "t", release: "r", env: "test", sampleRatio: 1 }).tracer,
    pingDb: async () => 1,
    auth: {
      handler: async () => new Response("auth"),
      api: { getSession: async () => null },
    } as unknown as Deps["auth"],
    principalFor: async () => null,
    access: new Access(new MemoryAccessStore()),
    db: {} as Deps["db"],
    models: {} as Deps["models"],
    queue: { enqueue: async () => null },
    deliverWebhook: async () => ({ status: 200, text: "" }),
    identity: {} as Deps["identity"],
    notifier: {} as Deps["notifier"],
    limiter: new RateLimiter(new MemoryRateCounter()),
    jobs: { enqueue: async () => null },
    files: {} as Deps["files"],
    audio: {} as Deps["audio"],
    media: {} as Deps["media"],
    transcriber: {} as Deps["transcriber"],
    hub: null,
    ...overrides,
  };
}

test("health answers with the release", async () => {
  const res = await buildApp(deps()).request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", release: "dev" });
});

test("ready fails when the database does not answer", async () => {
  const res = await buildApp(deps({ pingDb: () => Promise.reject(new Error("down")) })).request(
    "/ready",
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "unavailable", failing: ["database"] });
});

test("config.json serves only public keys", async () => {
  const body = (await (await buildApp(deps()).request("/config.json")).json()) as Record<
    string,
    Record<string, unknown>
  >;
  expect(body.http?.publicUrl).toBe("http://api.test");
  expect(body.database).toBeUndefined();
  expect(Object.keys(body).sort()).toEqual(["app", "http", "web"]);
});

test("every response carries a request id, and the access log line has it", async () => {
  lines.length = 0;
  const res = await buildApp(deps()).request("/health", {
    headers: { "x-request-id": "req-123" },
  });
  expect(res.headers.get("x-request-id")).toBe("req-123");
  expect(lines.at(-1)).toMatchObject({
    message: "request",
    request_id: "req-123",
    route: "/health",
  });
});

test("platform errors keep FastAPI's detail shape, unknown errors a 500 without details", async () => {
  const app = buildApp(deps());
  app.get("/boom/known", () => {
    throw new NotFoundError("project not found", { projectId: "p1" });
  });
  app.get("/boom/unknown", () => {
    throw new Error("db password is hunter2");
  });
  const known = await app.request("/boom/known");
  expect(known.status).toBe(404);
  expect(await known.json()).toEqual({ detail: { projectId: "p1" } });
  const unknown = await app.request("/boom/unknown");
  expect(unknown.status).toBe(500);
  expect(JSON.stringify(await unknown.json())).not.toContain("hunter2");
});

test("unknown routes get the same envelope", async () => {
  const res = await buildApp(deps()).request("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ detail: "Not Found" });
});

test("tenancy routes are registered: tier capacities are public, workspaces need a session", async () => {
  const app = buildApp(deps());
  const caps = await app.request("/api/v2/workspaces/tier-capacities");
  expect(caps.status).toBe(200);
  expect(((await caps.json()) as { tier: string }[]).map((c) => c.tier)).toEqual([
    "free",
    "innovator",
    "changemaker",
    "guardian",
  ]);
  const list = await app.request("/api/v2/workspaces");
  expect(list.status).toBe(401);
  expect(await list.json()).toEqual({ detail: "Invalid session" });
});
