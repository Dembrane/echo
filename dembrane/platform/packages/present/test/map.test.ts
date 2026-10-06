import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@dembrane/analysis";
import {
  audienceAssessments,
  audienceBudgets,
  audienceMap,
  conversationSlots,
  type MapStore,
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

describe("the room's map carries the project's groups, read-only", () => {
  const member = (i: number) => ({ revisionId: `r${i}`, objectId: `o${i}`, type: "argument" });
  const row = (id: string, status: string, members: number[], extra: J = {}) => ({
    id,
    project_id: "p1",
    snapshot_id: "s1",
    selection_key: `key-${id}`,
    members: members.map(member),
    status,
    attempt: 1,
    title: status === "ready" ? `Title ${id}` : null,
    error: status === "failed" ? "The title could not be generated. Try again." : null,
    model: "m",
    prompt_version: "v",
    requested_by: "d2000000-0000-4000-8000-000000000001",
    created_at: "2026-10-06 10:00:00+00",
    updated_at: "2026-10-06 10:00:01+00",
    completed_at: null,
    ...extra,
  });
  const rows = [
    row("g-ready", "ready", [1, 2, 3]),
    row("g-pending", "pending", [2, 3, 4]),
    row("g-failed", "failed", [1, 3, 4]),
    // Over an object the presenter hid: its title speaks of what the room is not shown.
    row("g-hidden", "ready", [1, 2, 5]),
    // Over an object a conversation exclusion keeps off the map.
    row("g-excluded", "ready", [2, 3, 6]),
  ];
  const store = {
    ceilings: { nodeLimit: null, edgeLimit: null },
    snapshot: async () => null,
    currentSnapshot: async () =>
      ({ id: "s1", projectId: "p1", createdAt: "2026-09-01T10:00:00Z" }) as unknown as Snapshot,
    legacyResults: async () => [],
    graph: async () => ({ payload, factChecks: {} }),
    legacyGraph: async () => null,
    requestGeneration: async () => {},
    groups: async () => rows,
  } as unknown as MapStore;

  const read = () =>
    audienceMap(store, {
      projectId: "p1",
      settings: { presentation: { hidden_items: ["o5"] } },
      nodeLimit: null,
      edgeLimit: null,
      legend: { order, names: {} },
      excluded: async () => new Set(["o6"]),
    });

  test("pending, failed and titled groups, never one over a hidden or excluded object", async () => {
    const groups = (await read()).groups as J[];
    expect(groups.map((g) => [g.id, g.status, g.title])).toEqual([
      ["g-ready", "ready", "Title g-ready"],
      ["g-pending", "pending", null],
      ["g-failed", "failed", null],
    ]);
    expect(groups[0]?.members).toEqual([member(1), member(2), member(3)]);
    expect(groups[0]?.snapshotId).toBe("s1");
  });

  test("never who made a group, nor why one failed", async () => {
    const groups = (await read()).groups as J[];
    for (const group of groups) {
      expect(Object.keys(group).sort()).toEqual(
        ["createdAt", "error", "id", "members", "snapshotId", "status", "title"].sort(),
      );
      expect(group.error).toBeNull();
    }
    expect(JSON.stringify(groups)).not.toContain("d2000000");
  });
});
