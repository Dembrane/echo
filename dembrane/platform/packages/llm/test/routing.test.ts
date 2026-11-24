import { describe, expect, test } from "bun:test";
import { type Payer, withPayer } from "@dembrane/observability";
import { generateText, streamText } from "ai";
import {
  bootGaps,
  createRegistry,
  FakeCompleter,
  FakeEmbedder,
  fakeCalls,
  fakeModels,
  type LlmSettings,
  type ModelCall,
  onlyProvider,
  type ProviderResolver,
  profileForProvider,
  type RouteDecision,
  routedKit,
  routingCompleter,
  routingEmbedder,
  routingModels,
  routingPolicyOf,
  STUB_VERTEX_AUTH,
  settingsFor,
  wireStubs,
} from "../src";

const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
  baseUrl: "https://scaleway.test/v1",
  apiKey: "k",
  searchGrounding: true,
  textFast: ["gemini-a", "gemini-b"],
  multiModalFast: ["gemini-a"],
  multiModalPro: ["gemini-a", "gemini-b"],
  compatTextFast: ["glm-5.3"],
  compatMultiModalFast: ["glm-5.3"],
  compatMultiModalPro: ["glm-5.3"],
  vertexProject: "p",
  vertexLocation: "eu",
  embeddingModel: "text-embedding-004",
  compatEmbeddingModel: "qwen3-embedding-8b",
  embeddingLocation: "europe-west4",
  embeddingDimensions: 8,
};

const policy = routingPolicyOf(SETTINGS);
const SCALEWAY_PROJECT = "11111111-1111-4111-8111-111111111111";
const GOOGLE_PROJECT = "22222222-2222-4222-8222-222222222222";

const decision = (provider: "scaleway" | "google", reason = "project"): RouteDecision => ({
  provider,
  organisationId: "33333333-3333-4333-8333-333333333333",
  reason,
  allowed: ["scaleway", "google"],
});

/** Sends the Google project to Google and anything else to Scaleway, as a database would. */
const byProject: ProviderResolver = async (who) =>
  who && "ref" in who && who.id === GOOGLE_PROJECT ? decision("google") : decision("scaleway");

const inProject = <T>(id: string, fn: () => T) => withPayer({ ref: "project", id }, fn);

describe("routing models", () => {
  const prompt = (text: string) => ({ prompt: text });

  test("each call goes to the provider of its project, for text, streams and embeddings", async () => {
    const calls: ModelCall[] = [];
    const observe = (c: ModelCall) => calls.push(c);
    const scaleway = fakeModels({ modelId: "scaleway-model", observe });
    const google = fakeModels({ modelId: "google-model", observe });
    const models = routingModels({ scaleway, google }, policy, byProject);

    for (const [id, expected] of [
      [SCALEWAY_PROJECT, "scaleway-model"],
      [GOOGLE_PROJECT, "google-model"],
    ] as const) {
      const out = await inProject(id, () =>
        generateText({ model: models.model("text_fast"), ...prompt("hi") }),
      );
      expect(out.text).toBe("ok");
      await inProject(id, async () => {
        const s = streamText({ model: models.model("multi_modal_pro"), ...prompt("hi") });
        for await (const _ of s.textStream) void _;
      });
      await inProject(id, () => models.embedding().model.doEmbed({ values: ["a"] }));
      const mine = fakeCalls().filter((c) => c.payer && "ref" in c.payer && c.payer.id === id);
      expect(mine.map((c) => c.model)).toEqual([expected, expected, "fake/embedding"]);
    }
    // The call log says where the policy sent each call, for generate, stream and embed alike.
    const reached = (provider: string) =>
      calls.filter((c) => c.routing?.provider === provider).map((c) => c.kind);
    expect(reached("scaleway")).toEqual(["generate", "stream", "embed"]);
    expect(reached("google")).toEqual(["generate", "stream", "embed"]);
    expect(calls.every((c) => c.routing?.organisationId)).toBe(true);
  });

  test("a resolver that throws, or names a provider the deployment lacks, is the default", async () => {
    const scaleway = fakeModels({ modelId: "scaleway-model" });
    const google = fakeModels({ modelId: "google-model" });
    const throwing: ProviderResolver = async () => {
      throw new Error("database is down");
    };
    const models = routingModels({ scaleway, google }, policy, throwing);
    await inProject(GOOGLE_PROJECT, () =>
      generateText({ model: models.model("text_fast"), prompt: "x" }),
    );
    const onlyScaleway = routingModels(
      { scaleway },
      routingPolicyOf({ provider: "openai-compatible" }),
      async () => decision("google"),
    );
    await inProject(GOOGLE_PROJECT, () =>
      generateText({ model: onlyScaleway.model("text_fast"), prompt: "x" }),
    );
    expect(fakeCalls().map((c) => c.model)).toEqual(["scaleway-model", "scaleway-model"]);
  });

  test("the completer and the embedder follow the project too, and identity says which", async () => {
    const completers = {
      scaleway: new FakeCompleter(() => "scaleway-id"),
      google: new FakeCompleter(() => "google-id"),
    };
    for (const c of Object.values(completers)) c.on("", "answer");
    const embedders = {
      scaleway: new FakeEmbedder(8, "scaleway/embedding"),
      google: new FakeEmbedder(8, "google/embedding"),
    };
    const completer = routingCompleter(completers, policy, byProject);
    const embedder = routingEmbedder(embedders, policy, byProject);
    await inProject(GOOGLE_PROJECT, () => completer.complete({ group: "text_fast", user: "hi" }));
    await inProject(SCALEWAY_PROJECT, () => completer.complete({ group: "text_fast", user: "hi" }));
    expect(completers.google.calls).toHaveLength(1);
    expect(completers.scaleway.calls).toHaveLength(1);
    expect(await inProject(GOOGLE_PROJECT, () => completer.identityOf?.("text_fast"))).toBe(
      "google-id",
    );
    expect(await inProject(SCALEWAY_PROJECT, () => embedder.identity?.())).toMatchObject({
      model: "scaleway/embedding",
    });
    expect(await inProject(GOOGLE_PROJECT, () => embedder.identity?.())).toMatchObject({
      model: "google/embedding",
    });
    await inProject(GOOGLE_PROJECT, () => embedder.embed("x"));
    expect(embedders.google.calls).toEqual(["x"]);
    expect(embedders.scaleway.calls).toEqual([]);
    // Search grounding exists for a project on Google and for no other.
    expect(await inProject(SCALEWAY_PROJECT, () => completer.grounds?.())).toBe(true);
  });
});

describe("providers on the wire", () => {
  const profileOf = (id: "scaleway" | "google") => profileForProvider(SETTINGS, id);
  const quick = { attemptsPerDeployment: 2, backoffMs: 0, sleep: async () => {} };

  /** Both providers with their own wire; the Vertex stub throws on a request meant for the Scaleway project. */
  function wired(opts: Parameters<typeof wireStubs>[0] = {}) {
    const wire = wireStubs({
      vertexGuard: (r) => {
        if (r.body.includes("scaleway-project-marker"))
          throw new Error("a request for the Scaleway project reached Vertex");
      },
      ...opts,
    });
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    });
    return { wire, kit: routedKit(registry, policy, byProject) };
  }

  test("a project on Scaleway never reaches Vertex, for every model group, embeddings and grounding", async () => {
    const { wire, kit } = wired();
    const ask = (group: "text_fast" | "multi_modal_fast" | "multi_modal_pro") =>
      inProject(SCALEWAY_PROJECT, () =>
        generateText({ model: kit.models.model(group), prompt: "scaleway-project-marker" }),
      );
    for (const g of ["text_fast", "multi_modal_fast", "multi_modal_pro"] as const)
      expect((await ask(g)).text).toBe("stub answer");
    await inProject(SCALEWAY_PROJECT, () =>
      kit.completer.complete({ group: "text_fast", user: "scaleway-project-marker" }),
    );
    await inProject(SCALEWAY_PROJECT, () => kit.embedder.embed("scaleway-project-marker"));
    await expect(
      inProject(SCALEWAY_PROJECT, () =>
        kit.completer.complete({ group: "text_fast", user: "x", googleSearch: true }),
      ),
    ).rejects.toThrow(/search grounding/);
    expect(wire.seen.vertex).toEqual([]);
    expect(wire.seen.compat.length).toBeGreaterThanOrEqual(5);
  });

  test("a project on Google reaches Vertex, labelled with its organisation, and grounds", async () => {
    const { wire, kit } = wired();
    const out = await inProject(GOOGLE_PROJECT, () =>
      kit.completer.complete({ group: "text_fast", user: "hello", googleSearch: true }),
    );
    expect(out.text).toBe("stub answer");
    expect(wire.seen.compat).toEqual([]);
    const sent = JSON.parse(wire.seen.vertex[0]?.body ?? "{}");
    expect(sent.labels).toEqual({ organisation_id: "33333333-3333-4333-8333-333333333333" });
    expect(wire.seen.vertex[0]?.url).toContain("/projects/p/locations/eu/");
  });

  test("Scaleway never falls back to Vertex, on a rate limit or a server fault", async () => {
    for (const status of [429, 503]) {
      const { wire, kit } = wired({ compatStatus: status });
      await expect(
        inProject(SCALEWAY_PROJECT, () =>
          generateText({
            model: kit.models.model("text_fast"),
            prompt: "scaleway-project-marker",
            maxRetries: 0,
          }),
        ),
      ).rejects.toBeDefined();
      expect(wire.seen.compat.length).toBeGreaterThan(1);
      expect(wire.seen.vertex).toEqual([]);
    }
  });

  test("Google falls back to Scaleway after its Gemini list", async () => {
    const calls: ModelCall[] = [];
    const wire = wireStubs({ vertexStatus: 503 });
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      observe: (c) => calls.push(c),
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    });
    const kit = routedKit(registry, policy, byProject);
    const out = await inProject(GOOGLE_PROJECT, () =>
      generateText({ model: kit.models.model("text_fast"), prompt: "hi", maxRetries: 0 }),
    );
    expect(out.text).toBe("stub answer");
    expect(wire.seen.vertex.length).toBeGreaterThan(0);
    expect(wire.seen.compat).toHaveLength(1);
    const last = calls.at(-1);
    expect(last).toMatchObject({ provider: "openai-compatible", fallback: true, status: "ok" });
    expect(last?.routing?.provider).toBe("google");
  });

  test("a deployment with only Scaleway builds no Vertex client and routes everything there", async () => {
    const only = { ...SETTINGS, providers: undefined, vertexProject: "" };
    const onlyPolicy = routingPolicyOf(only);
    expect(onlyPolicy.providers).toEqual(["scaleway"]);
    const wire = wireStubs({
      vertexGuard: () => {
        throw new Error("Vertex was called");
      },
    });
    const registry = createRegistry(only, onlyPolicy, (id) => profileForProvider(only, id), {
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    });
    expect(Object.keys(registry)).toEqual(["scaleway"]);
    // The database may say Google; with one provider the resolver is never asked.
    const kit = routedKit(registry, onlyPolicy, onlyProvider(onlyPolicy));
    await inProject(GOOGLE_PROJECT, () =>
      generateText({ model: kit.models.model("text_fast"), prompt: "x" }),
    );
    expect(wire.seen.vertex).toEqual([]);
    expect(wire.seen.compat).toHaveLength(1);
  });
});

test("settings for a provider carry its own kind", () => {
  expect(settingsFor(SETTINGS, "google").provider).toBe("vertex");
  expect(settingsFor(SETTINGS, "scaleway").provider).toBe("openai-compatible");
  expect(profileForProvider(SETTINGS, "scaleway").name).toBe("dembrane-26-10-whisper-eu");
  expect(profileForProvider(SETTINGS, "google").name).toBe("dembrane-26-10-gemini");
  expect(() => routingPolicyOf({ provider: "vertex", providers: ["orai"] })).toThrow(
    /not a provider/,
  );
});

describe("boot refuses a speech provider that is not the provider's own", () => {
  const withProfile = (transcriptionProfile: string): LlmSettings => ({
    ...SETTINGS,
    transcriptionProfile,
  });
  const gapsOf = (s: LlmSettings) =>
    bootGaps(s, routingPolicyOf(s), (id) => profileForProvider(s, id));

  test("Scaleway as the default with the Gemini profile is a boot failure naming both", () => {
    const gaps = gapsOf(withProfile("dembrane-26-10-gemini"));
    expect(gaps).toEqual([
      "transcription profile dembrane-26-10-gemini uses gemini, which is not provider scaleway's own speech provider (whisper)",
    ]);
  });

  test("Google as the default with the Whisper profile is a boot failure too", () => {
    const s: LlmSettings = {
      ...withProfile("dembrane-26-10-whisper-eu"),
      provider: "vertex",
      providers: ["google", "scaleway"],
    };
    expect(gapsOf(s)).toEqual([
      "transcription profile dembrane-26-10-whisper-eu uses whisper, which is not provider google's own speech provider (gemini)",
    ]);
  });

  test("each provider with its own profile boots", () => {
    expect(gapsOf(SETTINGS)).toEqual([]);
    expect(gapsOf(withProfile("dembrane-26-10-whisper-eu"))).toEqual([]);
  });
});
