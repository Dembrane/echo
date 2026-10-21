import { expect, test } from "bun:test";
import { conversationLock, enrich, overCapActive } from "../src/bff/lock";

test("a stamped conversation never locks", () => {
  expect(conversationLock({ is_over_cap: true }, "free", false).locked).toBe(false);
  expect(conversationLock({ is_over_cap: true }, "innovator", false).locked).toBe(false);
  expect(conversationLock({ is_over_cap: true }, null, false).locked).toBe(false);
});

test("the live gate never locks, recording or finished", () => {
  expect(conversationLock({ is_finished: false }, "free", true).locked).toBe(false);
  expect(conversationLock({ is_finished: true }, "free", true).locked).toBe(false);
});

test("a stamped row keeps its text and loses only the raw stamp", () => {
  const row = enrich(
    { is_over_cap: true, summary: "s", merged_transcript: "t", chunks: [{ transcript: "x" }] },
    "free",
    false,
  );
  expect(row).toEqual({
    summary: "s",
    merged_transcript: "t",
    chunks: [{ transcript: "x" }],
    locked: false,
    lock_reason: null,
  });
});

test("the lifetime hour lock is retired: no workspace is over the cap", async () => {
  const hours = (h: number) => async () => h * 3600;
  expect(await overCapActive("w", "free", hours(99))).toBe(false);
  expect(await overCapActive("w", "changemaker", hours(9))).toBe(false);
  expect(await overCapActive(null, "free", hours(9))).toBe(false);
});
