import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, MemoryAccessStore, MemoryStaffAudit } from "@dembrane/access";
import type { Billing } from "@dembrane/billing";
import { loadConfig, publicValues } from "@dembrane/config";
import { NotFoundError } from "@dembrane/core";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger, initTracing } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
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
    workerFreshness: async () => ({ ageS: 4, jobAgeS: 30 }),
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
    staffAudit: new MemoryStaffAudit(),
    mailer: new MemoryMailer(),
    billing: { service: {}, store: {}, notifier: {}, mollie: {} } as unknown as Billing,
    siteToken: null,
    audio: {} as Deps["audio"],
    media: {} as Deps["media"],
    transcriber: {} as Deps["transcriber"],
    hub: null,
    ...overrides,
  };
}

test("health answers with the release, at /health and through the /api proxy", async () => {
  for (const path of ["/health", "/api/health"]) {
    const res = await buildApp(deps()).request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", release: "dev" });
  }
});

test("ready fails when the database does not answer", async () => {
  const res = await buildApp(deps({ pingDb: () => Promise.reject(new Error("down")) })).request(
    "/ready",
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "unavailable", failing: ["database"] });
});

test("ready/worker is fresh while a heartbeat is recent", async () => {
  const res = await buildApp(deps()).request("/ready/worker");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "fresh", ageS: 4, jobAgeS: 30 });
});

test("ready/worker is 503 once the newest heartbeat is older than the threshold", async () => {
  const res = await buildApp(
    deps({ workerFreshness: async () => ({ ageS: 91.4, jobAgeS: null }) }),
  ).request("/ready/worker");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "stale", ageS: 91, jobAgeS: null });
});

test("ready/worker is 503 when no worker ever wrote a heartbeat", async () => {
  const res = await buildApp(
    deps({ workerFreshness: async () => ({ ageS: null, jobAgeS: null }) }),
  ).request("/ready/worker");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "missing", ageS: null, jobAgeS: null });
});

test("ready/worker?release counts only that build: a fresh old release is missing", async () => {
  // The fake keeps a fresh heartbeat for the old build only, as the table would after a
  // deploy whose new worker never started.
  const beats: Record<string, number> = { old: 3 };
  const asked: (string | undefined)[] = [];
  const app = buildApp(
    deps({
      workerFreshness: async (release) => {
        asked.push(release);
        const ageS = release === undefined ? 3 : (beats[release] ?? null);
        return { ageS, jobAgeS: 10 };
      },
    }),
  );
  const res = await app.request("/ready/worker?release=new");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "missing", ageS: null, jobAgeS: 10 });
  expect((await app.request("/ready/worker?release=old")).status).toBe(200);
  expect(asked).toEqual(["new", "old"]);
});

test("ready/worker is 503 without details when the database does not answer", async () => {
  const res = await buildApp(
    deps({ workerFreshness: () => Promise.reject(new Error("password is hunter2")) }),
  ).request("/ready/worker");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "unavailable", failing: ["database"] });
});

test("ready/worker refuses a release that is not a tag", async () => {
  const res = await buildApp(deps()).request("/ready/worker?release=a'%20or%201=1");
  expect(res.status).toBe(400);
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
