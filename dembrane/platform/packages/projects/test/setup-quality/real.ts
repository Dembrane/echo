import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Completer, createModels, vertexCompleter } from "@dembrane/llm";

/** The real model for the quality checks (setup suggestions, the digest): Vertex text_fast. */

export function hasCredentials(): boolean {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (file) return existsSync(file);
  return existsSync(path.join(homedir(), ".config/gcloud/application_default_credentials.json"));
}

/** text_fast on Vertex, named as the platform config names it (LLM_* variables). */
export function realCompleter(): Completer {
  const env = process.env;
  const fast = (env.LLM_TEXT_FAST ?? "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const groups = { text_fast: fast, multi_modal_fast: fast, multi_modal_pro: fast };
  const models = createModels({
    vertexProject: env.LLM_VERTEX_PROJECT ?? "dembrane-web-previews",
    vertexLocation: env.LLM_VERTEX_LOCATION ?? "eu",
    groups,
    embeddingModel: "text-embedding-005",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  });
  return vertexCompleter(models, { groups });
}
