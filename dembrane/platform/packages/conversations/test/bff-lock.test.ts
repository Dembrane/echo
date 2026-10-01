import { expect, test } from "bun:test";
import { conversationLock, enrich, overCapActive } from "../src/bff/lock";

test("a stamped conversation locks only on an hour-capped tier", () => {
  expect(conversationLock({ is_over_cap: true }, "free", false).locked).toBe(true);
  expect(conversationLock({ is_over_cap: true }, "innovator", false).locked).toBe(false);
  expect(conversationLock({ is_over_cap: true }, null, false).locked).toBe(false);
});

test("the live gate locks conversations still recording, not finished ones", () => {
  expect(conversationLock({ is_finished: false }, "free", true).locked).toBe(true);
  expect(conversationLock({ is_finished: true }, "free", true).locked).toBe(false);
});

test("a locked row loses its gated text and the raw stamp", () => {
  const row = enrich(
    { is_over_cap: true, summary: "s", merged_transcript: "t", chunks: [{ transcript: "x" }] },
    "free",
    false,
  );
  expect(row).toEqual({
    summary: null,
    summary_locked: true,
    merged_transcript: null,
    chunks: [{ transcript: null, transcript_locked: true }],
    locked: true,
    lock_reason: "hours_cap",
  });
});

test("only free workspaces past one hour are over the cap", async () => {
  const hours = (h: number) => async () => h * 3600;
  expect(await overCapActive("w", "free", hours(1))).toBe(true);
  expect(await overCapActive("w", "free", hours(0.5))).toBe(false);
  expect(await overCapActive("w", "changemaker", hours(9))).toBe(false);
  expect(await overCapActive(null, "free", hours(9))).toBe(false);
});
