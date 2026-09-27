import { expect, test } from "bun:test";
import { ValidationError } from "@echo/core";
import { p } from "../src";

const req = (
  body: string,
  query: Record<string, string> = {},
  path: Record<string, string> = {},
) => ({
  text: async () => body,
  query: () => query,
  param: () => path,
});

async function issues(fn: () => Promise<unknown>) {
  const err = await fn().catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).details as unknown as p.Issue[];
}

const Tag = p.model({
  project_id: p.required(p.str()),
  text: p.required(p.str()),
  sort: p.optional(p.nullable(p.int()), null),
});

// Captured from the Python API (FastAPI 0.109, pydantic 2.12).
test("missing, wrong type and unparsable integer are reported in field order", async () => {
  expect(await issues(() => p.validate(req('{"text":5,"sort":"x"}'), { body: Tag }))).toEqual([
    {
      type: "missing",
      loc: ["body", "project_id"],
      msg: "Field required",
      input: { text: 5, sort: "x" },
      url: "https://errors.pydantic.dev/2.12/v/missing",
    },
    {
      type: "string_type",
      loc: ["body", "text"],
      msg: "Input should be a valid string",
      input: 5,
      url: "https://errors.pydantic.dev/2.12/v/string_type",
    },
    {
      type: "int_parsing",
      loc: ["body", "sort"],
      msg: "Input should be a valid integer, unable to parse string as an integer",
      input: "x",
      url: "https://errors.pydantic.dev/2.12/v/int_parsing",
    },
  ]);
});

test("lax coercions: booleans and padded strings are integers, 1.5 is not", async () => {
  const ok = await p.validate(req('{"project_id":"p","text":"t","sort":" 7 "}'), { body: Tag });
  expect(ok.body.data.sort).toBe(7);
  const t = await p.validate(req('{"project_id":"p","text":"t","sort":true}'), { body: Tag });
  expect(t.body.data.sort).toBe(1);
  const bad = await issues(() =>
    p.validate(req('{"project_id":"p","text":"t","sort":1.5}'), { body: Tag }),
  );
  expect(bad[0]?.type).toBe("int_from_float");
});

test("an absent body is one missing error; a non-object body is model_attributes_type", async () => {
  expect(await issues(() => p.validate(req(""), { body: Tag }))).toEqual([
    {
      type: "missing",
      loc: ["body"],
      msg: "Field required",
      input: null,
      url: "https://errors.pydantic.dev/2.12/v/missing",
    },
  ]);
  expect((await issues(() => p.validate(req("[1]"), { body: Tag })))[0]?.type).toBe(
    "model_attributes_type",
  );
});

test("literal and length errors carry their context", async () => {
  const M = p.model({
    title: p.required(p.str({ max: 3 })),
    scope: p.optional(p.literal("user", "workspace"), "user"),
    content: p.required(p.str({ min: 1 })),
  });
  const got = await issues(() =>
    p.validate(req('{"title":"abcd","scope":"team","content":""}'), { body: M }),
  );
  expect(got.map((i) => [i.type, i.msg, i.ctx])).toEqual([
    ["string_too_long", "String should have at most 3 characters", { max_length: 3 }],
    [
      "literal_error",
      "Input should be 'user' or 'workspace'",
      { expected: "'user' or 'workspace'" },
    ],
    ["string_too_short", "String should have at least 1 character", { min_length: 1 }],
  ]);
});

test("query bounds, then body, in one error list; fields_set tracks what was sent", async () => {
  const got = await issues(() =>
    p.validate(req("{}", { limit: "0", offset: "-1" }), {
      query: {
        limit: p.optional(p.int({ ge: 1, le: 1000 }), 1000),
        offset: p.optional(p.int({ ge: 0 }), 0),
      },
      body: p.model({ n: p.required(p.int()) }),
    }),
  );
  expect(got.map((i) => i.loc)).toEqual([
    ["query", "limit"],
    ["query", "offset"],
    ["body", "n"],
  ]);
  const sent = await p.validate(req('{"a":null}'), {
    body: p.model({
      a: p.optional(p.nullable(p.str()), null),
      b: p.optional(p.nullable(p.str()), null),
    }),
  });
  expect([...sent.body.fieldsSet]).toEqual(["a"]);
});

test("booleans accept Python's words and refuse others", async () => {
  const M = p.model({ a: p.required(p.bool()), b: p.required(p.bool()) });
  const ok = await p.validate(req('{"a":"yes","b":0}'), { body: M });
  expect(ok.body.data).toEqual({ a: true, b: false });
  const bad = await issues(() => p.validate(req('{"a":"maybe","b":[1]}'), { body: M }));
  expect(bad.map((i) => i.type)).toEqual(["bool_parsing", "bool_type"]);
});
