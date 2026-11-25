import { expect, test } from "bun:test";
import {
  type Completer,
  type Embedder,
  FakeCompleter,
  type ProviderResolver,
  routingCompleter,
  routingEmbedder,
  routingPolicyOf,
} from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { defaultProducerServices } from "../src/recipes/services";
import type { AnalysisStore } from "../src/store";

const policy = routingPolicyOf({
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
});
const GOOGLE_PROJECT = "22222222-2222-4222-8222-222222222222";

const resolver: ProviderResolver = async (who, job) => ({
  provider: who && "ref" in who && who.id === GOOGLE_PROJECT ? "google" : "scaleway",
  job,
  organisationId: "o",
  reason: "project",
  allowed: ["scaleway", "google"],
});

const embedder = (model: string, endpoint: string, baseUrl: string): Embedder => ({
  model,
  endpoint,
  baseUrl,
  dimensions: 8,
  embed: async () => [1],
});

// A run records, and keys its cache on, the models of the provider its project's calls go to.
test("a run's recorded embedding and model settings are the routed provider's", async () => {
  const completers: Record<"scaleway" | "google", Completer> = {
    scaleway: new FakeCompleter(() => "glm-5.3"),
    google: new FakeCompleter(() => "gemini-3.8-flash"),
  };
  const services = defaultProducerServices({
    store: {} as AnalysisStore,
    completer: routingCompleter(completers, policy, resolver),
    embedder: routingEmbedder(
      {
        scaleway: embedder(
          "openai_compatible/qwen3",
          "openai-compatible:https://scw/v1",
          "https://scw/v1",
        ),
        google: embedder(
          "vertex_ai/text-embedding-004",
          "vertex:p:europe-west4",
          "https://europe-west4-aiplatform.googleapis.com",
        ),
      },
      policy,
      resolver,
    ),
    embeddingModel: "openai_compatible/qwen3",
    embeddingBaseUrl: "https://scw/v1",
  });
  const inProject = <T>(id: string, fn: () => Promise<T>) => withPayer({ ref: "project", id }, fn);
  expect(
    await inProject("11111111-1111-4111-8111-111111111111", services.embeddingSettings),
  ).toMatchObject({
    model: "openai_compatible/qwen3",
    baseUrl: "https://scw/v1",
  });
  expect(await inProject(GOOGLE_PROJECT, services.embeddingSettings)).toMatchObject({
    model: "vertex_ai/text-embedding-004",
    baseUrl: "https://europe-west4-aiplatform.googleapis.com",
  });
  expect(
    await inProject("11111111-1111-4111-8111-111111111111", services.modelDeployment),
  ).toMatchObject({
    model: "glm-5.3",
  });
  expect(await inProject(GOOGLE_PROJECT, services.modelDeployment)).toMatchObject({
    model: "gemini-3.8-flash",
  });
});
