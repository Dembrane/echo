import { expect, test } from "bun:test";
import { ValidationError } from "@echo/core";
import { v, validate } from "../src";

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
      validate(
        { query: {}, body: JSON.stringify(body) },
        {
          body: {
            tier: v.literal(["innovator", "changemaker", "guardian"]),
            billing_period: v.literal(["annual", "monthly"]).default("annual"),
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
    errors(() => validate({ query: {}, body: null }, { body: { a: v.str().optional() } })),
  ).toEqual([
    { type: "missing", loc: ["body"], msg: "Field required", input: null, url: U("missing") },
  ]);
});

test("query integers parse strings and report bounds", () => {
  const spec = { query: { limit: v.int({ ge: 1, le: 100 }).default(20) } };
  expect(validate({ query: {}, body: null }, spec).query.limit).toBe(20);
  expect(validate({ query: { limit: "7" }, body: null }, spec).query.limit).toBe(7);
  expect(errors(() => validate({ query: { limit: "0" }, body: null }, spec))).toEqual([
    {
      type: "greater_than_equal",
      loc: ["query", "limit"],
      msg: "Input should be greater than or equal to 1",
      input: "0",
      ctx: { ge: 1 },
      url: U("greater_than_equal"),
    },
  ]);
  expect(errors(() => validate({ query: { limit: "ten" }, body: null }, spec))).toEqual([
    {
      type: "int_parsing",
      loc: ["query", "limit"],
      msg: "Input should be a valid integer, unable to parse string as an integer",
      input: "ten",
      url: U("int_parsing"),
    },
  ]);
});

test("optional fields accept null, and only sent fields are reported as set", () => {
  const r = validate(
    { query: {}, body: JSON.stringify({ a: null, b: "x" }) },
    { body: { a: v.str().optional(), b: v.str().optional(), c: v.str().optional() } },
  );
  expect(r.body).toEqual({ a: null, b: "x", c: null });
  expect([...r.bodySet].sort()).toEqual(["a", "b"]);
});

test("malformed JSON and non-object bodies", () => {
  expect(errors(() => validate({ query: {}, body: "nope" }, { body: { a: v.str() } }))).toEqual([
    {
      type: "json_invalid",
      loc: ["body", 0],
      msg: "JSON decode error",
      input: {},
      ctx: { error: "Expecting value" },
    },
  ]);
  expect(errors(() => validate({ query: {}, body: "[1]" }, { body: { a: v.str() } }))).toEqual([
    {
      type: "model_attributes_type",
      loc: ["body"],
      msg: "Input should be a valid dictionary or object to extract fields from",
      input: [1],
      url: U("model_attributes_type"),
    },
  ]);
});

test("numbers, booleans and string lengths", () => {
  const spec = {
    body: { n: v.num({ gt: 0 }), b: v.bool(), s: v.str({ min: 1, max: 3 }), i: v.int() },
  };
  const e = errors(() =>
    validate({ query: {}, body: JSON.stringify({ n: 0, b: "maybe", s: "long", i: 1.5 }) }, spec),
  ) as { type: string }[];
  expect(e.map((x) => x.type)).toEqual([
    "greater_than",
    "bool_parsing",
    "string_too_long",
    "int_from_float",
  ]);
  const ok = validate(
    { query: {}, body: JSON.stringify({ n: "2.5", b: "yes", s: "ab", i: "3" }) },
    spec,
  );
  expect(ok.body).toEqual({ n: 2.5, b: true, s: "ab", i: 3 });
});
