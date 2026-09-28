import { describe, expect, test } from "bun:test";
import {
  audienceAssessments,
  audienceBudgets,
  conversationSlots,
  sanitizeMap,
  withoutNodes,
} from "../src/map";
import fixture from "./fixtures/map.json";

// Fixtures come from the Python functions (dembrane/popcorn/present.py) over the same input.
type J = Record<string, unknown>;
const f = fixture as unknown as J;
const payload = f.payload as J;
const order = f.order as string[];
const names = f.names as Record<string, string>;

describe("the audience map projection matches the Python", () => {
  test("sanitize_map with the legend's names", () => {
    expect(sanitizeMap(payload, order, names)).toEqual(f.sanitized as J);
  });
  test("sanitize_map without names", () => {
    expect(sanitizeMap(payload, order)).toEqual(f.sanitized_no_names as J);
  });
  test("conversation_slots", () => {
    expect(conversationSlots(payload, order)).toEqual(f.slots as J);
  });
  test("audience_assessments", () => {
    expect(audienceAssessments(f.states as J, f.sanitized as J)).toEqual(f.assessments as J);
  });
  test("_without_nodes", () => {
    expect(withoutNodes(f.projected as J, new Set(["o1", "o3"]))).toEqual(f.without as J);
    expect(withoutNodes(f.projected as J, new Set())).toEqual(f.without_none as J);
  });
});

describe("budgets", () => {
  const none = { nodeLimit: null, edgeLimit: null };
  test("defaults, derived edges and refusals", () => {
    expect(audienceBudgets(null, null, none).budgets).toEqual({ nodeLimit: 150, edgeLimit: 450 });
    expect(audienceBudgets(600, null, none).budgets).toEqual({ nodeLimit: 600, edgeLimit: 599 });
    expect(() => audienceBudgets(0, null, none)).toThrow(
      "nodeLimit must be a positive whole number, got 0",
    );
    expect(() => audienceBudgets(10, 3, none)).toThrow(
      "edgeLimit must be at least nodeLimit - 1 (9) so every tree edge fits, got 3",
    );
  });
});
