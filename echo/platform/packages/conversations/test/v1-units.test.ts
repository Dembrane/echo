import { expect, test } from "bun:test";
import { computeIsOverCap, isConversationLocked, tierAllowsOverage } from "../src/tiers";
import { cleanGeneratedTitle, selectValidTagIds } from "../src/v1/llm";
import { buildTranscript, formatConversation, withStatus } from "../src/v1/reply";
import { countTokens } from "../src/v1/token-count";
import fixtures from "./v1-token-fixtures.json";

// Counted by litellm.token_counter(messages=[user text], model="vertex_ai/gemini-3.8-flash").
test.each(fixtures.map((f) => [f.text.slice(0, 30), f] as const))(
  "token count of %p matches litellm",
  (_n, f) => {
    expect(countTokens(f.text)).toBe(f.tokens);
  },
);

test("only free is hour-capped; unknown tiers never lock", () => {
  expect(tierAllowsOverage("changemaker")).toBe(true);
  expect(tierAllowsOverage("free")).toBe(false);
  expect(computeIsOverCap("free", 1.5, 0.4)).toBe(true);
  expect(computeIsOverCap("free", 1.2, 0.4)).toBe(false);
  expect(computeIsOverCap("pilot", 99, 0)).toBe(false);
  expect(computeIsOverCap("guardian", 99, 0)).toBe(false);
  expect(isConversationLocked({ is_over_cap: true }, "free")).toBe(true);
  expect(isConversationLocked({ is_over_cap: true }, "innovator")).toBe(false);
  expect(isConversationLocked({ is_over_cap: true }, null)).toBe(false);
  expect(isConversationLocked({ is_over_cap: false }, "free")).toBe(false);
});

test("a generated title keeps the first candidate as plain text", () => {
  expect(cleanGeneratedTitle("Here are some options:\n1. Late buses\n2. Charging")).toBe(
    "Late buses",
  );
  expect(cleanGeneratedTitle('"Grid delays"')).toBe("Grid delays");
  expect(cleanGeneratedTitle("**Bold title**")).toBe("Bold title");
  expect(cleanGeneratedTitle("  \n ")).toBe("");
  expect(cleanGeneratedTitle("Options:")).toBe("Options:");
});

test("draft tags come only from the vocabulary, deduplicated, at most three", () => {
  const allowed = new Set(["a", "b", "c", "d"]);
  expect(selectValidTagIds('```json\n{"tag_ids": ["a", "x", "a", "b"]}\n```', allowed)).toEqual([
    "a",
    "b",
  ]);
  expect(selectValidTagIds('[{"id": " c "}, "d", "a", "b"]', allowed)).toEqual(["c", "d", "a"]);
  expect(selectValidTagIds('{"tags": ["b"]}', allowed)).toEqual(["b"]);
  expect(selectValidTagIds("not json", allowed)).toEqual([]);
});

test("reply transcripts interleave earlier replies by time", () => {
  const t = buildTranscript(
    [
      { timestamp: "2026-09-01 09:02:00+00", transcript: "second" },
      { timestamp: "2026-09-01 09:00:00+00", transcript: "first" },
      { timestamp: "2026-09-01 09:03:00+00", transcript: null },
    ],
    [{ date_created: "2026-09-01 09:01:00+00", content_text: "echo" }],
  );
  expect(t).toBe("first\n[Assistant Reply at this point in time: echo]\nsecond\n");
  expect(formatConversation({ name: "A", tags: ["x", "y"], transcript: "hi" })).toBe(
    "<conversation>\n\t<name>A</name>\n\t<tags>x, y</tags>\n\t<transcript>hi</transcript>\n</conversation>\n",
  );
});

test("a slow first part is preceded by one high-load event", async () => {
  async function* slow() {
    await Bun.sleep(40);
    yield '0:"a"\n';
    yield '0:"b"\n';
  }
  const out: string[] = [];
  for await (const l of withStatus(slow(), 10)) out.push(l);
  expect(out).toEqual([
    '2:[{"type": "high_load", "message": "High demand. Still working on your request..."}]\n',
    '0:"a"\n',
    '0:"b"\n',
  ]);
  const fast: string[] = [];
  async function* quick() {
    yield "x";
  }
  for await (const l of withStatus(quick(), 1000)) fast.push(l);
  expect(fast).toEqual(["x"]);
});
