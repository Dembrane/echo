import { expect, test } from "bun:test";
import { freeLimitError, isFreeLimit } from "../src";

test("isFreeLimit recognises a free limit error, optionally by name", () => {
  expect(isFreeLimit(freeLimitError("ai_budget"))).toBe(true);
  expect(isFreeLimit(freeLimitError("ai_budget"), "ai_budget")).toBe(true);
  expect(isFreeLimit(freeLimitError("ai_budget"), "chat_turns")).toBe(false);
  expect(isFreeLimit(new Error("x"))).toBe(false);
  expect(isFreeLimit(null)).toBe(false);
});
