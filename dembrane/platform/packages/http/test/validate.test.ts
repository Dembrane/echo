import { expect, test } from "bun:test";
import { ValidationError } from "@dembrane/core";
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
    return c.json({ query: r.query, body: r.body });
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

function errors(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.details;
    throw e;
  }
  throw new Error("expected a validation error");
}

const U = (t: string) => `https://errors.pydantic.dev/2.12/v/${t}`;

test("body errors match FastAPI's list, in field order, input echoed", () => {
  const body = { tier: "x", billing_period: "weekly" };
  expect(
    errors(() =>
      v.validateRaw(
        { query: {}, body: JSON.stringify(body) },
        {
          body: {
            tier: v.literal(["innovator", "changemaker", "guardian"]),
            billing_period: v.withDefault(v.literal(["annual", "monthly"]), "annual"),
            redirect_url: v.str({ min: 1 }),
          },
        },
      ),
    ),
  ).toEqual([
    {
      type: "literal_error",
      loc: ["body", "tier"],
      msg: "Input should be 'innovator', 'changemaker' or 'guardian'",
      input: "x",
      ctx: { expected: "'innovator', 'changemaker' or 'guardian'" },
      url: U("literal_error"),
    },
    {
      type: "literal_error",
      loc: ["body", "billing_period"],
      msg: "Input should be 'annual' or 'monthly'",
      input: "weekly",
      ctx: { expected: "'annual' or 'monthly'" },
      url: U("literal_error"),
    },
    {
      type: "missing",
      loc: ["body", "redirect_url"],
      msg: "Field required",
      input: body,
      url: U("missing"),
    },
  ]);
});

test("a declared body is required even when every field is optional", () => {
  expect(
    errors(() => v.validateRaw({ query: {}, body: null }, { body: { a: v.optional(v.str()) } })),
  ).toEqual([
    { type: "missing", loc: ["body"], msg: "Field required", input: null, url: U("missing") },
  ]);
});

test("query integers parse strings and report bounds", () => {
  const spec = { query: { limit: v.withDefault(v.int({ ge: 1, le: 100 }), 20) } };
  expect(v.validateRaw({ query: {}, body: null }, spec).query.limit).toBe(20);
  expect(v.validateRaw({ query: { limit: "7" }, body: null }, spec).query.limit).toBe(7);
  expect(errors(() => v.validateRaw({ query: { limit: "0" }, body: null }, spec))).toEqual([
    {
      type: "greater_than_equal",
      loc: ["query", "limit"],
      msg: "Input should be greater than or equal to 1",
      input: "0",
      ctx: { ge: 1 },
      url: U("greater_than_equal"),
    },
  ]);
});

test("optional fields accept null, and only sent fields are reported as set", () => {
  const r = v.validateRaw(
    { query: {}, body: JSON.stringify({ a: null, b: "x" }) },
    { body: { a: v.optional(v.str()), b: v.optional(v.str()), c: v.optional(v.str()) } },
  );
  expect(r.body).toEqual({ a: null, b: "x", c: null });
  expect([...r.bodySet].sort()).toEqual(["a", "b"]);
});

test("malformed JSON and non-object bodies", () => {
  expect(
    errors(() => v.validateRaw({ query: {}, body: "nope" }, { body: { a: v.str() } })),
  ).toEqual([
    {
      type: "json_invalid",
      loc: ["body", 0],
      msg: "JSON decode error",
      input: {},
      ctx: { error: "Expecting value" },
    },
  ]);
  expect(errors(() => v.validateRaw({ query: {}, body: "[1]" }, { body: { a: v.str() } }))).toEqual(
    [
      {
        type: "model_attributes_type",
        loc: ["body"],
        msg: "Input should be a valid dictionary or object to extract fields from",
        input: [1],
        url: U("model_attributes_type"),
      },
    ],
  );
});

test("numbers, booleans and string lengths", () => {
  const spec = {
    body: { n: v.num({ gt: 0 }), b: v.bool(), s: v.str({ min: 1, max: 3 }), i: v.int() },
  };
  const e = errors(() =>
    v.validateRaw(
      { query: {}, body: JSON.stringify({ n: 0, b: "maybe", s: "long", i: 1.5 }) },
      spec,
    ),
  ) as { type: string }[];
  expect(e.map((x) => x.type)).toEqual([
    "greater_than",
    "bool_parsing",
    "string_too_long",
    "int_from_float",
  ]);
  const ok = v.validateRaw(
    { query: {}, body: JSON.stringify({ n: "2.5", b: "yes", s: "ab", i: true }) },
    spec,
  );
  expect(ok.body).toEqual({ n: 2.5, b: true, s: "ab", i: 1 });
});
