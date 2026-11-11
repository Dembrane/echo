import { expect, test } from "bun:test";
import { type Snapshot, SnapshotConflict } from "../src/contracts";
import { assembleSnapshot, type SnapshotRequest } from "../src/snapshots";
import type { AnalysisStore } from "../src/store";

const request: SnapshotRequest = {
  projectId: "p",
  viewId: "v",
  scopeKey: "view",
  producers: [],
};

/** A store whose view is empty when the loser reads it and advanced by the winner before it publishes. */
function racingStore() {
  let head: string | null = null;
  const expectedSeen: (string | null)[] = [];
  const store = {
    ensureScope: async () => ({ id: "s", currentSnapshotId: head }),
    findScope: async () => null,
    currentRevisions: async () => new Map(),
    getRevisions: async () => new Map(),
    assessmentsFor: async () => new Map(),
    publishSnapshot: async (_n: unknown, expected: string | null) => {
      expectedSeen.push(expected);
      if (expectedSeen.length === 1) head = "winner"; // the other writer lands first
      if (head !== expected) throw new SnapshotConflict("s", expected, head);
      return { id: "loser" } as Snapshot;
    },
  } as unknown as AnalysisStore;
  return { store, expectedSeen };
}

test("a writer that lost the race on a fresh view re-reads the head and publishes", async () => {
  const { store, expectedSeen } = racingStore();
  const snapshot = await assembleSnapshot(request, store);
  expect(snapshot.id).toBe("loser");
  expect(expectedSeen).toEqual([null, "winner"]);
});

test("a caller that names the expected snapshot still gets the conflict", async () => {
  const { store } = racingStore();
  await expect(assembleSnapshot(request, store, null)).rejects.toBeInstanceOf(SnapshotConflict);
});
