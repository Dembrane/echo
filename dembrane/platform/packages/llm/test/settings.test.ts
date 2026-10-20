import { expect, test } from "bun:test";
import {
  checkProfileModels,
  compatibleModelsOf,
  improves,
  PROFILES,
  profileGaps,
  profileOf,
} from "../src/profiles";
import { modelsConfigOf } from "../src/settings";

const eu = PROFILES["dembrane-26-10-whisper-eu"];
const gcp = PROFILES["dembrane-26-10-gemini"];

test("a stack without a named profile gets its own: Gemini on Vertex, the EU profile on a compatible provider", () => {
  expect(profileOf({ provider: "vertex" }).name).toBe(gcp.name);
  expect(profileOf({ provider: "openai-compatible" }).name).toBe(eu.name);
  expect(profileOf({ provider: "vertex", transcriptionProfile: eu.name }).name).toBe(eu.name);
  expect(() => profileOf({ provider: "vertex", transcriptionProfile: "nope" })).toThrow(
    /TRANSCRIPTION_PROFILE nope is not a profile/,
  );
});

test("the EU profile improves recordings and uploads; the Gemini profile neither", () => {
  expect(improves(eu, false)).toBe(true);
  expect(improves(eu, true)).toBe(true);
  expect(eu.uploads).toBe("first-pass");
  expect(improves(gcp, false)).toBe(false);
  expect(improves(gcp, true)).toBe(false);
});

test("the boot check names the profile and what the deployment lacks", () => {
  expect(profileGaps(eu, { vertexProject: "p" })).toBe(
    "transcription profile dembrane-26-10-whisper-eu needs LLM_BASE_URL and LLM_API_KEY, which are not set",
  );
  expect(profileGaps(eu, { baseUrl: "https://x/v1", apiKey: "k" })).toBeNull();
  expect(profileGaps(gcp, { vertexProject: "" })).toBe(
    "transcription profile dembrane-26-10-gemini needs LLM_VERTEX_PROJECT, which is not set",
  );
  expect(profileGaps(gcp, { vertexProject: "p" })).toBeNull();
  expect(compatibleModelsOf(eu)).toEqual(["whisper-large-v3", "glm-5.3"]);
  expect(compatibleModelsOf(gcp)).toEqual([]);
});

test("a model the provider does not list is a warning; a network error is silent", async () => {
  const lines: string[] = [];
  const listed = (async () =>
    new Response(
      JSON.stringify({ data: [{ id: "whisper-large-v3" }] }),
    )) as unknown as typeof fetch;
  await checkProfileModels(
    eu,
    { baseUrl: "https://x/v1", apiKey: "k" },
    (l) => lines.push(l),
    listed,
  );
  expect(lines).toEqual([
    "transcription profile dembrane-26-10-whisper-eu: the provider does not list glm-5.3; those calls will fail",
  ]);
  const down = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  await checkProfileModels(
    eu,
    { baseUrl: "https://x/v1", apiKey: "k" },
    (l) => lines.push(l),
    down,
  );
  expect(lines).toHaveLength(1);
});

test("Whisper's model and language come from the profile", () => {
  const base = {
    provider: "openai-compatible" as const,
    baseUrl: "https://x/v1",
    apiKey: "k",
    searchGrounding: false,
    textFast: [],
    multiModalFast: [],
    multiModalPro: [],
    compatTextFast: ["glm-5.3"],
    compatMultiModalFast: ["glm-5.3"],
    compatMultiModalPro: ["glm-5.3"],
    vertexProject: "p",
    vertexLocation: "eu",
    embeddingModel: "e",
    compatEmbeddingModel: "q",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  };
  const c = modelsConfigOf(base).openaiCompatible;
  expect(c?.transcriptionModel).toBe("whisper-large-v3");
  expect(c?.transcriptionLanguage).toBe("auto");
});
