import { expect, test } from "bun:test";
import { parseSilences, planPieces } from "../src";

test("a recording that fits is one piece", () => {
  expect(planPieces(300, [{ start: 100, end: 101 }], 600)).toEqual([
    { start: 0, duration: 300, hardCut: false },
  ]);
});

test("pieces end in the middle of the longest pause in the later half of the window", () => {
  const pieces = planPieces(
    1500,
    [
      { start: 100, end: 100.4 }, // earlier half: ignored
      { start: 400, end: 400.5 },
      { start: 520, end: 522 }, // longest in reach
      { start: 700, end: 703 }, // beyond the limit
      { start: 1000, end: 1001 },
    ],
    600,
  );
  expect(pieces[0]).toEqual({ start: 0, duration: 521, hardCut: false });
  expect(pieces[1]?.start).toBe(521);
  // The pieces are contiguous and cover the whole recording.
  const end = pieces.reduce((t, p) => (p.start === t ? p.start + p.duration : Number.NaN), 0);
  expect(end).toBe(1500);
  expect(pieces.every((p) => p.duration <= 600)).toBe(true);
});

test("without a pause in reach the piece ends at the limit and says so", () => {
  const pieces = planPieces(1000, [], 400);
  expect(pieces.map((p) => p.hardCut)).toEqual([true, true, false]);
  expect(pieces.map((p) => p.duration)).toEqual([400, 400, 200]);
});

test("silencedetect lines pair into pauses, and an open pause runs to the end", () => {
  const log = [
    "[silencedetect @ 0x1] silence_start: 1.5",
    "[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75",
    "[silencedetect @ 0x1] silence_start: -0.02",
    "[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.52",
    "[silencedetect @ 0x1] silence_start: 9.1",
  ].join("\n");
  expect(parseSilences(log)).toEqual([
    { start: 1.5, end: 2.25 },
    { start: 0, end: 0.5 },
    { start: 9.1, end: Number.POSITIVE_INFINITY },
  ]);
});
