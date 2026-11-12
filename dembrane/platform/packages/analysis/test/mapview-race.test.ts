import { expect, test } from "bun:test";
import { type Snapshot, SnapshotConflict } from "../src/contracts";
import { currentMapSnapshot, type MapViewReads } from "../src/mapview";
import type { AnalysisStore } from "../src/store";

const snap = (id: string) =>
  ({ id, projectId: "p", contentHash: `hash-${id}`, manifest: {} }) as unknown as Snapshot;

/** A view that another writer advances before every publish this reader attempts. */
function busyView() {
  let head = "w0";
  let publishes = 0;
  const store = {
    findScope: async () => (publishes ? { id: "s", currentSnapshotId: head } : null),
    ensureScope: async () => ({ id: "s", currentSnapshotId: head }),
    getSnapshot: async (id: string) => snap(id),
    currentRevisions: async () => new Map(),
    getRevisions: async () => new Map(),
    assessmentsFor: async () => new Map(),
    publishSnapshot: async (_n: unknown, expected: string | null) => {
      publishes++;
      head = `w${publishes}`; // the other writer lands first, every time
      throw new SnapshotConflict("s", expected, head);
    },
  } as unknown as AnalysisStore;
  const reads = {
    producerHeads: async () => [],
    legacyResults: async () => [],
  } as unknown as MapViewReads;
  return { store, reads, head: () => head, publishes: () => publishes };
}

test("a read that keeps losing the advance race shows the snapshot the winner published", async () => {
  const view = busyView();
  const snapshot = await currentMapSnapshot("p", view.store, view.reads, {
    publish: async () => {},
  });
  expect(view.publishes()).toBe(3);
  expect(snapshot?.id).toBe(view.head());
});
