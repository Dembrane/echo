import { isoTimestamp } from "@echo/legacy-shape";
import type { Completer, CompletionRequest, Embedder } from "@echo/llm";
import type { Json } from "../contracts";
import { q } from "../db";
import {
  type EmbeddingIdentity,
  embedWithRetry,
  INPUT_NORMALIZATION,
  probeIdentity,
} from "../embeddings";
import type { Transcript } from "../maprecipe";
import type { RecipeServices } from "../registry";
import type { AnalysisStore } from "../store";

/**
 * The outside world the built-in producers read, injectable for tests: transcripts from
 * Postgres, the fast multimodal group through the Completer, and the configured embedding
 * deployment. A recipe finds them under PRODUCERS_KEY in the executor's services.
 */

export const PRODUCERS_KEY = "producers";

/** The model group every producer's model steps use, as the Python MODELS enum named it. */
export const MODEL_GROUP = "MULTI_MODAL_FAST";

export interface ProducerServices {
  readonly transcripts: (projectId: string) => Promise<Transcript[]>;
  readonly completer: Completer;
  readonly probe: () => Promise<EmbeddingIdentity>;
  readonly embed: (text: string) => Promise<number[]>;
  /** The embedding deployment as configured, without a network call: what a run pins first. */
  readonly embeddingSettings: () => Json;
  /** The language model deployment producers' model steps use; part of their cache keys. */
  readonly modelDeployment: () => Json;
  /** One structured completion on the producers' model group. */
  readonly complete: (
    request: Omit<CompletionRequest, "group">,
  ) => ReturnType<Completer["complete"]>;
}

export function producerServices(services: RecipeServices): ProducerServices {
  const found = services[PRODUCERS_KEY];
  if (!found) throw new Error(`services['${PRODUCERS_KEY}'] is not configured`);
  return found as ProducerServices;
}

/** Every conversation of a project with transcribed text, oldest first, as Map reads them. */
export async function loadTranscripts(
  store: AnalysisStore,
  projectId: string,
): Promise<Transcript[]> {
  const conversations = await q<{
    id: string;
    participant_name: string | null;
    created_at: string | null;
  }>(
    store.sql,
    `SELECT id::text AS id, participant_name, created_at FROM conversation
      WHERE project_id = $1 AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [projectId],
  );
  if (!conversations.length) return [];
  const chunks = await q<{ conversation_id: string; transcript: string | null }>(
    store.sql,
    `SELECT conversation_id::text AS conversation_id, transcript FROM conversation_chunk
      WHERE conversation_id = ANY($1::uuid[]) AND transcript IS NOT NULL
      ORDER BY timestamp, created_at, id`,
    [conversations.map((c) => c.id)],
  );
  const texts = new Map<string, string[]>();
  for (const chunk of chunks) {
    const text = String(chunk.transcript ?? "").trim();
    if (!text) continue;
    const list = texts.get(chunk.conversation_id) ?? [];
    list.push(text);
    texts.set(chunk.conversation_id, list);
  }
  const out: Transcript[] = [];
  conversations.forEach((c, i) => {
    const text = (texts.get(c.id) ?? []).join("\n").trim();
    if (!text) return;
    const name = String(c.participant_name ?? "").trim();
    out.push({
      id: c.id,
      label: name || `Conversation ${i + 1}`,
      // Directus served timestamps as ISO with milliseconds; the pinned sources keep that form.
      createdAt: isoTimestamp(c.created_at) || null,
      text,
    });
  });
  return out;
}

/** How many live conversations have transcribed text: what a generation would read. */
export async function countConversationsWithTranscripts(
  store: AnalysisStore,
  projectId: string,
): Promise<number> {
  const rows = await q<{ n: string }>(
    store.sql,
    `SELECT count(DISTINCT ch.conversation_id) AS n
       FROM conversation_chunk AS ch JOIN conversation AS c ON c.id = ch.conversation_id
      WHERE c.project_id = $1 AND c.deleted_at IS NULL
        AND ch.transcript IS NOT NULL AND ch.transcript <> ''`,
    [projectId],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ProducerConfig {
  readonly store: AnalysisStore;
  readonly completer: Completer;
  readonly embedder: Embedder;
  /** EMBEDDING_MODEL as the Python settings named it ("vertex_ai/text-embedding-004"). */
  readonly embeddingModel: string;
  /** The regional base URL the Python settings carried (EMBEDDING_BASE_URL). */
  readonly embeddingBaseUrl: string | null;
}

/** The platform's producers: transcripts, the fast group and the embedding deployment. */
export function defaultProducerServices(cfg: ProducerConfig): ProducerServices {
  const completer = cfg.completer;
  return {
    transcripts: (projectId) => loadTranscripts(cfg.store, projectId),
    completer,
    probe: () => probeIdentity(cfg.embedder),
    embed: (text) => embedWithRetry(cfg.embedder, text),
    embeddingSettings: () => ({
      model: cfg.embeddingModel,
      baseUrl: cfg.embeddingBaseUrl,
      apiVersion: null,
      inputNormalization: INPUT_NORMALIZATION,
    }),
    modelDeployment: () => ({
      group: MODEL_GROUP,
      model: completer.modelIdentity("multi_modal_fast"),
    }),
    complete: (request) => completer.complete({ ...request, group: "multi_modal_fast" }),
  };
}

/** The recipe's model identity; producers without services configured record none. */
export function modelDeployment(services: RecipeServices): Json {
  const found = services[PRODUCERS_KEY] as ProducerServices | undefined;
  return found ? found.modelDeployment() : {};
}
