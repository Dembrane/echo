import { expect, test } from "bun:test";
import { jsonErrorText } from "../src/jsonerror";
import { fit } from "../src/mcp";
import { constructRedirectUri, parseUrl } from "../src/oauthurl";
import { ArgumentError, inputSchema, pyJson, validateArgs } from "../src/pyargs";

// Expected texts were produced by pydantic_core.from_json on the Python API's runtime.
test.each([
  ["", "EOF while parsing a value at line 1 column 0"],
  ["   ", "EOF while parsing a value at line 1 column 3"],
  ["garbage", "expected value at line 1 column 1"],
  ["nope", "expected ident at line 1 column 2"],
  ["{", "EOF while parsing an object at line 1 column 1"],
  ['{"a":', "EOF while parsing a value at line 1 column 5"],
  ['{"a" 1}', "expected `:` at line 1 column 6"],
  ["[1,]", "trailing comma at line 1 column 4"],
  ['{"a":1}x', "trailing characters at line 1 column 8"],
  ["tru", "EOF while parsing a value at line 1 column 3"],
  ["\n\n x", "expected value at line 3 column 2"],
  ['"abc', "EOF while parsing a string at line 1 column 4"],
  ["{a:1}", "key must be a string at line 1 column 2"],
  ["01", "invalid number at line 1 column 2"],
  ["-", "EOF while parsing a value at line 1 column 1"],
])("json error for %p", (input, expected) => {
  expect(jsonErrorText(input)).toBe(expected);
});

const PARAMS = [
  { name: "a", kind: "str" },
  { name: "b", kind: "optstr" },
  { name: "n", kind: "int", default: 5 },
  { name: "f", kind: "literal", values: ["concise", "detailed"], default: "concise" },
  { name: "z", kind: "optbool" },
] as const;

function argError(args: Record<string, unknown>): string {
  try {
    validateArgs("X", PARAMS, args);
  } catch (err) {
    if (err instanceof ArgumentError) return err.message;
    throw err;
  }
  return "";
}

// Expected texts were produced by pydantic 2.12 on the same argument model.
test("argument errors read like pydantic's", () => {
  expect(argError({ a: 1, b: 2, n: true, f: "x", z: "maybe" })).toBe(
    [
      "4 validation errors for XArguments",
      "a\n  Input should be a valid string [type=string_type, input_value=1, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.12/v/string_type",
      "b\n  Input should be a valid string [type=string_type, input_value=2, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.12/v/string_type",
      "f\n  Input should be 'concise' or 'detailed' [type=literal_error, input_value='x', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.12/v/literal_error",
      "z\n  Input should be a valid boolean, unable to interpret input [type=bool_parsing, input_value='maybe', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.12/v/bool_parsing",
    ].join("\n"),
  );
  expect(argError({ n: "y".repeat(80), x: "z".repeat(100) })).toContain(
    "input_value='yyyyyyyyyyyyyyyyyyyyyyyy...yyyyyyyyyyyyyyyyyyyyyyy', input_type=str]",
  );
  expect(argError({ n: "y".repeat(80), x: "z".repeat(100) })).toContain(
    "Field required [type=missing, input_value={'n': 'yyyyyyyyyyyyyyyyyy...zzzzzzzzzzzzzzzzzzzzzz'}, input_type=dict]",
  );
  expect(argError({ n: "é'q\"\n" })).toContain("input_value='é\\'q\"\\n', input_type=str]");
  expect(validateArgs("X", PARAMS, { a: "x", n: " 7 ", z: 1 })).toEqual({
    a: "x",
    b: null,
    n: 7,
    f: "concise",
    z: true,
  });
});

test("a JSON null sent as text replaces the value, as the SDK pre-parsed it", () => {
  expect(validateArgs("X", PARAMS, { a: "x", b: "null" }).b).toBeNull();
  expect(argError({ a: "x", n: "null" })).toContain("input_value=None, input_type=NoneType");
});

test("input schema matches the Python server's", () => {
  expect(inputSchema("dembrane_get_project", [{ name: "project_id", kind: "str" }])).toEqual({
    properties: { project_id: { title: "Project Id", type: "string" } },
    required: ["project_id"],
    type: "object",
    title: "dembrane_get_projectArguments",
  });
});

test("tool text keeps Python's float for durations", () => {
  expect(pyJson({ duration: 60, n: 3, conversations: [{ duration: 312.5 }] })).toBe(
    '{\n  "duration": 60.0,\n  "n": 3,\n  "conversations": [\n    {\n      "duration": 312.5\n    }\n  ]\n}',
  );
});

test("an answer over the cap is cut to the prefix that fits, with a note", () => {
  const chunks = Array.from({ length: 200 }, (_, i) => ({ id: i, transcript: "x".repeat(500) }));
  const out = fit({ conversation_id: "c", offset: 0, has_more: false, chunks });
  const kept = out.chunks as unknown[];
  expect(kept.length).toBeLessThan(200);
  expect(kept.length).toBeGreaterThan(50);
  expect(out.truncated).toBe(true);
  expect(out.has_more).toBe(true);
  expect(out.note).toBe(
    `Truncated: ${kept.length} of 200 chunks shown because the full answer was over the 60,000-character cap. Call again with offset=${kept.length} for the rest, or pass a smaller limit.`,
  );
  expect(fit({ a: 1 })).toEqual({ a: 1 });
});

test("redirects keep the client's own query and encode like urlencode", () => {
  expect(constructRedirectUri("http://127.0.0.1:9/cb?x=1&y=", { code: "a b", state: null })).toBe(
    "http://127.0.0.1:9/cb?x=1&code=a+b",
  );
  expect(constructRedirectUri("myapp://cb", { error: "access_denied", state: "s!" })).toBe(
    "myapp://cb?error=access_denied&state=s%21",
  );
});

test("URLs normalise like pydantic's AnyUrl", () => {
  expect(parseUrl("callback")).toEqual({
    error: "Input should be a valid URL, relative URL without a base",
  });
  expect(parseUrl("HTTP://Example.COM")).toEqual({ href: "http://example.com/" });
  expect(parseUrl("https://example.com", { preserveEmptyPath: true })).toEqual({
    href: "https://example.com",
  });
  expect(parseUrl("ftp://x", { http: true })).toEqual({
    error: "URL scheme should be 'http' or 'https'",
  });
});
