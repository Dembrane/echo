import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { freeLimits } from "@dembrane/allowance";
import { LocalMedia } from "@dembrane/audio";
import { errorBody, newId, PlatformError } from "@dembrane/core";
import { countingDb, type Statement } from "@dembrane/db/testing";
import type { Env } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import type postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { audioOpen, liveChunkCheck, liveStopNow } from "../src/free-audio";
import { ParticipantTokens } from "../src/participant-token";
import { portalRoutes } from "../src/portal/routes";
import { admin, fakeModels, freshDatabase, localBucket, quiet, tone } from "./pipeline-harness";

// How often one portal audio request resolves the paying account.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("AI budget checks on the recording path: account resolves per request", () => {
  setDefaultTimeout(60_000);
  let log: Statement[] = [];
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let bucket: ReturnType<typeof localBucket>;
  let app: Hono<Env>;
  let d: ConversationsDeps;

  beforeAll(async () => {
    const url = await freshDatabase("conv_budget_queries_test");
    bucket = localBucket();
    const made = countingDb(url, 4);
    log = made.log;
    sql = made.client;
    close = made.close;
    d = {
      db: made.db,
      access: new Access(new DrizzleAccessStore(made.db)),
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
      now: () => new Date(),
    };
    app = new Hono<Env>();
    app.route("/", portalRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json(errorBody(err), err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
    // Steady state: the limits cache is warm.
    await freeLimits(made.db);
  });
  afterAll(async () => {
    bucket?.server.stop(true);
    await close?.();
  });

  async function freeProject(sample = false) {
    const [org, acc, ws, p] = [newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'O')`;
    await sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, is_sample, created_at)
      values (${p}, 'P', 'en', ${ws}, true, ${sample}, now())`;
    return { p, acc };
  }

  async function conversation(p: string, source: string) {
    const cid = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${cid}, ${p}, 'P', ${source}, now(), now())`;
    return cid;
  }

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function stored(cid: string, ext: string) {
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-rec.${ext}`;
    const codec = ext === "webm" ? ["-c:a", "libopus"] : ["-c:a", "pcm_s16le"];
    await bucket.storage.put(key, await tone(join(bucket.root, `${chunkId}.${ext}`), 2, codec));
    return { chunkId, key };
  }

  const confirmBody = (chunkId: string, key: string, source: string) => ({
    chunk_id: chunkId,
    file_url: bucket.urls.fileUrl(key),
    timestamp: new Date().toISOString(),
    source,
  });

  // How often the request resolves the paying account.
  async function counted(f: () => Response | Promise<Response>, status = 200) {
    log.length = 0;
    const res = await f();
    expect(res.status).toBe(status);
    return log.filter((l) => l.q.includes("as own_id")).length;
  }

  const seen: Record<string, number> = {};
  test("initiate, get-upload-url, live confirm, repeated confirm and upload", async () => {
    const { p } = await freeProject();
    seen.initiate = await counted(() =>
      post(`/api/participant/projects/${p}/conversations/initiate`, {
        name: "N",
        pin: "",
        source: "PORTAL_AUDIO",
      }),
    );
    const cid = await conversation(p, "PORTAL_AUDIO");
    const first = await stored(cid, "webm");
    expect(
      (
        await post(
          `/api/participant/conversations/${cid}/confirm-upload`,
          confirmBody(first.chunkId, first.key, "PORTAL_AUDIO"),
        )
      ).status,
    ).toBe(200);
    seen.uploadUrl = await counted(() =>
      post(`/api/participant/conversations/${cid}/get-upload-url`, {
        filename: "rec.webm",
        content_type: "audio/webm",
        conversation_id: cid,
      }),
    );
    const live = await stored(cid, "webm");
    seen.confirm = await counted(() =>
      post(
        `/api/participant/conversations/${cid}/confirm-upload`,
        confirmBody(live.chunkId, live.key, "PORTAL_AUDIO"),
      ),
    );
    seen.confirmAgain = await counted(() =>
      post(
        `/api/participant/conversations/${cid}/confirm-upload`,
        confirmBody(live.chunkId, live.key, "PORTAL_AUDIO"),
      ),
    );
    const up = await conversation(p, "PORTAL_UPLOAD");
    const file = await stored(up, "wav");
    seen.upload = await counted(() =>
      post(
        `/api/participant/conversations/${up}/confirm-upload`,
        confirmBody(file.chunkId, file.key, "PORTAL_UPLOAD"),
      ),
    );
    // The budget check reuses the audio checks' account: one resolve each (two before).
    expect(seen).toEqual({ initiate: 1, uploadUrl: 1, confirm: 1, confirmAgain: 1, upload: 1 });
  });

  test("usage is read once per check; a live confirm with nothing to stamp sends no stamp", async () => {
    const { p } = await freeProject();
    const sent = async (f: () => Response | Promise<Response>) => {
      log.length = 0;
      expect((await f()).status).toBe(200);
      const n = (s: string) => log.filter((l) => l.q.includes(s)).length;
      return {
        usage: n('from "free_usage"'),
        stamp: log.filter((l) => l.q.startsWith('select "ai_stopped_at" from')).length,
        savepoint: n("savepoint"),
      };
    };
    const seen: Record<string, unknown> = {};
    seen.initiate = await sent(() =>
      post(`/api/participant/projects/${p}/conversations/initiate`, {
        name: "N",
        pin: "",
        source: "PORTAL_AUDIO",
      }),
    );
    const cid = await conversation(p, "PORTAL_AUDIO");
    const first = await stored(cid, "webm");
    await post(
      `/api/participant/conversations/${cid}/confirm-upload`,
      confirmBody(first.chunkId, first.key, "PORTAL_AUDIO"),
    );
    seen.uploadUrl = await sent(() =>
      post(`/api/participant/conversations/${cid}/get-upload-url`, {
        filename: "rec.webm",
        content_type: "audio/webm",
        conversation_id: cid,
      }),
    );
    const live = await stored(cid, "webm");
    seen.confirm = await sent(() =>
      post(
        `/api/participant/conversations/${cid}/confirm-upload`,
        confirmBody(live.chunkId, live.key, "PORTAL_AUDIO"),
      ),
    );
    // Confirm reads usage for the AI check before the lock and for the audio limits inside it;
    // its savepoints are the limits read and the ledger add, no stamp.
    expect(seen).toEqual({
      initiate: { usage: 1, stamp: 0, savepoint: 0 },
      uploadUrl: { usage: 1, stamp: 0, savepoint: 0 },
      confirm: { usage: 2, stamp: 0, savepoint: 2 },
    });
  });

  test("a live confirm still stamps the first AI stop and clears it once there is room", async () => {
    const { p, acc } = await freeProject();
    const cid = await conversation(p, "PORTAL_AUDIO");
    const at = async () =>
      (await sql`select ai_stopped_at from conversation where id = ${cid}`)[0]?.ai_stopped_at;
    const confirm = async () => {
      const c = await stored(cid, "webm");
      const res = await post(
        `/api/participant/conversations/${cid}/confirm-upload`,
        confirmBody(c.chunkId, c.key, "PORTAL_AUDIO"),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { recording_stop?: unknown }).recording_stop ?? null;
    };
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${acc}, date_trunc('month', now() at time zone 'UTC') at time zone 'UTC',
        'ai_spend_micro_eur', 5000000)`;
    expect(await confirm()).toBe("ai_budget");
    const stamped = await at();
    expect(stamped).not.toBeNull();
    // Already stamped: kept, still a stop within the grace.
    expect(await confirm()).toBe("ai_budget");
    expect(await at()).toEqual(stamped);
    await sql`delete from free_usage where billing_account_id = ${acc}`;
    expect(await confirm()).toBeNull();
    expect(await at()).toBeNull();
  });

  test("at zero, the budget check refuses, except in a sample project", async () => {
    const open = async (sample: boolean) => {
      const { p, acc } = await freeProject(sample);
      await sql`insert into free_usage (billing_account_id, period_start, key, amount)
        values (${acc}, date_trunc('month', now() at time zone 'UTC') at time zone 'UTC',
          'ai_spend_micro_eur', 5000000)`;
      const cid = await conversation(p, "PORTAL_AUDIO");
      await sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, created_at, updated_at)
        values (${newId()}, ${cid}, 's3://x/a.webm', 'PORTAL_AUDIO', now(), now(), now())`;
      const conv = { id: cid, project_id: p };
      return {
        open: (await audioOpen(d, p)).aiAvailable,
        stop: await liveStopNow(d, conv),
        check: await liveChunkCheck(d, { ...conv, ai_stopped_at: null }),
      };
    };
    expect(await open(false)).toEqual({ open: false, stop: "ai_budget", check: "ai_budget" });
    expect(await open(true)).toEqual({ open: true, stop: null, check: null });
  });
});
