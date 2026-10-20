import { expect, test } from "bun:test";
import { finalProvidersOf } from "../src/settings";

test("the final transcript defaults to Whisper on the compatible provider and to none on Vertex", () => {
  expect(finalProvidersOf({ provider: "vertex" })).toEqual([]);
  expect(finalProvidersOf({ provider: "openai-compatible" })).toEqual(["whisper"]);
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: ["auto"] })).toEqual([]);
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: ["gemini"] })).toEqual(["gemini"]);
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: ["whisper", "gemini"] })).toEqual([
    "whisper",
    "gemini",
  ]);
  // Off is an empty list: the live text stays the record.
  expect(finalProvidersOf({ provider: "vertex", finalTranscript: [] })).toEqual([]);
});
