import { expect, test } from "bun:test";
import type { AnalysisRuntime } from "@dembrane/analysis";
import { FakeCompleter, fakeCalls, takeUnscopedFakeCalls } from "@dembrane/llm";
import { runFactCheck } from "../src/factcheck";
import type { MapStore } from "../src/store";

// The job names a check, not a project: its calls are billed to the check's project.
test("a fact-check's model calls are billed to the project of the check it loads", async () => {
  const project = "f0000000-0000-4000-8000-0000000000aa";
  const store = {
    getFactCheck: async () => ({
      status: "processing",
      attempt: 1,
      project_id: project,
      claim_key: "k1",
    }),
    getResult: async () => ({
      project_id: project,
      manifest: {
        arguments: [
          {
            id: "n1",
            statement: "Waits are long.",
            claim_key: "k1",
            evidence: [{ quotes: ["q"] }],
          },
        ],
      },
    }),
    projectContext: async () => ["Harbour", "Ferry plans"],
    completeFactCheck: async () => true,
  } as unknown as MapStore;
  const rt = { publishMap: async () => {} } as unknown as AnalysisRuntime;
  const completer = new FakeCompleter().on("CLAIM START", (r) =>
    r.googleSearch
      ? { text: "Weeks.", sources: [{ url: "https://example.org/a", title: "A" }] }
      : JSON.stringify({ verdict: "false", justification: "Weeks." }),
  );
  takeUnscopedFakeCalls();
  expect(
    await runFactCheck(
      { store, rt, completer },
      { factCheckId: "fc1", attempt: 1, resultId: "res1", nodeId: "n1" },
    ),
  ).toBe("done");
  expect(fakeCalls().length).toBeGreaterThan(0);
  expect(fakeCalls().map((c) => c.payer)).toEqual(
    fakeCalls().map(() => ({ ref: "project", id: project })),
  );
});
