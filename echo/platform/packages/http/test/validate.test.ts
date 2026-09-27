import { expect, test } from "bun:test";
import { ValidationError } from "@echo/core";
import { Hono } from "hono";
import * as v from "../src/validate";

const app = new Hono()
  .post("/t", async (c) => {
    const r = await v.validate(c, {
      query: { limit: v.withDefault(v.int(), 50), on: v.withDefault(v.bool(), false) },
      body: {
        email: v.email(),
        role: v.withDefault(v.literal(["admin", "member"]), "member"),
        name: v.optional(v.str({ min: 1, max: 3 })),
        tags: v.withDefault(v.list(v.dict()), []),
      },
    });
    return c.json(r);
  })
  .onError((err, c) =>
    err instanceof ValidationError ? c.json({ detail: err.details }, 422) : c.json({}, 500),
  );

const post = (qs: string, body: unknown) =>
  app.request(`/t${qs}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("valid input gets defaults and pydantic's email normalisation", async () => {
  const res = await post("?on=yes", { email: "A@Example.COM" });
  expect(await res.json()).toEqual({
    query: { limit: 50, on: true },
    body: { email: "A@example.com", role: "member", name: null, tags: [] },
  });
});

test("every problem is reported, query first, with pydantic's types and messages", async () => {
  const res = await post("?limit=x", { email: "bad", role: "owner", name: "long", tags: [1] });
  expect(res.status).toBe(422);
  const { detail } = (await res.json()) as { detail: { type: string; loc: unknown[] }[] };
  expect(detail.map((d) => [d.type, d.loc])).toEqual([
    ["int_parsing", ["query", "limit"]],
    ["value_error", ["body", "email"]],
    ["literal_error", ["body", "role"]],
    ["string_too_long", ["body", "name"]],
    ["dict_type", ["body", "tags", 0]],
  ]);
});

test("a missing field names the body it was missing from; no body at all is body missing", async () => {
  const missing = (await (await post("", {})).json()) as { detail: unknown[] };
  expect(missing.detail[0]).toMatchObject({ type: "missing", loc: ["body", "email"], input: {} });
  const none = (await (await post("", undefined)).json()) as { detail: unknown[] };
  expect(none.detail[0]).toMatchObject({ type: "missing", loc: ["body"], input: null });
});
