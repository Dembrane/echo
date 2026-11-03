import { beforeEach, expect, test } from "bun:test";
import { fakeModels, lastPayer, takeUnscopedFakeCalls } from "@dembrane/llm";
import { payer } from "@dembrane/observability";
import { Hono } from "hono";
import { payerMiddleware } from "../src/middleware/payer";

const seen = (c: { json: (v: unknown) => Response }) => c.json({ payer: payer() ?? null });

function app() {
  const models = fakeModels({ text: "ok" });
  // Package routes are mounted as sub-apps, behind path middleware, as in app.ts.
  const sub = new Hono()
    .get("/api/chats/:chat_id", seen)
    .get("/api/participant/projects/:project_id/conversations/:conversation_id", seen)
    .post("/api/agentic/runs/:run_id/messages", async (c) => {
      await models.model("multi_modal_fast").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      return c.json({});
    });
  return new Hono()
    .use(payerMiddleware())
    .use("/api/*", async (_c, next) => next())
    .get("/api/x/projects/:project_id/y", seen)
    .get("/api/none", seen)
    .route("/", sub);
}

const read = async (path: string) =>
  ((await (await app().request(path)).json()) as { payer: unknown }).payer;

beforeEach(() => {
  takeUnscopedFakeCalls();
});

test("a route param names the payer", async () => {
  expect(await read("/api/chats/c-1")).toEqual({ ref: "chat", id: "c-1" });
  expect(await read("/api/x/projects/p-1/y")).toEqual({ ref: "project", id: "p-1" });
});

test("a request without a payer param runs without a scope", async () => {
  expect(await read("/api/none")).toBeNull();
});

test("the project wins over a conversation in the same path", async () => {
  expect(await read("/api/participant/projects/p-2/conversations/c-2")).toEqual({
    ref: "project",
    id: "p-2",
  });
});

test("a model call in the handler runs under the route's payer", async () => {
  const res = await app().request("/api/agentic/runs/r-1/messages", { method: "POST" });
  expect(res.status).toBe(200);
  expect(lastPayer()).toEqual({ ref: "agent_run", id: "r-1" });
});
