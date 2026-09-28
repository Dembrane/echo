import type { Embedder } from "@dembrane/llm";
import { AnalysisStoreError, type Json, type ObjectRevision } from "./contracts";
import { sha256Hex } from "./hashing";
import { sortedStrings } from "./registry";
import type { AnalysisStore } from "./store";
import { normalizeText } from "./text";
import { getObjectType } from "./types";

/**
 * Embeddings over Map's map_embedding table: one row per project, exact input hash and
 * configuration key; the input is the whitespace-collapsed text; a concurrent writer of
 * the same input gets the stored vector back. Vectors are compared only within one
 * configuration, whose key hashes the deployment identity exactly as the Python side did,
 * so vectors it stored are reused rather than recomputed.
 */

export const EMBEDDING_CONCURRENCY = 8;
export const INPUT_NORMALIZATION = "collapse-whitespace-v1";
export const PROBE_TEXT = "dembrane embedding dimension probe";

export class InvalidVector extends Error {}

export const embeddingInput = (text: string) => normalizeText(text);
export const inputHash = (text: string) => sha256Hex(embeddingInput(text));

/** A finite, nonzero vector of exactly `dims` numbers, or InvalidVector. */
export function validateVector(values: unknown, dims: number): number[] {
  if (!Array.isArray(values)) throw new InvalidVector("embedding is not a list");
  if (values.length !== dims)
    throw new InvalidVector(`embedding has ${values.length} dimensions, expected ${dims}`);
  const out = values.map((v) => {
    const n = Number(v);
    if (typeof v !== "number" && typeof v !== "string")
      throw new InvalidVector("embedding has a non-numeric value");
    if (!Number.isFinite(n)) throw new InvalidVector("embedding has a non-finite value");
    return n;
  });
  if (!out.some((x) => x !== 0)) throw new InvalidVector("embedding is the zero vector");
  return out;
}

/** Everything that decides which vector space an embedding lives in; `dims` is what the provider returned. */
export interface EmbeddingIdentity {
  readonly model: string;
  readonly endpoint: string | null;
  readonly dims: number;
  readonly inputNormalization: string;
  readonly taskType: string | null;
}

/** sha256 of json.dumps(asdict(identity), sort_keys=True, separators=(",", ":")). */
export function identityKey(i: EmbeddingIdentity): string {
  const esc = (s: string | null) =>
    s === null
      ? "null"
      : JSON.stringify(s).replace(
          /[\u0080-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
  return sha256Hex(
    `{"dims":${i.dims},"endpoint":${esc(i.endpoint)},"input_normalization":${esc(i.inputNormalization)},"model":${esc(i.model)},"task_type":${esc(i.taskType)}}`,
  );
}

export function identityConfig(i: EmbeddingIdentity): Json {
  return {
    model: i.model,
    endpoint: i.endpoint,
    dims: i.dims,
    input_normalization: i.inputNormalization,
    task_type: i.taskType,
    key: identityKey(i),
  };
}

/** One small request to learn the deployment's real dimensions. */
export async function probeIdentity(embedder: Embedder): Promise<EmbeddingIdentity> {
  const vector = await embedWithRetry(embedder, PROBE_TEXT);
  if (!vector.length) throw new Error("Embedding probe returned no vector.");
  return {
    model: embedder.model,
    endpoint: embedder.endpoint,
    dims: vector.length,
    inputNormalization: INPUT_NORMALIZATION,
    taskType: null,
  };
}

/** The Python embed_text retried every failure up to five tries with exponential backoff. */
export async function embedWithRetry(
  embedder: Embedder,
  text: string,
  tries = 5,
): Promise<number[]> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await embedder.embed(text);
    } catch (err) {
      last = err;
      if (attempt + 1 < tries) await Bun.sleep(Math.min(2 ** attempt, 30) * 1000 * Math.random());
    }
  }
  throw last;
}

export interface EmbeddingRef {
  readonly embeddingId: string;
  readonly inputHash: string;
  readonly configKey: string;
  readonly projectionVersion: string;
}

export const refJson = (r: EmbeddingRef): Json => ({
  embeddingId: r.embeddingId,
  inputHash: r.inputHash,
  configKey: r.configKey,
  projectionVersion: r.projectionVersion,
});

export interface EmbeddingBatch {
  /** input hash -> embedding row id */
  readonly ids: Map<string, string>;
  /** input hash -> vector */
  readonly vectors: Map<string, number[]>;
  reused: number;
  computed: number;
}

export class EmbeddingService {
  constructor(
    readonly store: AnalysisStore,
    readonly identity: EmbeddingIdentity,
    readonly embed: (text: string) => Promise<number[]>,
    readonly concurrency = EMBEDDING_CONCURRENCY,
  ) {}

  get key(): string {
    return identityKey(this.identity);
  }

  /** Every text's vector for this configuration: stored ones in one read, missing ones embedded and saved as each lands. */
  async ensure(projectId: string, texts: Iterable<string>): Promise<EmbeddingBatch> {
    const wanted = new Map<string, string>();
    for (const text of texts) wanted.set(inputHash(text), embeddingInput(text));
    const batch: EmbeddingBatch = { ids: new Map(), vectors: new Map(), reused: 0, computed: 0 };
    if (!wanted.size) return batch;
    const stored = await this.store.loadEmbeddings(
      projectId,
      this.key,
      sortedStrings(wanted.keys()),
    );
    for (const [hashed, [id, vector]] of stored) {
      batch.ids.set(hashed, id);
      batch.vectors.set(hashed, validateVector(vector, this.identity.dims));
    }
    batch.reused = stored.size;
    const missing = sortedStrings(wanted.keys()).filter((h) => !stored.has(h));
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const hashed = missing[next++] as string;
        const vector = validateVector(
          await this.embed(wanted.get(hashed) as string),
          this.identity.dims,
        );
        const [id, kept] = await this.store.saveEmbedding({
          projectId,
          inputHash: hashed,
          configKey: this.key,
          model: this.identity.model,
          dims: this.identity.dims,
          vector,
        });
        batch.ids.set(hashed, id);
        batch.vectors.set(hashed, validateVector(kept, this.identity.dims));
        batch.computed++;
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(this.concurrency, missing.length) }, worker),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    return batch;
  }

  /** Every referenced vector reads back from the database, or the output is not publishable. */
  async verifyDurable(projectId: string, embeddingIds: Iterable<string>): Promise<void> {
    const ids = sortedStrings(new Set(embeddingIds));
    const durable = await this.store.vectorsByIds(projectId, ids);
    if (durable.size !== ids.length)
      throw new AnalysisStoreError(
        `${ids.length - durable.size} embeddings are missing after saving`,
      );
  }

  /** Refs for each map-capable revision's projection text, by revision id. */
  async embedRevisions(
    projectId: string,
    revisions: Iterable<ObjectRevision>,
  ): Promise<Map<string, EmbeddingRef>> {
    const texts = new Map<string, [string, string]>();
    for (const revision of revisions) {
      const capability = getObjectType(revision.type).map;
      if (!capability) continue;
      texts.set(revision.id, [
        capability.embeddingText(revision.payload),
        capability.projectionVersion,
      ]);
    }
    const batch = await this.ensure(
      projectId,
      [...texts.values()].map(([t]) => t),
    );
    return new Map(
      [...texts.entries()].map(([id, [text, version]]) => [
        id,
        {
          embeddingId: batch.ids.get(inputHash(text)) as string,
          inputHash: inputHash(text),
          configKey: this.key,
          projectionVersion: version,
        },
      ]),
    );
  }
}
