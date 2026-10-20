import { expect, test } from "bun:test";
import { freeLimitError, isFreeLimit } from "../src";

test("isFreeLimit recognises a free limit error, optionally by name", () => {
  expect(isFreeLimit(freeLimitError("map"))).toBe(true);
  expect(isFreeLimit(freeLimitError("map"), "map")).toBe(true);
  expect(isFreeLimit(freeLimitError("map"), "popcorn")).toBe(false);
  expect(isFreeLimit(new Error("x"))).toBe(false);
  expect(isFreeLimit(null)).toBe(false);
});
