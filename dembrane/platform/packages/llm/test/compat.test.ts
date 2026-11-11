import { expect, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ModelCall } from "../src";
import {
  CompatEmbeddingModel,
  CompatLanguageModel,
  compatCallOptions,
  createModels,
  type LlmSettings,
  languageHint,
  type ModelsConfig,
  modelsConfigOf,
  searchGroundingOn,
  takeObserverFaults,
  transcribeAudio,
  vertexCompleter,
} from "../src";

const ep = (fetcher: typeof fetch) => ({
  baseUrl: "https://llm.example/v1",
  apiKey: "k",
  transcriptionModel: "whisper-large-v3",
  fetch: fetcher,
});

test("a thinking budget of zero turns reasoning off and Vertex-only options are dropped", () => {
  const out = compatCallOptions(
    {
      prompt: [],
      providerOptions: { vertex: { thinkingConfig: { thinkingBudget: 0 }, threshold: "OFF" } },
      tools: [{ type: "provider", id: "google.google_search", name: "google_search", args: {} }],
    } as LanguageModelV4CallOptions,
    "medium",
  );
  expect(out.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: "none" } });
  expect(out.tools).toBeUndefined();
});

test("a positive budget keeps the configured effort and no budget uses it too", () => {
  const budget = {
    prompt: [],
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 2048 } } },
  };
  expect(compatCallOptions(budget, undefined).providerOptions).toBeUndefined();
  expect(compatCallOptions(budget, "high").providerOptions).toEqual({
    openaiCompatible: { reasoningEffort: "high" },
  });
  expect(compatCallOptions({ prompt: [] }, undefined).providerOptions).toBeUndefined();
  expect(compatCallOptions({ prompt: [] }, "medium").providerOptions).toEqual({
    openaiCompatible: { reasoningEffort: "medium" },
  });
});

test("the answer length is capped at the provider ceiling, and only when one is set", () => {
  const ask = (n?: number) => ({ prompt: [], ...(n !== undefined && { maxOutputTokens: n }) });
  expect(compatCallOptions(ask(32_000), undefined, 16_384).maxOutputTokens).toBe(16_384);
  expect(compatCallOptions(ask(2_000), undefined, 16_384).maxOutputTokens).toBe(2_000);
  expect(compatCallOptions(ask(), undefined, 16_384).maxOutputTokens).toBe(16_384);
  expect(compatCallOptions(ask(32_000), undefined).maxOutputTokens).toBe(32_000);
  expect(compatCallOptions(ask(), undefined).maxOutputTokens).toBeUndefined();
});

test("language hints are reduced to two letters", () => {
  expect(languageHint("nl-NL")).toBe("nl");
  expect(languageHint("EN")).toBe("en");
  expect(languageHint(undefined)).toBeUndefined();
});

test("transcription posts multipart audio with model and language", async () => {
  let form: FormData | undefined;
  let url = "";
  const text = await transcribeAudio(
    ep((async (u: string, init: RequestInit) => {
      url = u;
      form = init.body as FormData;
      return Response.json({ text: " hallo wereld " });
    }) as unknown as typeof fetch),
    new Uint8Array([0x49, 0x44, 0x33, 0, 0]),
    "nl",
  );
  expect(text).toBe("hallo wereld");
  expect(url).toBe("https://llm.example/v1/audio/transcriptions");
  expect(form?.get("model")).toBe("whisper-large-v3");
  expect(form?.get("language")).toBe("nl");
  expect(((form as FormData).get("file") as File).name).toBe("audio.mp3");
});

test("the model hears text where the prompt had audio", async () => {
  let seen: LanguageModelV4CallOptions | undefined;
  const inner = {
    specificationVersion: "v4",
    provider: "p",
    modelId: "m",
    supportedUrls: {},
    doGenerate: async (o: LanguageModelV4CallOptions) => {
      seen = o;
      return {};
    },
  } as unknown as LanguageModelV4;
  const model = new CompatLanguageModel(
    inner,
    ep((async () => Response.json({ text: "hello" })) as unknown as typeof fetch),
  );
  await model.doGenerate({
    prompt: [
      {
        role: "user",
        content: [
          { type: "text", text: "context" },
          {
            type: "file",
            data: { type: "data", data: new Uint8Array([1, 2, 3]) },
            mediaType: "audio/mp3",
          },
        ],
      },
    ],
    providerOptions: {
      echo: { language: "nl-NL" },
      vertex: { thinkingConfig: { thinkingBudget: 0 } },
    },
  });
  const content = (
    (seen as LanguageModelV4CallOptions).prompt[0] as { content: { type: string; text?: string }[] }
  ).content;
  expect(content.map((p) => p.type)).toEqual(["text", "text"]);
  expect(content[1]?.text).toContain("hello");
  expect(seen?.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: "none" } });
});

test("embeddings ask for the configured dimensions, and a longer vector is cut to unit length", async () => {
  const asked: unknown[] = [];
  const inner = {
    specificationVersion: "v4",
    provider: "p",
    modelId: "e",
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: true,
    doEmbed: async (o: { providerOptions?: { openaiCompatible?: { dimensions?: number } } }) => {
      asked.push(o.providerOptions?.openaiCompatible?.dimensions);
      return { embeddings: [[3, 4, 12, 9]] };
    },
  };
  const out = await new CompatEmbeddingModel(inner as never, 2).doEmbed({ values: ["x"] });
  expect(out.embeddings).toEqual([[0.6, 0.8]]);
  await expect(
    new CompatEmbeddingModel(inner as never, 8).doEmbed({ values: ["x"] }),
  ).rejects.toThrow();
  expect(asked).toEqual([2, 8]);
});

const settings = (over: Partial<LlmSettings> = {}): LlmSettings => ({
  provider: "vertex",
  searchGrounding: true,
  textFast: ["g1"],
  multiModalFast: ["g2"],
  multiModalPro: ["g3"],
  compatTextFast: ["glm-5.3"],
  compatMultiModalFast: ["glm-5.3"],
  compatMultiModalPro: ["glm-5.3"],
  vertexProject: "proj",
  vertexLocation: "eu",
  embeddingModel: "text-embedding-004",
  compatEmbeddingModel: "qwen3-embedding-8b",
  embeddingLocation: "europe-west4",
  embeddingDimensions: 768,
  ...over,
});

test("provider selection: vertex keeps today's groups, openai-compatible uses its own", () => {
  const v = modelsConfigOf(settings());
  expect(v.provider).toBe("vertex");
  expect(v.groups.multi_modal_pro).toEqual(["g3"]);
  expect(v.embeddingModel).toBe("text-embedding-004");
  const c = modelsConfigOf(
    settings({ provider: "openai-compatible", baseUrl: "https://x/v1", apiKey: "k" }),
  );
  expect(c.groups.text_fast).toEqual(["glm-5.3"]);
  expect(c.embeddingModel).toBe("qwen3-embedding-8b");
  expect(c.openaiCompatible?.baseUrl).toBe("https://x/v1");
});

test("search grounding is off whenever the provider is not vertex", async () => {
  expect(searchGroundingOn(settings())).toBe(true);
  expect(searchGroundingOn(settings({ searchGrounding: false }))).toBe(false);
  expect(searchGroundingOn(settings({ provider: "openai-compatible" }))).toBe(false);
  const models = createModels(
    modelsConfigOf(
      settings({ provider: "openai-compatible", baseUrl: "https://x/v1", apiKey: "k" }),
    ),
  );
  const completer = vertexCompleter(models, {
    groups: modelsConfigOf(settings()).groups,
    searchGrounding: false,
  });
  await expect(
    completer.complete({ group: "multi_modal_fast", user: "claim", googleSearch: true }),
  ).rejects.toThrow("search grounding");
});

test("openai-compatible without a base URL or key refuses to start", () => {
  const cfg: ModelsConfig = modelsConfigOf(settings({ provider: "openai-compatible" }));
  expect(() => createModels(cfg)).toThrow("LLM_BASE_URL");
});

test("a 429 is waited out as Retry-After says, for every caller of the endpoint, then goes again", async () => {
  const { SpeechGate } = await import("../src/speech-gate");
  let calls = 0;
  const answers = [
    new Response('{"error":"INSUFFICIENT QUOTA"}', {
      status: 429,
      headers: { "retry-after": "0.05" },
    }),
    new Response(JSON.stringify({ text: " hello ", segments: [] })),
  ];
  const fetcher = (async () => answers[calls++] as Response) as unknown as typeof fetch;
  const start = Date.now();
  const text = await transcribeAudio(
    { ...ep(fetcher), speechGate: new SpeechGate({ secondsPerMinute: 600 }) },
    new Uint8Array(100),
  );
  expect(text).toBe("hello");
  expect(calls).toBe(2);
  expect(Date.now() - start).toBeGreaterThanOrEqual(45);
});

test("every speech-to-text request is reported once with what it carried and how it ended", async () => {
  const seen: Record<string, unknown>[] = [];
  const fetcher = (async () =>
    new Response(JSON.stringify({ text: "hi" }))) as unknown as typeof fetch;
  await transcribeAudio(
    { ...ep(fetcher), onSpeechRequest: (e) => seen.push(e as unknown as Record<string, unknown>) },
    new Uint8Array(80_000),
    undefined,
    undefined,
    undefined,
    { priority: "upload", seconds: 600 },
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    provider: "openai-compatible",
    model: "whisper-large-v3",
    audioSeconds: 600,
    estimated: false,
    bytes: 80_000,
    status: 200,
    attempt: 1,
    path: "upload",
  });
  expect(typeof seen[0]?.ms).toBe("number");
});

test("createModels names the openai-compatible provider on every metered call", async () => {
  const { generateText, embed } = await import("ai");
  const fetcher = (async (url: string | URL) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/embeddings")
          ? { data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3 } }
          : {
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 4 },
                completion_tokens_details: { reasoning_tokens: 2 },
              },
            },
      ),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  const calls: { provider: string; kind: string }[] = [];
  const models = createModels(
    {
      ...modelsConfigOf(
        settings({ provider: "openai-compatible", baseUrl: "https://x/v1", apiKey: "k" }),
      ),
      openaiCompatible: { ...ep(fetcher), baseUrl: "https://x/v1" },
      embeddingDimensions: 1,
    },
    { observe: (c) => calls.push(c) },
  );
  await generateText({ model: models.model("text_fast"), prompt: "hi" });
  await embed({ model: models.embedding().model, value: "hi" });
  expect(calls).toMatchObject([
    {
      provider: "openai-compatible",
      kind: "generate",
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    },
    { provider: "openai-compatible", kind: "embed", inputTokens: 3 },
  ]);
});

const chatAnswer = {
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const compatModels = (baseUrl: string, fetcher: typeof fetch, calls: ModelCall[]) =>
  createModels(
    {
      ...modelsConfigOf(settings({ provider: "openai-compatible", baseUrl, apiKey: "k" })),
      openaiCompatible: { ...ep(fetcher), baseUrl },
    },
    { observe: (c) => calls.push(c) },
  );

test("a speech-to-text call is metered once, in audio seconds, and a rate-limited attempt is not", async () => {
  const answers = [
    new Response("{}", { status: 429, headers: { "retry-after": "0.01" } }),
    Response.json({ text: "hallo", duration: 12.5, segments: [] }),
  ];
  let n = 0;
  const calls: ModelCall[] = [];
  const models = compatModels(
    "https://speech-metered.example/v1",
    (async () => answers[n++] as Response) as unknown as typeof fetch,
    calls,
  );
  await models.speechToText?.transcribeSegments(new Uint8Array(100));
  expect(n).toBe(2);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    group: "speech",
    provider: "openai-compatible",
    model: "whisper-large-v3",
    kind: "speech",
    audioSeconds: 12.5,
    usageEstimated: false,
    inputTokens: null,
    outputTokens: null,
    status: "ok",
    error: null,
    attempt: 2,
    fallback: false,
  });
});

test("a chat call with audio on the compatible provider meters the speech call and the chat call", async () => {
  const calls: ModelCall[] = [];
  const models = compatModels(
    "https://speech-chat.example/v1",
    (async (url: string | URL) =>
      String(url).endsWith("/audio/transcriptions")
        ? Response.json({ text: "hello", duration: 3 })
        : Response.json(chatAnswer)) as unknown as typeof fetch,
    calls,
  );
  await models.model("multi_modal_fast").doGenerate({
    prompt: [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "data", data: new Uint8Array(8_000) },
            mediaType: "audio/mp3",
          },
        ],
      },
    ],
  });
  expect(calls.map((c) => c.kind)).toEqual(["speech", "generate"]);
  expect(calls[0]).toMatchObject({ group: "speech", audioSeconds: 3, usageEstimated: false });
});

test("a speech answer without a duration is billed on the request's own estimate", async () => {
  const calls: ModelCall[] = [];
  const models = compatModels(
    "https://speech-no-duration.example/v1",
    (async () => Response.json({ text: "hi" })) as unknown as typeof fetch,
    calls,
  );
  await models.speechToText?.transcribe(new Uint8Array(80_000));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ kind: "speech", audioSeconds: 10, usageEstimated: true });
});

test("a speech call is answered even when metering throws", async () => {
  const models = createModels(
    {
      ...modelsConfigOf(
        settings({
          provider: "openai-compatible",
          baseUrl: "https://speech-fault.example/v1",
          apiKey: "k",
        }),
      ),
      openaiCompatible: {
        ...ep((async () => Response.json({ text: "hi" })) as unknown as typeof fetch),
        baseUrl: "https://speech-fault.example/v1",
      },
    },
    {
      observe: () => {
        throw new Error("sink down");
      },
    },
  );
  expect(await models.speechToText?.transcribe(new Uint8Array(100))).toBe("hi");
  expect(takeObserverFaults().map(String)).toEqual(["Error: sink down"]);
});
