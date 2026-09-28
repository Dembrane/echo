import { expect, test } from "bun:test";
import { AnalysisValidationError } from "../src/contracts";
import { contentHash } from "../src/hashing";
import { validatePayload } from "../src/types";

function err(type: string, payload: unknown): string {
  try {
    validatePayload(type, payload);
  } catch (e) {
    if (e instanceof AnalysisValidationError) return e.message;
    throw e;
  }
  return "OK";
}

// Expected texts are what the Python validate_payload raised for the same input.
test("payload errors read exactly like pydantic's", () => {
  expect(
    err("argument", {
      statement: "  x ",
      epistemicKind: "claim",
      zz: 1,
      evidence: [{ conversationId: "", quotes: [1] }],
      valence: "bad",
    }),
  ).toBe(
    "invalid argument payload: valence: Input should be 'positive', 'negative' or 'neutral'; evidence.0.conversationId: String should have at least 1 character; evidence.0.quotes.0: Input should be a valid string; zz: Extra inputs are not permitted",
  );
  expect(err("argument", 5)).toBe(
    "invalid argument payload: (root): Input should be a valid dictionary or instance of ArgumentPayload",
  );
  expect(
    err("stakeholder", {
      name: "a",
      role: "b",
      stake: "c",
      rung: "voiced",
      weight: { stake: true, mentions: 2 },
    }),
  ).toBe("invalid stakeholder payload: weight.mentions: Input should be less than or equal to 1");
  expect(err("popcorn", { phrase: "x".repeat(91) })).toBe(
    "invalid popcorn payload: phrase: String should have at most 90 characters",
  );
  expect(
    err("tension", {
      poleA: "a",
      poleB: "b",
      knot: "k",
      toResolve: "t",
      quotes: [{ text: "q", pole: "C" }],
    }),
  ).toBe("invalid tension payload: quotes.0.pole: Input should be 'A' or 'B'");
  expect(err("argument", { statement: 5, epistemicKind: "claim", evidence: "x" })).toBe(
    "invalid argument payload: statement: Input should be a valid string; evidence: Input should be a valid list",
  );
  expect(err("argument", { statement: "s", epistemicKind: "claim", evidence: [5] })).toBe(
    "invalid argument payload: evidence.0: Input should be a valid dictionary or instance of Evidence",
  );
});

test("normalised payloads drop None, keep defaults and strip strings", () => {
  const p = validatePayload("stakeholder", {
    name: " a ",
    role: "b",
    stake: "c",
    rung: "voiced",
    weight: { stake: 1, mentions: "0.5" },
    invokedBy: null,
  });
  expect(JSON.parse(JSON.stringify(p))).toEqual({
    name: "a",
    role: "b",
    stake: "c",
    rung: "voiced",
    weight: { stake: 1, mentions: 0.5 },
    quotes: [],
  });
  // Python hashed weight.stake as 1.0 (a float), not 1.
  expect(contentHash(p)).toBe("dacdfde596e8a1bff122edf95eb211bb8c56e24a5ca5e63361f34c694a3fbbfb");
});
