import { describe, expect, test } from "bun:test";
import {
  EmbeddingRouteChanged,
  FakeEmbedder,
  type PinnedEmbedder,
  type ProviderResolver,
  routingEmbedder,
} from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { EmbeddingService, probeIdentity } from "../src/embeddings";
import { embeddingBatch } from "../src/recipes/services";
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

// A project that switches while a recipe's embed step is running: the step drops the batch and
// runs it once more on the project's new provider, so the analysis finishes instead of failing.
describe("an embedding batch of a recipe step", () => {
  const policy = { providers: ["scaleway", "google"], default: "scaleway" } as const;
  const decision = (provider: "scaleway" | "google") => ({
    provider,
    job: "analysis" as const,
    organisationId: null,
    reason: "project",
    allowed: ["scaleway", "google"] as string[],
  });
  /** The project is on Scaleway until its first vector is answered, then on Google. */
  const world = () => {
    const saved: { key: string; hash: string }[] = [];
    const store = {
      loadEmbeddings: async () => new Map(),
      saveEmbedding: async (o: { inputHash: string; configKey: string; vector: number[] }) => {
        saved.push({ key: o.configKey, hash: o.inputHash });
        return [o.inputHash, o.vector];
      },
    } as unknown as AnalysisStore;
    const embedders = {
      scaleway: new FakeEmbedder(2, "scaleway/embedding"),
      google: new FakeEmbedder(2, "google/embedding"),
    };
    let on: "scaleway" | "google" = "scaleway";
    const first = embedders.scaleway.embed.bind(embedders.scaleway);
    embedders.scaleway.embed = async (t: string) => {
      const v = await first(t);
      on = "google";
      return v;
    };
    const resolver: ProviderResolver = async () => decision(on);
    const embedder = routingEmbedder(embedders, policy, resolver);
    const known = () =>
      new Map([
        ["scaleway", 2],
        ["google", 2],
      ]);
    const services = {
      // The dimensions are known, so the probe asks nothing and the switch happens mid-batch.
      probe: () => probeIdentity(embedder, known()),
      embed: embedder.embed,
    };
    return { store, services, saved, embedders };
  };

  test("a switch mid-batch reruns the batch once, on the new provider", async () => {
    const { store, services, saved, embedders } = world();
    let runs = 0;
    const done = await withPayer({ ref: "project", id: "p" }, () =>
      embeddingBatch(store, services, async (service, identity) => {
        runs++;
        return { batch: await service.ensure("p", ["a", "b", "c"]), identity };
      }),
    );
    expect(runs).toBe(2);
    expect(done.identity.pin?.provider).toBe("google");
    expect(done.batch.ids.size).toBe(3);
    // Every vector of the batch that was kept came from the provider whose identity keys it.
    expect(new Set(saved.map((s) => s.key)).size).toBe(1);
    expect(embedders.google.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("a second change in a row fails the step", async () => {
    const { store } = world();
    let probes = 0;
    const services = {
      probe: async () => {
        probes++;
        const pin: PinnedEmbedder = {
          provider: "scaleway",
          identity: { model: "m", endpoint: "e" },
          hold: {},
          embed: async () => {
            throw new EmbeddingRouteChanged("scaleway", "google");
          },
        };
        return { pin, model: "m", endpoint: "e", dims: 2, inputNormalization: "n", taskType: null };
      },
      embed: async () => [1, 0],
    };
    await expect(
      embeddingBatch(store, services, (service) => service.ensure("p", ["a", "b", "c"])),
    ).rejects.toBeInstanceOf(EmbeddingRouteChanged);
    expect(probes).toBe(2);
  });

  test("any other failure is not rerun", async () => {
    const { store, services } = world();
    let runs = 0;
    await expect(
      embeddingBatch(store, services, async () => {
        runs++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(runs).toBe(1);
  });
});
