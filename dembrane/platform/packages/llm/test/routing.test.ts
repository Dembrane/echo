import { describe, expect, test } from "bun:test";
import { withPayer } from "@dembrane/observability";
import { generateText, streamText } from "ai";
import {
  bootGaps,
  createRegistry,
  EmbeddingRouteChanged,
  FakeCompleter,
  FakeEmbedder,
  fakeCalls,
  fakeModels,
  type Job,
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

const decision = (
  provider: "scaleway" | "google",
  reason = "project",
  job: Job = "analysis",
): RouteDecision => ({
  provider,
  job,
  organisationId: "33333333-3333-4333-8333-333333333333",
  reason,
  allowed: ["scaleway", "google"],
});

/** Sends the Google project to Google and anything else to Scaleway, as a database would. */
const byProject: ProviderResolver = async (who, job) =>
  who && "ref" in who && who.id === GOOGLE_PROJECT
    ? decision("google", "project", job)
    : decision("scaleway", "project", job);

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
    // Only this test's calls: the list is shared by every test of the file.
    const before = fakeCalls().length;
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
    expect(
      fakeCalls()
        .slice(before)
        .map((c) => c.model),
    ).toEqual(["scaleway-model", "scaleway-model"]);
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

describe("an embedding batch is pinned to one decision", () => {
  test("identity and every embed follow it, and a change drops the batch before the next call", async () => {
    let now: "scaleway" | "google" = "scaleway";
    const resolver: ProviderResolver = async () => decision(now);
    const embedders = {
      scaleway: new FakeEmbedder(8, "scaleway/embedding"),
      google: new FakeEmbedder(8, "google/embedding"),
    };
    const embedder = routingEmbedder(embedders, policy, resolver);
    await inProject(GOOGLE_PROJECT, async () => {
      const pin = await embedder.pinned?.();
      expect(pin?.identity.model).toBe("scaleway/embedding");
      await pin?.embed("one");
      now = "google";
      // The first key was Scaleway's: a vector from Google under it would mix the two.
      await expect(pin?.embed("two")).rejects.toBeInstanceOf(EmbeddingRouteChanged);
    });
    expect(embedders.scaleway.calls).toEqual(["one"]);
    expect(embedders.google.calls).toEqual([]);
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

  test("the organisation label keeps the call's own thinking budget, whichever options key it used", async () => {
    for (const key of ["google", "vertex", "googleVertex"]) {
      const { wire, kit } = wired();
      await inProject(GOOGLE_PROJECT, () =>
        generateText({
          model: kit.models.model("multi_modal_pro"),
          prompt: "hi",
          providerOptions: { [key]: { thinkingConfig: { thinkingBudget: 2048 } } },
        }),
      );
      const sent = JSON.parse(wire.seen.vertex[0]?.body ?? "{}");
      expect(sent.labels).toEqual({ organisation_id: "33333333-3333-4333-8333-333333333333" });
      expect(sent.generationConfig?.thinkingConfig?.thinkingBudget).toBe(2048);
    }
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

  test("a project that moves back to Scaleway during retries finishes on Scaleway, its rows saying so", async () => {
    const calls: ModelCall[] = [];
    let moved = false;
    const wire = wireStubs({ vertexStatus: 429 });
    // The project leaves Google once its first request has failed.
    const resolver: ProviderResolver = async () => decision(moved ? "scaleway" : "google");
    const vertexSeen = () => wire.seen.vertex.length;
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      observe: (c) => calls.push(c),
      transport: {
        vertex: {
          fetch: (async (...a: Parameters<typeof fetch>) => {
            const res = await wire.vertex(...a);
            moved = true;
            return res;
          }) as typeof fetch,
          ...STUB_VERTEX_AUTH,
        },
        compatFetch: wire.compat,
      },
    });
    const kit = routedKit(registry, policy, resolver);
    const out = await inProject(GOOGLE_PROJECT, () =>
      generateText({ model: kit.models.model("text_fast"), prompt: "hi", maxRetries: 0 }),
    );
    expect(out.text).toBe("stub answer");
    expect(vertexSeen()).toBe(1);
    expect(wire.seen.compat).toHaveLength(1);
    expect(calls.map((c) => [c.provider, c.routing?.provider])).toEqual([
      ["vertex", "google"],
      ["openai-compatible", "scaleway"],
    ]);
  });

  /** A registry on the wire where Vertex answers 429 and the project leaves Google after its first request. */
  function leavingGoogle() {
    const calls: ModelCall[] = [];
    let moved = false;
    const wire = wireStubs({ vertexStatus: 429 });
    const resolver: ProviderResolver = async () => decision(moved ? "scaleway" : "google");
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      observe: (c) => calls.push(c),
      transport: {
        vertex: {
          fetch: (async (...a: Parameters<typeof fetch>) => {
            const res = await wire.vertex(...a);
            moved = true;
            return res;
          }) as typeof fetch,
          ...STUB_VERTEX_AUTH,
        },
        compatFetch: wire.compat,
      },
    });
    return { calls, wire, kit: routedKit(registry, policy, resolver) };
  }

  test("the completer decides again before its second attempt: a project that went back to Scaleway finishes there", async () => {
    const { calls, wire, kit } = leavingGoogle();
    const out = await inProject(GOOGLE_PROJECT, () =>
      kit.completer.complete({ group: "text_fast", user: "hi" }),
    );
    expect(out.text).toBe("stub answer");
    // Not the second attempt on Vertex, and not its next deployment.
    expect(wire.seen.vertex).toHaveLength(1);
    expect(wire.seen.compat).toHaveLength(1);
    expect(calls.map((c) => [c.provider, c.routing?.provider])).toEqual([
      ["vertex", "google"],
      ["openai-compatible", "scaleway"],
    ]);
  });

  test("a completer call that stays on Google keeps retrying there", async () => {
    const wire = wireStubs({ vertexStatus: 503 });
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    });
    const kit = routedKit(registry, policy, byProject);
    const out = await inProject(GOOGLE_PROJECT, () =>
      kit.completer.complete({ group: "text_fast", user: "hi" }),
    );
    expect(out.text).toBe("stub answer");
    // Both Gemini models twice, then Scaleway as Google's own fallback.
    expect(wire.seen.vertex).toHaveLength(4);
    expect(wire.seen.compat).toHaveLength(1);
  });

  test("a stream that has begun on Google is not moved", async () => {
    let moved = false;
    const wire = wireStubs();
    const resolver: ProviderResolver = async () => decision(moved ? "scaleway" : "google");
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      transport: {
        vertex: {
          fetch: (async (...a: Parameters<typeof fetch>) => {
            const res = await wire.vertex(...a);
            moved = true;
            return res;
          }) as typeof fetch,
          ...STUB_VERTEX_AUTH,
        },
        compatFetch: wire.compat,
      },
    });
    const kit = routedKit(registry, policy, resolver);
    const s = inProject(GOOGLE_PROJECT, () =>
      streamText({ model: kit.models.model("text_fast"), prompt: "hi" }),
    );
    for await (const _ of s.textStream) void _;
    expect(wire.seen.vertex).toHaveLength(1);
    expect(wire.seen.compat).toEqual([]);
  });

  /** Transcription on one provider and analysis on the other, each with only itself enabled. */
  const split =
    (transcription: "scaleway" | "google", analysis: "scaleway" | "google"): ProviderResolver =>
    async (_who, job) => ({
      provider: job === "transcription" ? transcription : analysis,
      job,
      organisationId: "33333333-3333-4333-8333-333333333333",
      reason: "project",
      allowed: [job === "transcription" ? transcription : analysis],
    });
  const RECORDING = new Uint8Array([1, 2, 3, 4]);
  const exploreAsk = (
    kit: ReturnType<typeof routedKit>,
    opts: { audio?: boolean; mediaType?: string } = {},
  ) =>
    inProject(GOOGLE_PROJECT, () =>
      generateText({
        model: kit.models.model("multi_modal_pro"),
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what was said?" },
              ...(opts.audio === false
                ? []
                : [
                    {
                      type: "file" as const,
                      data: RECORDING,
                      mediaType: opts.mediaType ?? "audio/mp3",
                    },
                  ]),
            ],
          },
        ],
      }),
    );

  function mixed(resolver: ProviderResolver) {
    const calls: ModelCall[] = [];
    const wire = wireStubs();
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      observe: (c) => calls.push(c),
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    });
    return { calls, wire, kit: routedKit(registry, policy, resolver) };
  }

  test("a request that carries audio is a transcription: with transcription on Scaleway and analysis on Google no recording reaches Vertex", async () => {
    const { calls, wire, kit } = mixed(split("scaleway", "google"));
    expect((await exploreAsk(kit)).text).toBe("stub answer");
    expect(wire.seen.vertex).toEqual([]);
    // Scaleway's own way with a recording: Whisper hears it, then the text model answers on the words.
    expect(wire.seen.compat.map((r) => r.url.split("/").slice(-2).join("/"))).toEqual([
      "audio/transcriptions",
      "chat/completions",
    ]);
    // The call log says what it was: a transcription, on Scaleway.
    expect(calls.map((c) => [c.provider, c.routing?.provider, c.routing?.job])).toEqual([
      ["openai-compatible", "scaleway", "transcription"],
      ["openai-compatible", "scaleway", "transcription"],
    ]);
    // The same model group with text only is analysis, which this account sends to Google.
    await exploreAsk(kit, { audio: false });
    expect(wire.seen.vertex).toHaveLength(1);
    expect(calls.at(-1)?.routing).toMatchObject({ provider: "google", job: "analysis" });
  });

  test("audio goes where transcription goes: to Google when transcription is on Google and analysis on Scaleway", async () => {
    const { calls, wire, kit } = mixed(split("google", "scaleway"));
    await exploreAsk(kit);
    expect(wire.seen.compat).toEqual([]);
    expect(wire.seen.vertex).toHaveLength(1);
    expect(calls.at(-1)?.routing).toMatchObject({ provider: "google", job: "transcription" });
  });

  test("a picture or a document is not a recording and stays analysis", async () => {
    for (const mediaType of ["image/png", "application/pdf", "text/plain"]) {
      const { calls, wire, kit } = mixed(split("scaleway", "google"));
      await exploreAsk(kit, { mediaType });
      expect(wire.seen.compat).toEqual([]);
      expect(wire.seen.vertex).toHaveLength(1);
      expect(calls.at(-1)?.routing?.job).toBe("analysis");
    }
  });

  test("a stream with audio is decided as transcription too", async () => {
    const { wire, kit } = mixed(split("scaleway", "google"));
    const s = inProject(GOOGLE_PROJECT, () =>
      streamText({
        model: kit.models.model("multi_modal_pro"),
        messages: [
          {
            role: "user",
            content: [{ type: "file", data: RECORDING, mediaType: "audio/mp3" }],
          },
        ],
      }),
    );
    for await (const _ of s.textStream) void _;
    expect(wire.seen.vertex).toEqual([]);
    expect(wire.seen.compat.length).toBeGreaterThan(0);
  });

  /** A Google decision for the account that enabled the listed providers for the job. */
  const googleWith =
    (allowed: ("scaleway" | "google")[]): ProviderResolver =>
    async (_who, job) => ({ ...decision("google", "project", job), allowed });

  test("Google's fallback to Scaleway holds only while the account has Scaleway enabled for the job", async () => {
    const down = (allowed: ("scaleway" | "google")[]) => {
      const wire = wireStubs({ vertexStatus: 503 });
      const registry = createRegistry(SETTINGS, policy, profileOf, {
        ...quick,
        transport: {
          vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH },
          compatFetch: wire.compat,
        },
      });
      return { wire, kit: routedKit(registry, policy, googleWith(allowed)) };
    };
    // Google only: Gemini fails, and nothing is sent to Scaleway.
    const only = down(["google"]);
    await expect(
      inProject(GOOGLE_PROJECT, () =>
        generateText({ model: only.kit.models.model("text_fast"), prompt: "hi", maxRetries: 0 }),
      ),
    ).rejects.toBeDefined();
    expect(only.wire.seen.vertex.length).toBeGreaterThan(0);
    expect(only.wire.seen.compat).toEqual([]);
    // The completer follows the same rule.
    await expect(
      inProject(GOOGLE_PROJECT, () =>
        only.kit.completer.complete({ group: "text_fast", user: "hi" }),
      ),
    ).rejects.toBeDefined();
    expect(only.wire.seen.compat).toEqual([]);
    // Both enabled: the fallback is there, as before.
    const both = down(["scaleway", "google"]);
    const out = await inProject(GOOGLE_PROJECT, () =>
      generateText({ model: both.kit.models.model("text_fast"), prompt: "hi", maxRetries: 0 }),
    );
    expect(out.text).toBe("stub answer");
    expect(both.wire.seen.compat).toHaveLength(1);
  });

  test("a grounded request is never answered by Scaleway without its sources: it fails as grounding unavailable", async () => {
    const wire = wireStubs({ vertexStatus: 503 });
    const registry = createRegistry(SETTINGS, policy, profileOf, {
      ...quick,
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    });
    // Scaleway is enabled, so the fallback exists for ordinary calls.
    const kit = routedKit(registry, policy, googleWith(["scaleway", "google"]));
    await expect(
      inProject(GOOGLE_PROJECT, () =>
        kit.completer.complete({ group: "multi_modal_fast", user: "claim", googleSearch: true }),
      ),
    ).rejects.toThrow(/search grounding/);
    expect(wire.seen.vertex.length).toBeGreaterThan(0);
    expect(wire.seen.compat).toEqual([]);
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

describe("every environment's provider and profile pair boots", () => {
  const gapsOf = (s: LlmSettings) =>
    bootGaps(s, routingPolicyOf(s), (id) => profileForProvider(s, id));

  test("production on GCP and the staging, preview and echo-next environments: Vertex and no profile named", () => {
    const s: LlmSettings = {
      ...SETTINGS,
      provider: "vertex",
      providers: undefined,
      baseUrl: undefined,
      apiKey: undefined,
    };
    expect(gapsOf(s)).toEqual([]);
  });

  test("the EU production environment: the compatible provider with the Whisper profile", () => {
    const s: LlmSettings = {
      ...SETTINGS,
      provider: "openai-compatible",
      providers: undefined,
      transcriptionProfile: "dembrane-26-10-whisper-eu",
      vertexProject: "",
    };
    expect(gapsOf(s)).toEqual([]);
  });
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
