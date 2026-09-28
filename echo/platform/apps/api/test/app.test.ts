import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, MemoryAccessStore, MemoryStaffAudit } from "@dembrane/access";
import type { Billing } from "@dembrane/billing";
import { loadConfig, publicValues } from "@dembrane/config";
import { ERROR_ACTIONS, ERROR_CATALOG, NotFoundError } from "@dembrane/core";
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

test("platform errors keep FastAPI's detail and add code, params and action", async () => {
  const app = buildApp(deps());
  app.get("/boom/known", () => {
    throw new NotFoundError("project.not_found", { details: { projectId: "p1" } });
  });
  app.get("/boom/unknown", () => {
    throw new Error("db password is hunter2");
  });
  lines.length = 0;
  const known = await app.request("/boom/known");
  expect(known.status).toBe(404);
  expect(await known.json()).toEqual({
    detail: { projectId: "p1" },
    code: "project.not_found",
    params: {},
    action: "none",
  });
  expect(lines.find((l) => l.message === "request refused")).toMatchObject({
    code: "project.not_found",
    status: 404,
  });
  const unknown = await app.request("/boom/unknown");
  expect(unknown.status).toBe(500);
  const body = await unknown.json();
  expect(JSON.stringify(body)).not.toContain("hunter2");
  expect(body).toEqual({
    detail: "Internal Server Error",
    code: "internal.unexpected",
    params: {},
    action: "retry",
  });
  expect(lines.find((l) => l.message === "request failed")).toMatchObject({
    code: "internal.unexpected",
    status: 500,
  });
});

test("unknown routes get the same envelope", async () => {
  const res = await buildApp(deps()).request("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    detail: "Not Found",
    code: "request.route_not_found",
    params: {},
    action: "none",
  });
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
  expect(await list.json()).toEqual({
    detail: "Invalid session",
    code: "auth.session_expired",
    params: {},
    action: "sign_in",
  });
});

/**
 * No route answers an error without a code. Every registered route is called without a
 * session and with a body that fails validation; the fake deps make most handlers throw
 * something unplanned, which must still come back as a coded 500. Any error body without
 * a catalog code fails the test, with the routes that sent it.
 */
/**
 * Routes whose error bodies a protocol fixes, so they carry no catalog code on purpose.
 * /api/mcp and its OAuth endpoints (authorize, token, register, revoke) answer RFC 6749 and
 * RFC 6750 `{ error, error_description }` bodies, which MCP clients parse.
 */
const PROTOCOL_ERROR_ROUTES = [/^\/api\/mcp(\/|$)/];

test("every route's error responses carry a catalog code and action", async () => {
  const app = buildApp(deps());
  const uncoded: string[] = [];
  const seen = new Set<string>();
  for (const r of app.routes) {
    if (r.method === "ALL" || r.path.includes("*")) continue;
    if (PROTOCOL_ERROR_ROUTES.some((re) => re.test(r.path))) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = r.path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "00000000-0000-7000-8000-000000000000");
    const init: RequestInit = { method: r.method };
    if (!["GET", "HEAD"].includes(r.method)) {
      init.body = JSON.stringify({ unexpected: true });
      init.headers = { "content-type": "application/json" };
    }
    let res: Response;
    try {
      res = await app.request(path, init);
    } catch {
      continue;
    }
    if (res.status < 400) continue;
    const type = res.headers.get("content-type") ?? "";
    const body = type.includes("json") ? ((await res.json()) as Record<string, unknown>) : null;
    const code = body?.code;
    if (
      typeof code !== "string" ||
      !(code in ERROR_CATALOG) ||
      !ERROR_ACTIONS.includes(body?.action as never)
    )
      uncoded.push(`${key} -> ${res.status} ${JSON.stringify(body)?.slice(0, 120)}`);
  }
  expect(seen.size).toBeGreaterThan(300);
  expect(uncoded).toEqual([]);
}, 60_000);

/**
 * The runtime sweep only reaches what fake deps let it; this closes the rest. Errors go
 * through `throw` so onError codes them: a handler that writes its own error response, or
 * a hono HTTPException with a text of its own, bypasses the catalog.
 */
test("no handler writes an error response by hand", async () => {
  const root = new URL("../../..", import.meta.url).pathname;
  const glob = new Bun.Glob("{apps,packages}/*/src/**/*.ts");
  const offenders: string[] = [];
  const direct = /\.json\(\s*\{\s*detail\b[^;]*?,\s*(4\d\d|5\d\d)\s*\)/s;
  for await (const file of glob.scan({ cwd: root })) {
    if (file.startsWith("apps/api/src/middleware/errors.ts")) continue;
    const text = await Bun.file(`${root}${file}`).text();
    if (direct.test(text)) offenders.push(`${file}: c.json({ detail }, status)`);
    if (/new HTTPException\(/.test(text)) offenders.push(`${file}: new HTTPException`);
  }
  expect(offenders).toEqual([]);
});
