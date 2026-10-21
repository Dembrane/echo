import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import {
  add,
  allowanceForProject,
  invalidateFreeLimits,
  setFreeLimit,
  usedThisPeriod,
} from "@dembrane/allowance";
import { AudioError, LocalMedia, type Media } from "@dembrane/audio";
import { errorBody, newId, PlatformError, StatusError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { reserveUpload } from "../src/free-audio";
import { ParticipantTokens } from "../src/participant-token";
import { portalRoutes } from "../src/portal/routes";
import { admin, fakeModels, freshDatabase, localBucket, quiet, tone } from "./pipeline-harness";

const run = admin ? describe : describe.skip;

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

async function piped(seconds: number): Promise<Uint8Array> {
  const p = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-c:a",
      "libopus",
      "-f",
      "webm",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out;
}

run("free audio: uploads are measured and reserved", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  let media: Media;
  let calls: string[] = [];
  const enqueued: string[] = [];
  const bucket = localBucket();
  const dir = mkdtempSync(join(tmpdir(), "free-upload-"));
  const wav = async (seconds: number) =>
    new Uint8Array(
      await (await tone(join(dir, `${seconds}.wav`), seconds, ["-c:a", "pcm_s16le"])).arrayBuffer(),
    );

  beforeAll(async () => {
    const url = await freshDatabase("conv_free_audio_upload_test");
    const database = createDb({ url, poolMax: 6 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: bucket.storage,
      audioUrls: bucket.urls,
      jobs: {
        enqueue: async (def) => {
          enqueued.push(def.name);
          return "run";
        },
      },
      models: fakeModels().models,
      get media() {
        return media;
      },
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
    await setFreeLimit(d.db, "audio_seconds_conversation", 20, null);
    await setFreeLimit(d.db, "audio_seconds_month", 60, null);
  });
  afterAll(async () => {
    bucket.server.stop(true);
    await sql?.end();
    await close?.();
  });
  beforeEach(() => {
    invalidateFreeLimits();
    ({ media, calls } = counting(new LocalMedia()));
    enqueued.length = 0;
  });

  async function account(tier: string) {
    const org = newId();
    const acc = newId();
    const ws = newId();
    await sql`insert into org (id, name) values (${org}, 'O')`;
    await sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    const p = newId();
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at)
      values (${p}, 'P', 'en', ${ws}, true, now())`;
    const cid = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${cid}, ${p}, 'P', 'DASHBOARD_UPLOAD', now(), now())`;
    return { acc, p, cid };
  }

  async function used(p: string): Promise<number | null> {
    const a = await allowanceForProject(d.db, p, new Date());
    if (!a) return null;
    return (await usedThisPeriod(d.db, a)).audio_seconds;
  }

  async function fill(p: string, seconds: number) {
    const a = await allowanceForProject(d.db, p, new Date());
    if (!a) throw new Error("expected a free account");
    await add(d.db, a, "audio_seconds", seconds);
  }

  async function store(cid: string, bytes: Uint8Array, ext = "wav") {
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-rec.${ext}`;
    await bucket.storage.put(key, bytes);
    return { chunkId, key };
  }

  const confirm = (cid: string, chunkId: string, key: string, source = "DASHBOARD_UPLOAD") =>
    app.request(`/api/participant/conversations/${cid}/confirm-upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chunk_id: chunkId,
        file_url: bucket.urls.fileUrl(key),
        timestamp: new Date().toISOString(),
        source,
      }),
    });

  async function upload(cid: string, bytes: Uint8Array, ext = "wav") {
    const { chunkId, key } = await store(cid, bytes, ext);
    return { res: await confirm(cid, chunkId, key), key };
  }

  const chunks = async (cid: string) =>
    sql`select audio_seconds from conversation_chunk where conversation_id = ${cid}`;
  const detail = async (res: Response) =>
    ((await res.json()) as { detail: Record<string, unknown> }).detail;

  test("paid uploads are untouched", async () => {
    const { cid } = await account("changemaker");
    const { res } = await upload(cid, await wav(30));
    expect(res.status).toBe(200);
    const [row] = await sql`select count(*)::int as n from free_usage`;
    expect(row?.n).toBe(0);
    expect(calls).toEqual([]);
    const [chunk] = await chunks(cid);
    expect(chunk?.audio_seconds).toBeNull();
  });

  test("an upload that fits is reserved", async () => {
    const { p, cid } = await account("free");
    const { res } = await upload(cid, await wav(15));
    expect(res.status).toBe(200);
    expect(await used(p)).toBe(15);
    const [chunk] = await chunks(cid);
    expect(Math.abs(Number(chunk?.audio_seconds) - 15)).toBeLessThan(0.5);
    expect(enqueued).toContain("conversations.chunk");
  });

  test("over the per-file limit is refused and deleted", async () => {
    const { p, cid } = await account("free");
    const { res, key } = await upload(cid, await wav(25));
    expect(res.status).toBe(402);
    expect(await detail(res)).toMatchObject({
      limit: "audio_conversation",
      file_seconds: 25,
      limit_seconds: 20,
    });
    expect(await d.audio.size(key)).toBeNull();
    expect(await used(p)).toBe(0);
    expect(await chunks(cid)).toHaveLength(0);
    expect(enqueued).toEqual([]);
  });

  test("over what is left is refused and deleted", async () => {
    const { p, cid } = await account("free");
    await fill(p, 50);
    const { res, key } = await upload(cid, await wav(15));
    expect(res.status).toBe(402);
    expect(await detail(res)).toMatchObject({
      limit: "audio_month",
      file_seconds: 15,
      remaining_seconds: 10,
    });
    expect(await d.audio.size(key)).toBeNull();
    expect(await used(p)).toBe(50);
    expect(await chunks(cid)).toHaveLength(0);
  });

  test("concurrent uploads cannot overspend", async () => {
    const { p, cid } = await account("free");
    await fill(p, 40);
    const bytes = await wav(15);
    const a = await store(cid, bytes);
    const b = await store(cid, bytes);
    const res = await Promise.all([confirm(cid, a.chunkId, a.key), confirm(cid, b.chunkId, b.key)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 402]);
    const refused = res.find((r) => r.status === 402) as Response;
    expect((await detail(refused)).limit).toBe("audio_month");
    expect(await used(p)).toBe(55);
  });

  test("a failed chunk insert gives the reservation back", async () => {
    const { p, cid } = await account("free");
    await fill(p, 10);
    const urlRes = await app.request(`/api/participant/conversations/${cid}/get-upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "rec.wav",
        content_type: "audio/wav",
        conversation_id: cid,
      }),
    });
    expect(urlRes.status).toBe(200);
    const issued = (await urlRes.json()) as { chunk_id: string; file_url: string };
    const key = d.audioUrls.keyOf(issued.file_url);
    await bucket.storage.put(key, await wav(15));
    await sql`update project set is_conversation_allowed = false where id = ${p}`;
    const res = await confirm(cid, issued.chunk_id, key);
    expect(res.status).toBe(403);
    expect(await used(p)).toBe(10);
  });

  test("a file with no declared length is measured, not refused", async () => {
    const { p, cid } = await account("free");
    const { res } = await upload(cid, await piped(12), "webm");
    expect(res.status).toBe(200);
    const [chunk] = await chunks(cid);
    const seconds = Number(chunk?.audio_seconds);
    expect(Math.abs(seconds - 12)).toBeLessThan(0.5);
    expect(await used(p)).toBe(12);
  });

  test("a broken file is refused as unreadable", async () => {
    const { p, cid } = await account("free");
    const junk = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const { res, key } = await upload(cid, junk);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("upload.unreadable");
    expect(await d.audio.size(key)).toBeNull();
    expect(await used(p)).toBe(0);
    expect(await chunks(cid)).toHaveLength(0);
  });

  // A media service that reports a fixed decoded length.
  const decodes = (seconds: number) => {
    media = {
      ...new LocalMedia(),
      decodedSeconds: async () => ({ seconds }),
    } as unknown as Media;
  };

  test("an exact-hour file that decodes a few ms over is accepted", async () => {
    await setFreeLimit(d.db, "audio_seconds_conversation", 3600, null);
    await setFreeLimit(d.db, "audio_seconds_month", 18000, null);
    invalidateFreeLimits();
    try {
      const { p, cid } = await account("free");
      decodes(3600.004);
      const ok = await upload(cid, await wav(1));
      expect(ok.res.status).toBe(200);
      expect(await used(p)).toBe(3600);
      decodes(3601.5);
      const refused = await upload(cid, await wav(1));
      expect(refused.res.status).toBe(402);
      expect(await detail(refused.res)).toMatchObject({
        limit: "audio_conversation",
        file_seconds: 3602,
        limit_seconds: 3600,
      });
      expect(await d.audio.size(refused.key)).toBeNull();
      expect(await used(p)).toBe(3600);
    } finally {
      await setFreeLimit(d.db, "audio_seconds_conversation", 20, null);
      await setFreeLimit(d.db, "audio_seconds_month", 60, null);
      invalidateFreeLimits();
    }
  });

  test("a file using exactly what is left is accepted", async () => {
    const { p, cid } = await account("free");
    await fill(p, 45);
    decodes(14.6);
    const { res } = await upload(cid, await wav(1));
    expect(res.status).toBe(200);
    expect(await used(p)).toBe(60);
  });

  test("the media service away fails closed with a retry", async () => {
    const { p, cid } = await account("free");
    const away = () => Promise.reject(new AudioError("transient", "media service away"));
    media = { ...new LocalMedia(), probe: away, decodedSeconds: away } as unknown as Media;
    const { res } = await upload(cid, await wav(15));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("upload.measure_failed");
    expect(await used(p)).toBe(0);
    expect(await chunks(cid)).toHaveLength(0);
  });

  // A refused-to-measure upload keeps its object so the participant's retry can confirm it.
  async function expectRetry(res: Response, p: string, cid: string, key: string) {
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("upload.measure_failed");
    expect(await used(p)).toBe(0);
    expect(await chunks(cid)).toHaveLength(0);
    expect(await d.audio.size(key)).not.toBeNull();
  }

  test("a failing presign fails closed with a retry", async () => {
    const { p, cid } = await account("free");
    const original = bucket.storage.presignDownload;
    bucket.storage.presignDownload = () => {
      throw new Error("signer down");
    };
    try {
      const { res, key } = await upload(cid, await wav(15));
      await expectRetry(res, p, cid, key);
    } finally {
      bucket.storage.presignDownload = original;
    }
  });

  test("a failing media token fails closed with a retry", async () => {
    const { p, cid } = await account("free");
    const noToken = () => Promise.reject(new Error("metadata server unreachable"));
    media = { ...new LocalMedia(), probe: noToken, decodedSeconds: noToken } as unknown as Media;
    const { res, key } = await upload(cid, await wav(15));
    await expectRetry(res, p, cid, key);
  });

  test("a failing account read fails closed with a retry and is logged", async () => {
    const { p, cid } = await account("free");
    const { key } = await store(cid, await wav(15));
    const broken = new Proxy(d.db, {
      get() {
        throw new Error("db down");
      },
    });
    const logged: string[] = [];
    const logger = new Proxy(quiet, {
      get: (t, prop, r) =>
        prop === "error"
          ? (o: { signal?: string }) => {
              logged.push(String(o.signal));
            }
          : Reflect.get(t, prop, r),
    });
    const err = await reserveUpload(
      { ...d, db: broken, logger },
      { id: cid, project_id: p },
      key,
      1,
      () => Promise.reject(new Error("never written")),
    ).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).status).toBe(503);
    expect((err as StatusError).code).toBe("upload.measure_failed");
    expect(logged).toContain("free_audio.measure_failed");
    expect(await used(p)).toBe(0);
    expect(await d.audio.size(key)).not.toBeNull();
  });
});
