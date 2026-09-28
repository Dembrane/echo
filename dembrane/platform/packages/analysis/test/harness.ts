import { Writable } from "node:stream";
import { createDb } from "@dembrane/db";
import { FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { createLogger, type Logger } from "@dembrane/observability";
import postgres from "postgres";
import type { Json } from "../src/contracts";
import { clientOf } from "../src/db";
import type { ExecutorDeps } from "../src/executor";
import { defaultProducerServices, PRODUCERS_KEY } from "../src/recipes";
import { AnalysisStore } from "../src/store";

/**
 * Integration tests run against a private copy of the parity seed
 * (parity/prepare-platform-template.sh builds parity_template_platform): real tables, real
 * guard triggers, the seed's projects and transcripts. Skipped without a database.
 */

export const admin = process.env.TEST_DATABASE_ADMIN_URL;
export const TEMPLATE = process.env.PARITY_TEMPLATE ?? "parity_template_platform";

export async function hasTemplate(): Promise<boolean> {
  if (!admin) return false;
  try {
    const sql = postgres(admin, { max: 1, onnotice: () => {} });
    const [row] = await sql`select 1 from pg_database where datname = ${TEMPLATE}`;
    await sql.end();
    return Boolean(row);
  } catch {
    return false;
  }
}

export async function freshDatabase(name: string): Promise<string> {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name} template ${TEMPLATE}`);
  await a.end();
  return `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
}

/**
 * A client configured exactly as the app's (text timestamps, parsed JSON), so tests read
 * rows in the shapes production code sees.
 */
export function appClient(url: string): { sql: postgres.Sql; close: () => Promise<void> } {
  const database = createDb({ url, poolMax: 4 });
  return { sql: clientOf(database.db), close: database.close };
}

export async function dropDatabase(name: string): Promise<void> {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.end();
}

export const quiet: Logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

export const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const P1 = id("f0", 1);
export const C1 = id("c1", 1);
export const C2 = id("c1", 2);

/** Extraction answers keyed by a phrase of the window they answer, as recorded model output. */
export function extractionFake(answers: Record<string, Json>): FakeCompleter {
  const fake = new FakeCompleter((g) => `vertex_ai/fake-${g}`);
  for (const [needle, answer] of Object.entries(answers)) fake.on(needle, JSON.stringify(answer));
  return fake;
}

export function executorDeps(
  sql: postgres.Sql,
  o: { completer: FakeCompleter; embedder?: FakeEmbedder; events?: Json[] },
): ExecutorDeps {
  const store = new AnalysisStore(sql);
  const embedder = o.embedder ?? new FakeEmbedder(8);
  return {
    store,
    publishEvent: async (_projectId, event) => {
      o.events?.push(event);
    },
    dispatchRun: null,
    services: {
      [PRODUCERS_KEY]: defaultProducerServices({
        store,
        completer: o.completer,
        embedder,
        embeddingModel: "vertex_ai/text-embedding-004",
        embeddingBaseUrl: "https://europe-west4-aiplatform.googleapis.com",
      }),
    },
    logger: quiet,
    keepaliveMs: 60_000,
  };
}

/** The recorded answers for the seed's two p1 conversations. */
export const P1_ANSWERS: Record<string, Json> = {
  "charging points": {
    items: [
      {
        kind: "claim",
        statement: "The waiting list for charging points near the flats is months long.",
        evidence: ["the waiting list is months long"],
        valence: "negative",
      },
      {
        kind: "argument",
        statement: "Buses should run later because people drive when buses stop at eleven.",
        evidence: [
          "Buses stop running at eleven, so people drive even when they would rather not.",
        ],
        valence: "negative",
      },
      {
        kind: "argument",
        statement: "An ungrounded statement the check must drop.",
        evidence: ["words nobody said"],
        valence: "neutral",
      },
    ],
  },
  "cycle lanes": {
    items: [
      {
        kind: "argument",
        statement: "Cycle lanes should continue past the ring road.",
        evidence: ["the cycle lanes end abruptly at the ring road"],
        valence: "negative",
      },
    ],
  },
};
