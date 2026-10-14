import { expect, test } from "bun:test";
import { PRODUCERS_KEY } from "@dembrane/analysis";
import { FakeCompleter } from "@dembrane/llm";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";

// The embedding deployment is asked about once per worker, not once per read.
test("reads of one worker probe the embeddings once", async () => {
  let probes = 0;
  const saved = new Map<string, number[]>();
  const executor = {
    store: {
      loadEmbeddings: async () => new Map(),
      saveEmbedding: async (o: { inputHash: string; vector: number[] }) => {
        saved.set(o.inputHash, o.vector);
        return [o.inputHash, o.vector];
      },
    },
    publishEvent: async () => {},
    services: {
      [PRODUCERS_KEY]: {
        probe: async () => {
          probes++;
          return { model: "m", endpoint: null, dims: 2, inputNormalization: "n", taskType: null };
        },
        embed: async () => [1, 0],
      },
    },
  };
  const analysis = { ...NO_ANALYSIS, executor: executor as never };
  const deps = {
    db: { $client: {} } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    completer: new FakeCompleter(),
    flags: { present: true, canvas: true },
    participantBaseUrl: "",
    adminBaseUrl: "",
    databaseUrl: "unused",
    analysis: () => analysis,
  };
  for (const read of ["w1", "w2", "w3"]) {
    const similar = tickDeps(deps, read, analysis).similar;
    expect(similar).toBeTruthy();
    await similar?.("project", ["night buses"]);
  }
  expect(probes).toBe(1);
});
