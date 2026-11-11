import { expect, test } from "bun:test";
import { assembleFirstPass, type FinalSettings, finalTreatment } from "../src/pipeline/final";

const piece = (key: string, seconds: number, sentences: [number, number, string][]) => ({
  key,
  model: "whisper-large-v3",
  timed: { seconds, sentences: sentences.map(([start, end, text]) => ({ start, end, text })) },
});

test("each piece's sentences move to where the piece sits in the merged file", () => {
  const out = assembleFirstPass(
    [
      piece("a", 58.4, [
        [0.5, 4, "Welkom allemaal."],
        [4.2, 57.9, "We beginnen met de begroting."],
      ]),
      piece("b", 41.1, [[1, 6, "Dan de planning."]]),
      // A second upload in the same conversation: it starts where the first one ended.
      piece("c", 30, [[0, 2.5, "Tweede bestand."]]),
    ],
    129.5,
  );
  expect(out?.plan.firstPass).toBe(true);
  expect(out?.plan.pieces.map((p) => [p.key, p.start, p.duration])).toEqual([
    ["a", 0, 58.4],
    ["b", 58.4, 41.1],
    ["c", 99.5, 30],
  ]);
  const all = out?.parts.flatMap((p) => p.sentences) ?? [];
  expect(all[0]).toEqual({ start: 0.5, end: 4, text: "Welkom allemaal." });
  expect(all.find((s) => s.text === "Dan de planning.")).toEqual({
    start: 59.4,
    end: 64.4,
    text: "Dan de planning.",
  });
  expect(all.at(-1)).toEqual({ start: 99.5, end: 102, text: "Tweede bestand." });
  // No second reading was sent anywhere.
  expect(out?.parts.every((p) => p.usage.seconds === 0)).toBe(true);
  // Times only ever go forward.
  for (const [i, s] of all.entries())
    if (i) expect(s.start).toBeGreaterThanOrEqual(all[i - 1]?.end ?? 0);
});

test("a long Whisper segment is cut at its sentence ends, as in the redo", () => {
  const out = assembleFirstPass(
    [
      piece("a", 40, [
        [
          0,
          36,
          "First point about the park. Second point about the lights. Third point about the pond.",
        ],
      ]),
    ],
    40,
  );
  const sentences = out?.parts[0]?.sentences ?? [];
  expect(sentences.length).toBeGreaterThan(1);
  expect(sentences.every((s) => s.end - s.start <= 15.01)).toBe(true);
});

test("a piece that heard nothing keeps its length, so later times stay right", () => {
  const out = assembleFirstPass([piece("a", 20, []), piece("b", 20, [[1, 3, "Hallo."]])], 40);
  expect(out?.parts.flatMap((p) => p.sentences)).toEqual([{ start: 21, end: 23, text: "Hallo." }]);
});

test("without times for every piece, or lengths that do not add up, the recording is read again", () => {
  expect(
    assembleFirstPass([piece("a", 20, [[0, 1, "x"]]), { key: "b", model: null, timed: null }], 40),
  ).toBeNull();
  expect(assembleFirstPass([piece("a", 20, [[0, 1, "x"]])], 60)).toBeNull();
  expect(assembleFirstPass([], 10)).toBeNull();
  // Within a few hundredths per piece (mp3 padding) it holds.
  expect(
    assembleFirstPass([piece("a", 20, [[0, 1, "x"]]), piece("b", 20, [])], 40.08),
  ).not.toBeNull();
});

test("what a finished conversation gets follows the profile and where it came from", () => {
  const eu = {
    providers: ["whisper"],
    recordings: "redo",
    uploads: "first-pass",
  } as unknown as FinalSettings;
  expect(finalTreatment(eu, "DASHBOARD_UPLOAD")).toBe("first-pass");
  expect(finalTreatment(eu, "PORTAL_AUDIO")).toBe("redo");
  expect(finalTreatment(eu, null)).toBe("redo");
  const none = { ...eu, uploads: "none" } as FinalSettings;
  expect(finalTreatment(none, "DASHBOARD_UPLOAD")).toBe("none");
  expect(finalTreatment(undefined, "PORTAL_AUDIO")).toBe("none");
  expect(finalTreatment({ ...eu, providers: [] } as FinalSettings, "PORTAL_AUDIO")).toBe("none");
});
