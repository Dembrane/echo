import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { loadConfig, publicValues } from "@echo/config";
import { NotFoundError } from "@echo/core";
import { createLogger, initTracing } from "@echo/observability";
import { buildApp } from "../src/app";
import type { Deps } from "../src/deps";

const loaded = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: "postgres://u@h/d",
  AUTH_SECRET: "s".repeat(48),
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
    ...overrides,
  };
}

test("healthz answers with the release", async () => {
  const res = await buildApp(deps()).request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", release: "dev" });
});

test("readyz fails when the database does not answer", async () => {
  const res = await buildApp(deps({ pingDb: () => Promise.reject(new Error("down")) })).request(
    "/readyz",
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
  expect(body.auth).toEqual({ emailCodeSignIn: true });
});

test("every response carries a request id, and the access log line has it", async () => {
  lines.length = 0;
  const res = await buildApp(deps()).request("/healthz", {
    headers: { "x-request-id": "req-123" },
  });
  expect(res.headers.get("x-request-id")).toBe("req-123");
  expect(lines.at(-1)).toMatchObject({
    message: "request",
    request_id: "req-123",
    route: "/healthz",
  });
});

test("platform errors become the error envelope, unknown errors a 500 without details", async () => {
  const app = buildApp(deps());
  app.get("/boom/known", () => {
    throw new NotFoundError("project not found", { projectId: "p1" });
  });
  app.get("/boom/unknown", () => {
    throw new Error("db password is hunter2");
  });
  const known = await app.request("/boom/known");
  expect(known.status).toBe(404);
  expect(await known.json()).toEqual({
    error: { code: "not_found", message: "project not found", details: { projectId: "p1" } },
  });
  const unknown = await app.request("/boom/unknown");
  expect(unknown.status).toBe(500);
  expect(JSON.stringify(await unknown.json())).not.toContain("hunter2");
});

test("unknown routes get the same envelope", async () => {
  const res = await buildApp(deps()).request("/nope");
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
});
