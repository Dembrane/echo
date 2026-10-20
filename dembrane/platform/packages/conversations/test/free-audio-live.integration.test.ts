import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import {
  add,
  allowanceForProject,
  invalidateFreeLimits,
  setFreeLimit,
  usedThisPeriod,
} from "@dembrane/allowance";
import { LocalMedia, type Media } from "@dembrane/audio";
import { errorBody, newId, PlatformError } from "@dembrane/core";
import { createDb, type Db } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import { createChunk } from "../src/chunks";
import type { ConversationsDeps } from "../src/deps";
import { FREE_LIMIT_SKIPPED } from "../src/free-audio";
import { ParticipantTokens } from "../src/participant-token";
import { type PipelineDeps, prepareChunk, transcribePiece } from "../src/pipeline/steps";
import { portalRoutes } from "../src/portal/routes";
import {
  admin,
  fakeModels,
  freshDatabase,
  type Harness,
  quiet,
  startWorker,
  tone,
  until,
} from "./pipeline-harness";

const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

// Counts every call made to the media service.
function counting(inner: Media): { media: Media; calls: string[] } {
  const calls: string[] = [];
  const media = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return v.apply(target, args);
      };
    },
  });
  return { media, calls };
}

run("free audio: live recording", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  let clock: Date | null = null;

  beforeAll(async () => {
    const url = await freshDatabase("conv_free_audio_live_test");
    h = await startWorker(url);
    const database = createDb({ url, poolMax: 4 });
    close = () => database.close();
    d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: h.bucket.storage,
      audioUrls: h.bucket.urls,
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
      now: () => clock ?? new Date(),
    };
    app = new Hono<Env>();
    app.route("/", portalRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json(errorBody(err), err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
    await setFreeLimit(d.db, "audio_seconds_conversation", 60, null);
    await setFreeLimit(d.db, "audio_seconds_month", 120, null);
  });
  afterAll(async () => {
    await h?.stop();
    await close?.();
  });
  beforeEach(() => {
    invalidateFreeLimits();
    clock = null;
  });

  async function workspace(org: string, acc: string) {
    const ws = newId();
    await h.sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    const p = newId();
    await h.sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at)
      values (${p}, 'P', 'en', ${ws}, true, now())`;
    const cid = newId();
    await h.sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${cid}, ${p}, 'P', 'PORTAL_AUDIO', now(), now())`;
    return { ws, p, cid };
  }

  async function account(tier: string) {
    const org = newId();
    const acc = newId();
    await h.sql`insert into org (id, name) values (${org}, 'O')`;
    await h.sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, ${tier})`;
    return { org, acc, ...(await workspace(org, acc)) };
  }

  async function used(p: string, at = new Date()): Promise<number | null> {
    const a = await allowanceForProject(d.db, p, at);
    if (!a) return null;
    return (await usedThisPeriod(d.db, a)).audio_seconds;
  }

  async function fill(p: string, seconds: number, at = new Date()) {
    const a = await allowanceForProject(d.db, p, at);
    if (!a) throw new Error("expected a free account");
    await add(d.db, a, "audio_seconds", seconds);
  }

  // A chunk that already counted this many seconds.
  const seeded = (cid: string, seconds: number) =>
    h.sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, audio_seconds, created_at, updated_at)
      values (${newId()}, ${cid}, 's3://x/a.mp3', 'PORTAL_AUDIO', now(), ${seconds}, now(), now())`;

  const freeRows = async (acc: string) =>
    (await h.sql`select count(*)::int as n from free_usage where billing_account_id = ${acc}`)[0]
      ?.n;

  async function liveFile(cid: string, seconds: number, ext = "webm") {
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-rec.${ext}`;
    const codec = ext === "mp3" ? ["-c:a", "libmp3lame"] : ["-c:a", "libopus"];
    await h.bucket.storage.put(
      key,
      await tone(join(h.bucket.root, `${chunkId}.${ext}`), seconds, codec),
    );
    return { chunkId, key };
  }

  // A chunk row on a stored file, without starting the pipeline.
  async function row(cid: string, seconds: number, ext = "webm", createdAt = new Date()) {
    const { chunkId, key } = await liveFile(cid, seconds, ext);
    await h.sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, created_at, updated_at)
      values (${chunkId}, ${cid}, ${h.bucket.urls.fileUrl(key)}, 'PORTAL_AUDIO', ${createdAt}, ${createdAt}, now())`;
    return chunkId;
  }

  const chunkRow = async (id: string) =>
    (await h.sql`select * from conversation_chunk where id = ${id}`)[0] as Record<string, unknown>;

  describe("pipeline", () => {
    test("a live chunk is counted once", async () => {
      const { p, cid } = await account("free");
      const { chunkId, key } = await liveFile(cid, 10);
      await createChunk(
        { ...h.deps, jobs: h.queue },
        {
          conversationId: cid,
          timestamp: new Date(),
          source: "PORTAL_AUDIO",
          fileUrl: h.deps.audioUrls.fileUrl(key),
        },
        { chunkId },
      );
      const done = await until(async () => {
        const c = await chunkRow(chunkId);
        return c?.transcript ? c : null;
      });
      expect(Math.abs(Number(done.audio_seconds) - 10)).toBeLessThan(0.5);
      expect(await used(p)).toBe(10);
      expect(await prepareChunk(h.deps, chunkId)).toEqual([chunkId]);
      expect(await used(p)).toBe(10);
    });

    test("paid live chunks are untouched", async () => {
      const { acc, cid } = await account("changemaker");
      const { media, calls } = counting(new LocalMedia());
      const deps: PipelineDeps = { ...h.deps, media };
      const webm = await row(cid, 5);
      expect(await prepareChunk(deps, webm)).toEqual([webm]);
      const mp3 = await row(cid, 5, "mp3");
      calls.length = 0;
      expect(await prepareChunk(deps, mp3)).toEqual([mp3]);
      expect(calls).not.toContain("probe");
      expect((await chunkRow(webm)).audio_seconds).toBeNull();
      expect((await chunkRow(mp3)).audio_seconds).toBeNull();
      expect(await freeRows(acc)).toBe(0);
    });

    test("month boundary mid-recording", async () => {
      const { acc, cid } = await account("free");
      const id = await row(cid, 5, "webm", new Date("2026-10-31T23:59:50Z"));
      const deps: PipelineDeps = { ...h.deps, now: () => new Date("2026-11-01T00:00:20Z") };
      expect(await prepareChunk(deps, id)).toEqual([id]);
      const rows =
        await h.sql`select to_char(period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ps, amount
        from free_usage where billing_account_id = ${acc} and key = 'audio_seconds'`;
      expect(rows.map((r) => r.ps)).toEqual(["2026-10-01T00:00:00Z"]);
      expect(Number(rows[0]?.amount)).toBe(5);
    });

    test("a failing ledger write never fails the chunk", async () => {
      const { p, cid } = await account("free");
      const id = await row(cid, 5);
      const db = new Proxy(h.deps.db, {
        get(target, prop) {
          if (prop === "transaction") return () => Promise.reject(new Error("ledger down"));
          return Reflect.get(target, prop);
        },
      }) as Db;
      const deps: PipelineDeps = { ...h.deps, db };
      expect(await prepareChunk(deps, id)).toEqual([id]);
      const out = await transcribePiece(deps, id, { usePiiRedaction: false, anonymize: false });
      expect(out.ok).toBe(true);
      expect(String((await chunkRow(id)).transcript)).toStartWith("transcript of ");
      expect(await used(p)).toBe(0);
    });

    test("a live mp3 whose Xing header understates it is charged its real length", async () => {
      const { p, cid } = await account("free");
      const chunkId = newId();
      const key = `conversation/${cid}/chunks/${chunkId}-rec.mp3`;
      const path = join(h.bucket.root, `${chunkId}.mp3`);
      await tone(path, 40, ["-c:a", "libmp3lame", "-q:a", "4"]);
      // Same fixture as audio's measure test: the Xing frame count is a quarter of the real one.
      const mp3 = readFileSync(path);
      const x = mp3.indexOf("Xing");
      mp3.writeUInt32BE(Math.floor(mp3.readUInt32BE(x + 8) / 4), x + 8);
      await h.bucket.storage.put(key, new Blob([mp3]));
      await h.sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, created_at, updated_at)
        values (${chunkId}, ${cid}, ${h.bucket.urls.fileUrl(key)}, 'PORTAL_AUDIO', now(), now(), now())`;
      expect(await prepareChunk(h.deps, chunkId)).toEqual([chunkId]);
      expect(Math.abs(Number((await chunkRow(chunkId)).audio_seconds) - 40)).toBeLessThan(1);
      expect(await used(p)).toBe(40);
    });

    test("a long file sent as a live chunk is treated as an upload", async () => {
      const { p, cid } = await account("free");
      await fill(p, 20);
      const id = await row(cid, 150);
      expect(await prepareChunk(h.deps, id)).toEqual([]);
      const c = await chunkRow(id);
      expect(c.error).toBe(FREE_LIMIT_SKIPPED);
      expect(c.transcript).toBeNull();
      expect(c.audio_seconds).toBeNull();
      expect(await used(p)).toBe(20);
    });
  });

  describe("confirm", () => {
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    async function confirm(cid: string) {
      const { chunkId, key } = await liveFile(cid, 2);
      const res = await post(`/api/participant/conversations/${cid}/confirm-upload`, {
        chunk_id: chunkId,
        file_url: h.bucket.urls.fileUrl(key),
        timestamp: new Date().toISOString(),
        source: "PORTAL_AUDIO",
      });
      return { res, key, chunkId };
    }

    const uploadUrl = (cid: string) =>
      post(`/api/participant/conversations/${cid}/get-upload-url`, {
        filename: "rec.webm",
        content_type: "audio/webm",
        conversation_id: cid,
      });

    const body = async (res: Response) => (await res.json()) as Record<string, unknown>;
    const limitOf = async (res: Response) =>
      ((await res.json()) as { detail: { limit?: string } }).detail.limit;

    test("under the limits nothing is said", async () => {
      const { cid } = await account("free");
      await seeded(cid, 30);
      const { res } = await confirm(cid);
      expect(res.status).toBe(200);
      expect(await body(res)).not.toHaveProperty("recording_stop");
    });

    test("at the conversation limit the portal is told to stop", async () => {
      const { cid } = await account("free");
      await seeded(cid, 60);
      const { res } = await confirm(cid);
      expect(res.status).toBe(200);
      expect((await body(res)).recording_stop).toBe("audio_conversation");
    });

    test("past the conversation grace the chunk is refused", async () => {
      const { cid } = await account("free");
      await seeded(cid, 180);
      const { res, key, chunkId } = await confirm(cid);
      expect(res.status).toBe(402);
      expect(await limitOf(res)).toBe("audio_conversation");
      expect(await h.bucket.storage.size(key)).toBeNull();
      expect(await h.sql`select id from conversation_chunk where id = ${chunkId}`).toHaveLength(0);
    });

    test("at the month limit every live portal on the account is told", async () => {
      const { org, acc, p, cid } = await account("free");
      // A client workspace with its own free account, pooled into the organisation's.
      const client = newId();
      await h.sql`insert into billing_account (id, org_id, tier) values (${client}, null, 'free')`;
      const other = await workspace(org, client);
      await fill(p, 120);
      expect((await allowanceForProject(d.db, other.p, new Date()))?.accountId).toBe(acc);
      for (const c of [cid, other.cid]) {
        const { res } = await confirm(c);
        expect(res.status).toBe(200);
        expect((await body(res)).recording_stop).toBe("audio_month");
      }
    });

    test("past the month grace the chunk is refused, also from get-upload-url", async () => {
      const { p, cid } = await account("free");
      await fill(p, 240);
      const { res, key } = await confirm(cid);
      expect(res.status).toBe(402);
      expect(await limitOf(res)).toBe("audio_month");
      expect(await h.bucket.storage.size(key)).toBeNull();
      const url = await uploadUrl(cid);
      expect(url.status).toBe(402);
      expect(await limitOf(url)).toBe("audio_month");
    });

    test("a text conversation that records past the grace is refused at get-upload-url", async () => {
      const { p, cid } = await account("free");
      await h.sql`update conversation set source = 'PORTAL_TEXT' where id = ${cid}`;
      await seeded(cid, 30);
      await fill(p, 240);
      const res = await uploadUrl(cid);
      expect(res.status).toBe(402);
      expect(await limitOf(res)).toBe("audio_month");
    });

    test("a live conversation's first audio needs the recording project", async () => {
      const { org, acc, cid } = await account("free");
      const first = await uploadUrl(cid);
      expect(first.status).toBe(200);
      const other = await workspace(org, acc);
      const refused = await uploadUrl(other.cid);
      expect(refused.status).toBe(402);
      expect(await limitOf(refused)).toBe("recording_project");
      // A conversation that already has audio keeps recording.
      await seeded(other.cid, 10);
      expect((await uploadUrl(other.cid)).status).toBe(200);
    });

    test("a paid live conversation's first audio needs no recording project", async () => {
      const { org, acc, cid } = await account("changemaker");
      expect((await uploadUrl(cid)).status).toBe(200);
      const other = await workspace(org, acc);
      expect((await uploadUrl(other.cid)).status).toBe(200);
      expect(await freeRows(acc)).toBe(0);
    });

    test("a failing limit check keeps the recording", async () => {
      const { p, cid } = await account("free");
      await fill(p, 240);
      await h.sql`alter table free_usage rename to free_usage_away`;
      try {
        const { res } = await confirm(cid);
        expect(res.status).toBe(200);
        expect(await body(res)).not.toHaveProperty("recording_stop");
        expect((await uploadUrl(cid)).status).toBe(200);
      } finally {
        await h.sql`alter table free_usage_away rename to free_usage`;
      }
    });

    test("month boundary mid-recording", async () => {
      const { p, cid } = await account("free");
      await fill(p, 240, new Date("2026-10-31T12:00:00Z"));
      clock = new Date("2026-11-01T00:00:30Z");
      const { res } = await confirm(cid);
      expect(res.status).toBe(200);
      expect(await body(res)).not.toHaveProperty("recording_stop");
    });

    test("paid live chunks are untouched", async () => {
      const { acc, cid } = await account("changemaker");
      await seeded(cid, 400);
      const { res } = await confirm(cid);
      expect(res.status).toBe(200);
      expect(await body(res)).not.toHaveProperty("recording_stop");
      expect(await freeRows(acc)).toBe(0);
    });
  });
});
