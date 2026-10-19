import { expect, test } from "bun:test";
import { finalProvidersOf } from "../src/settings";

test("the final transcript defaults to the stack's own model", () => {
  expect(finalProvidersOf({ provider: "vertex" })).toEqual(["gemini"]);
  expect(finalProvidersOf({ provider: "openai-compatible" })).toEqual(["whisper"]);
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: ["auto"] })).toEqual(["gemini"]);
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: ["whisper", "gemini"] })).toEqual([
    "whisper",
    "gemini",
  ]);
  // Off is an empty list: the live text stays the record.
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: [] })).toEqual([]);
});
