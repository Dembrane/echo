import { expect, test } from "bun:test";
import { identityKey, PRODUCERS_KEY, probeIdentity } from "@dembrane/analysis";
import { type Embedder, EmbeddingRouteChanged, FakeCompleter } from "@dembrane/llm";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";

/** An embedder whose provider is the one the project in scope names, as the routing embedder is. */
function perProject(provider: { current: string }, requests: string[]): Embedder {
  const made = (p: string) => ({
    provider: p,
    identity: { model: `${p}/embedding`, endpoint: `${p}:endpoint` },
    hold: {},
    async embed() {
      requests.push(p);
      return [1, 0];
    },
  });
  return {
    model: "default",
    endpoint: "default",
    dimensions: 2,
    embed: async () => [1, 0],
    pinned: async () => made(provider.current),
  };
}

// Each embedding provider is probed once per worker, and a project's vectors are keyed by the
// provider that made them, whichever project was read first.
test("reads of one worker probe each provider once and key vectors by their provider", async () => {
  const provider = { current: "scaleway" };
  const requests: string[] = [];
  const embedder = perProject(provider, requests);
  const keys: { provider: string; key: string }[] = [];
  const executor = {
    store: {
      loadEmbeddings: async () => new Map(),
      saveEmbedding: async (o: { inputHash: string; vector: number[]; configKey: string }) => {
        keys.push({ provider: provider.current, key: o.configKey });
        return [o.inputHash, o.vector];
      },
    },
    publishEvent: async () => {},
    services: {
      [PRODUCERS_KEY]: {
        probe: (known?: Map<string, number>) => probeIdentity(embedder, known),
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
  for (const [read, p] of [
    ["w1", "scaleway"],
    ["w2", "google"],
    ["w3", "scaleway"],
    ["w4", "google"],
  ] as const) {
    provider.current = p;
    const similar = tickDeps(deps, read, analysis).similar;
    expect(similar).toBeTruthy();
    await similar?.("project", [`night buses ${read}`]);
  }
  // One probe request per provider, then one embed per read, each by the provider of its project.
  expect(requests).toEqual(["scaleway", "scaleway", "google", "google", "scaleway", "google"]);
  const key = (p: string) =>
    identityKey({
      model: `${p}/embedding`,
      endpoint: `${p}:endpoint`,
      dims: 2,
      inputNormalization: "collapse-whitespace-v1",
      taskType: null,
    });
  expect(keys).toEqual([
    { provider: "scaleway", key: key("scaleway") },
    { provider: "google", key: key("google") },
    { provider: "scaleway", key: key("scaleway") },
    { provider: "google", key: key("google") },
  ]);
});

// A project that switches provider while its read embeds does not fail the read: the batch is
// run once more on the provider it has now, and nothing the old one made is kept.
test("a provider switch mid-read reruns the embedding batch once instead of failing the read", async () => {
  const provider = { current: "scaleway" };
  const sent: string[] = [];
  let first = true;
  const embedder: Embedder = {
    model: "default",
    endpoint: "default",
    dimensions: 2,
    embed: async () => [1, 0],
    pinned: async () => {
      const p = provider.current;
      return {
        provider: p,
        identity: { model: `${p}/embedding`, endpoint: `${p}:endpoint` },
        hold: {},
        async embed() {
          if (first && p === "scaleway") {
            // The project moves while the first vector is being made.
            first = false;
            provider.current = "google";
            throw new EmbeddingRouteChanged("scaleway", "google");
          }
          sent.push(p);
          return [1, 0];
        },
      };
    },
  };
  const saved: string[] = [];
  const executor = {
    store: {
      loadEmbeddings: async () => new Map(),
      saveEmbedding: async (o: { inputHash: string; vector: number[]; configKey: string }) => {
        saved.push(o.configKey);
        return [o.inputHash, o.vector];
      },
    },
    publishEvent: async () => {},
    services: {
      [PRODUCERS_KEY]: {
        probe: (known?: Map<string, number>) => probeIdentity(embedder, known),
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
  const similar = tickDeps(deps, "switch", analysis).similar;
  const out = await similar?.("project", ["night buses", "late trains"]);
  expect(out?.size).toBe(2);
  expect(new Set(sent)).toEqual(new Set(["google"]));
  expect(new Set(saved).size).toBe(1);
});
