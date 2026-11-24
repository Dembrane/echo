import { expect, test } from "bun:test";
import { EmbeddingRouteChanged, type PinnedEmbedder } from "@dembrane/llm";
import { EmbeddingService } from "../src/embeddings";
import type { AnalysisStore } from "../src/store";

// A batch whose provider changes before it is stored is dropped whole, and no embed after
// the change reaches the provider the project left.
test("a provider change mid-batch stores nothing from the other provider", async () => {
  const saved: string[] = [];
  const store = {
    loadEmbeddings: async () => new Map(),
    saveEmbedding: async (o: { inputHash: string; vector: number[] }) => {
      saved.push(o.inputHash);
      return [o.inputHash, o.vector];
    },
  } as unknown as AnalysisStore;
  let sent = 0;
  const pin: PinnedEmbedder = {
    provider: "scaleway",
    identity: { model: "scaleway/embedding", endpoint: "scaleway:e" },
    hold: {},
    async embed() {
      if (sent++ >= 1) throw new EmbeddingRouteChanged("scaleway", "google");
      return [1, 0];
    },
  };
  const identity = {
    pin,
    model: "scaleway/embedding",
    endpoint: "scaleway:e",
    dims: 2,
    inputNormalization: "n",
    taskType: null,
  };
  const service = new EmbeddingService(
    store,
    identity,
    async () => {
      throw new Error("the unpinned embed must not be used");
    },
    1,
  );
  await expect(service.ensure("p", ["a", "b", "c"])).rejects.toBeInstanceOf(EmbeddingRouteChanged);
  expect(sent).toBe(2);
  expect(saved).toHaveLength(1);
});
