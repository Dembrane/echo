import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { LocalMedia } from "@dembrane/audio";
import { newId, PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { portalRoutes } from "../src/portal/routes";
import { admin, fakeModels, freshDatabase, localBucket, quiet } from "./pipeline-harness";

const run = admin ? describe : describe.skip;

// A conversation records the AI provider its project resolved to as it began.
run("a conversation records its AI provider at creation", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  const bucket = localBucket();
  let providerFor: (projectId: string) => Promise<string | null> = async () => null;

  beforeAll(async () => {
    const url = await freshDatabase("conv_provider_test");
    const database = createDb({ url, poolMax: 4 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const d: ConversationsDeps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: bucket.storage,
      audioUrls: bucket.urls,
      jobs: { enqueue: async () => "run" },
      models: fakeModels().models,
      media: new LocalMedia(),
      transcriber: new FakeTranscriber(),
      hub: null,
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("t".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: false,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      providerFor: (id) => providerFor(id),
      now: () => new Date(),
    };
    app = new Hono<Env>();
    app.route("/", portalRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
  });
  afterAll(async () => {
    bucket.server.stop(true);
    await sql?.end();
    await close?.();
  });

  const start = async (projectId: string) => {
    const res = await app.request(`/api/participant/projects/${projectId}/conversations/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "P", pin: "", source: "PORTAL_TEXT" }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await sql`select ai_provider from conversation where id = ${id}`;
    return row?.ai_provider as string | null;
  };

  test("the provider the project resolves to as it begins is kept, and none where nothing is routed", async () => {
    const p = newId();
    await sql`insert into project (id, name, language, is_conversation_allowed) values (${p}, 'P', 'en', true)`;
    expect(await start(p)).toBeNull();
    providerFor = async () => "google";
    expect(await start(p)).toBe("google");
    providerFor = async () => "scaleway";
    expect(await start(p)).toBe("scaleway");
  });
});
