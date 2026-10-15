import { expect, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
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

test("a small budget is low effort and no budget uses the configured default", () => {
  const low = compatCallOptions(
    { prompt: [], providerOptions: { google: { thinkingConfig: { thinkingBudget: 2048 } } } },
    undefined,
  );
  expect(low.providerOptions).toEqual({ openaiCompatible: { reasoningEffort: "low" } });
  expect(compatCallOptions({ prompt: [] }, undefined).providerOptions).toBeUndefined();
  expect(compatCallOptions({ prompt: [] }, "medium").providerOptions).toEqual({
    openaiCompatible: { reasoningEffort: "medium" },
  });
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

test("embeddings ask for the configured dimensions", async () => {
  let opts: unknown;
  const inner = {
    specificationVersion: "v4",
    provider: "p",
    modelId: "e",
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: true,
    doEmbed: async (o: unknown) => {
      opts = o;
      return { embeddings: [[0]] };
    },
  };
  await new CompatEmbeddingModel(inner as never, 768).doEmbed({ values: ["x"] });
  expect(opts).toMatchObject({ providerOptions: { openaiCompatible: { dimensions: 768 } } });
});

const settings = (over: Partial<LlmSettings> = {}): LlmSettings => ({
  provider: "vertex",
  transcriptionModel: "whisper-large-v3",
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
