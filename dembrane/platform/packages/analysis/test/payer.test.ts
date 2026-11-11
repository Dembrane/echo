import { expect, test } from "bun:test";
import { analysisOutbox, analysisRun } from "../src/runtime";

// The queue sets a job's payer on every start (queue/test/payer.integration.test.ts); runs
// are billed to themselves, and the recorder finds their project.
test("an analysis run is billed to its run; the outbox makes no model calls", () => {
  expect(analysisRun.payer?.({ runId: "r1" })).toEqual({ ref: "analysis_run", id: "r1" });
  expect(analysisOutbox.payer).toBeUndefined();
});
