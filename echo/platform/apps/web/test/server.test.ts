import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityHeaders } from "../src/headers";
import { createHandler } from "../src/server";

const dist = mkdtempSync(join(tmpdir(), "echo-web-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<html>app</html>");
writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)");
writeFileSync(join(dist, "version.json"), '{"v":1}');

let upstream: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/stream") {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("event: connected\n\n"));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        path: u.pathname + u.search,
        method: req.method,
        body: req.method === "POST" ? await req.text() : null,
        cookie: req.headers.get("cookie"),
        fwd: req.headers.get("x-forwarded-host"),
      });
    },
  });
});
afterAll(() => upstream.stop());

const handler = () =>
  createHandler({
    distDir: dist,
    release: "r1",
    runtime: { env: "testing", role: "dashboard", apiBase: "/api" },
    apiOrigin: `http://127.0.0.1:${upstream.port}`,
    headers: securityHeaders({
      own: ["https://dash.example"],
      storage: ["https://storage.googleapis.com"],
    }),
  });

test("client-side routes get index.html, uncached, with the security headers", async () => {
  const res = await handler()(new Request("https://dash.example/en-US/w/123/projects"));
  expect(await res.text()).toBe("<html>app</html>");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(res.headers.get("content-security-policy")).toContain(
    "connect-src 'self' https://dash.example wss://dash.example",
  );
});

test("hashed assets are cached for a year; a missing asset is a 404, not the app", async () => {
  const ok = await handler()(new Request("https://dash.example/assets/app-abc.js"));
  expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const missing = await handler()(new Request("https://dash.example/assets/gone.js"));
  expect(missing.status).toBe(404);
});

test("path traversal cannot leave the dist directory", async () => {
  const res = await handler()(new Request("https://dash.example/../../etc/passwd"));
  expect(await res.text()).toBe("<html>app</html>");
});

test("runtime config is served uncached as a script", async () => {
  const res = await handler()(new Request("https://dash.example/runtime-config.js"));
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe(
    'window.__ECHO_RUNTIME__ = {"env":"testing","role":"dashboard","apiBase":"/api"};\n',
  );
});

test("/api is forwarded with method, query, body and cookies, on the same origin", async () => {
  const res = await handler()(
    new Request("https://dash.example/api/v2/me?x=1", {
      method: "POST",
      body: "hi",
      headers: { cookie: "dembrane.session_token=abc" },
    }),
  );
  expect(await res.json()).toEqual({
    path: "/api/v2/me?x=1",
    method: "POST",
    body: "hi",
    cookie: "dembrane.session_token=abc",
    fwd: "dash.example",
  });
});

test("event streams pass through the proxy", async () => {
  const res = await handler()(new Request("https://dash.example/api/stream"));
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toBe("event: connected\n\n");
});
