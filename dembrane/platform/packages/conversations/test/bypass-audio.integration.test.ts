import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { join } from "node:path";
import type { Access } from "@dembrane/access";
import {
  add,
  allowanceForProject,
  invalidateFreeLimits,
  setFreeLimit,
  usedThisPeriod,
} from "@dembrane/allowance";
import { AudioError, LocalMedia, type Media } from "@dembrane/audio";
import { errorBody, newId, PlatformError } from "@dembrane/core";
import { createDb, type Db } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import {
  conversationSeconds,
  LIVE_MEASURE_TIMEOUT_MS,
  UPLOAD_MEASURE_TIMEOUT_MS,
} from "../src/free-audio";
import { ParticipantTokens } from "../src/participant-token";
import { type PipelineDeps, prepareChunk } from "../src/pipeline/steps";
import { portalRoutes } from "../src/portal/routes";
import { transcribeStateless } from "../src/stateless/service";
import { txOf } from "../src/storage";
import { admin, fakeModels, freshDatabase, localBucket, quiet, tone } from "./pipeline-harness";

// Adversarial review, group A (audio): each test replays a way past the free audio limits.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

const CONV_LIMIT = 60;
const MONTH_LIMIT = 120;
const GRACE = 120;

run("bypass: free audio limits", () => {
  setDefaultTimeout(120_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  let pd: PipelineDeps;
  let media: Media = new LocalMedia();
  const bucket = localBucket();
  const transcriber = new FakeTranscriber();
  let timeouts = { upload: 120_000, live: 15_000 };

  beforeAll(async () => {
    const url = await freshDatabase("conv_bypass_audio_test");
    const database = createDb({ url, poolMax: 6 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const jobs = { enqueue: async () => "run" } as unknown as ConversationsDeps["jobs"];
    d = {
      db: database.db,
      // Every caller may write every project: access is not under review here.
      access: { project: async () => ({ tier: "free" }) } as unknown as Access,
      audio: bucket.storage,
      audioUrls: bucket.urls,
      jobs,
      models: fakeModels().models,
      get media() {
        return media;
      },
      transcriber,
      hub: null,
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("t".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: false,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
        get measureTimeoutMs() {
          return timeouts;
        },
      },
      now: () => new Date(),
    };
    pd = {
      db: database.db,
      audio: bucket.storage,
      audioUrls: bucket.urls,
      get media() {
        return media;
      },
      transcriber,
      models: fakeModels().models,
      jobs: jobs as unknown as PipelineDeps["jobs"],
      logger: quiet,
      now: () => new Date(),
      webhooks: { enabled: false, dashboardUrl: "http://dashboard.test" },
    };
    app = new Hono<Env>();
    app.route("/", portalRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json(errorBody(err), err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
    await setFreeLimit(d.db, "audio_seconds_conversation", CONV_LIMIT, null);
    await setFreeLimit(d.db, "audio_seconds_month", MONTH_LIMIT, null);
  });
  afterAll(async () => {
    bucket.server.stop(true);
    await sql?.end();
    await close?.();
  });
  beforeEach(() => {
    invalidateFreeLimits();
    media = new LocalMedia();
    timeouts = { upload: 120_000, live: 15_000 };
  });

  async function project(org: string, acc: string) {
    const ws = newId();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    const p = newId();
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at)
      values (${p}, 'P', 'en', ${ws}, true, now())`;
    return p;
  }

  async function conversation(p: string, source: string) {
    const cid = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${cid}, ${p}, 'P', ${source}, now(), now())`;
    return cid;
  }

  async function account(source = "PORTAL_AUDIO") {
    const org = newId();
    const acc = newId();
    await sql`insert into org (id, name) values (${org}, 'O')`;
    await sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, 'free')`;
    const p = await project(org, acc);
    await sql`update billing_account set recording_project_id = ${p} where id = ${acc}`;
    return { org, acc, p, cid: await conversation(p, source) };
  }

  async function used(p: string): Promise<number> {
    const a = await allowanceForProject(d.db, p, new Date());
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(d.db, a)).audio_seconds;
  }

  async function fill(p: string, seconds: number) {
    const a = await allowanceForProject(d.db, p, new Date());
    if (!a) throw new Error("expected a free account");
    await add(d.db, a, "audio_seconds", seconds);
  }

  // A chunk that already counted this many seconds (conversation and ledger).
  async function seeded(p: string, cid: string, seconds: number) {
    await sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, audio_seconds, created_at, updated_at)
      values (${newId()}, ${cid}, 's3://x/a.mp3', 'PORTAL_AUDIO', now(), ${seconds}, now(), now())`;
    await fill(p, seconds);
  }

  const codecs: Record<string, string[]> = {
    webm: ["-c:a", "libopus"],
    mp3: ["-c:a", "libmp3lame"],
    wav: ["-c:a", "pcm_s16le"],
  };
  const audioOf = async (seconds: number, ext: string) =>
    tone(join(bucket.root, `${newId()}.${ext}`), seconds, codecs[ext] as string[]);

  // What the presigned form POST stores at the issued key; it can be posted again until it expires.
  async function post(key: string, seconds: number, ext: string) {
    await bucket.storage.put(key, await audioOf(seconds, ext));
  }

  async function issued(cid: string, ext: string) {
    const chunkId = newId();
    return { chunkId, key: `conversation/${cid}/chunks/${chunkId}-rec.${ext}` };
  }

  const confirm = (cid: string, chunkId: string, key: string, source: string) =>
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

  const chunkId = async (res: Response) => ((await res.json()) as { id: string }).id;

  test("live chunks confirmed faster than the pipeline meters them pass both limits", async () => {
    const { p, cid } = await account();
    await seeded(p, cid, 10);
    // One presigned upload, confirmed many times: each confirm is a new chunk.
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 30, "webm");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => confirm(cid, cId, key, "PORTAL_AUDIO")),
    );
    const accepted: string[] = [];
    for (const r of results) if (r.status === 200) accepted.push(await chunkId(r));
    for (const id of accepted) await prepareChunk(pd, id);
    // Every accepted chunk is transcribed; nothing may pass the conversation's limit plus grace.
    expect(await conversationSeconds(d.db, cid)).toBeLessThanOrEqual(CONV_LIMIT + GRACE + 1);
    expect(await used(p)).toBeLessThanOrEqual(MONTH_LIMIT + GRACE + 1);
  });

  test("parallel confirms of distinct live chunks stop one chunk past the grace", async () => {
    const { p, cid } = await account();
    await seeded(p, cid, 10);
    const keys = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const k = await issued(cid, "webm");
        await post(k.key, 30, "webm");
        return k;
      }),
    );
    const results = await Promise.all(
      keys.map((k) => confirm(cid, k.chunkId, k.key, "PORTAL_AUDIO")),
    );
    const accepted: string[] = [];
    for (const r of results) if (r.status === 200) accepted.push(await chunkId(r));
    for (const id of accepted) await prepareChunk(pd, id);
    expect(await conversationSeconds(d.db, cid)).toBeLessThanOrEqual(CONV_LIMIT + GRACE + 31);
    expect(await used(p)).toBeLessThanOrEqual(MONTH_LIMIT + GRACE + 31);
    expect(accepted.length).toBeGreaterThanOrEqual(5);
  });

  test("a repeated confirm returns the chunk it made", async () => {
    const { p, cid } = await account();
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 5, "webm");
    const first = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(first.status).toBe(200);
    // The form is posted again and confirmed again.
    await post(key, 5, "webm");
    const again = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(again.status).toBe(200);
    expect(await chunkId(again)).toBe(await chunkId(first));
    const rows = await sql`select id, path from conversation_chunk where conversation_id = ${cid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe(bucket.urls.fileUrl(key));
    expect(await used(p)).toBe(5);
  });

  test("a small live chunk whose measuring fails is still kept and transcribed", async () => {
    const { p, cid } = await account();
    const { chunkId: cId, key } = await issued(cid, "mp3");
    await post(key, 5, "mp3");
    const inner = new LocalMedia();
    media = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "decodedSeconds" || prop === "probe")
          return () => Promise.reject(new AudioError("transient", "media away"));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(res.status).toBe(200);
    const id = await chunkId(res);
    expect(await prepareChunk(pd, id)).toEqual([id]);
    expect(await used(p)).toBe(0);
  });

  test("a paid confirm keeps the uploaded key and makes a chunk per confirm", async () => {
    const { acc, cid } = await account();
    await sql`update billing_account set tier = 'changemaker' where id = ${acc}`;
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 5, "webm");
    const res = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; path: string };
    expect(body.path).toBe(bucket.urls.fileUrl(key));
    expect(body.id).not.toBe(cId);
    expect(await bucket.storage.size(key)).not.toBeNull();
  });

  test("a failing ledger write inside the lock keeps the live chunk", async () => {
    const { acc, p, cid } = await account();
    const fn = `fail_${acc.replaceAll("-", "")}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$
      begin if new.billing_account_id = '${acc}' then raise exception 'ledger down'; end if; return new; end $$`);
    await sql.unsafe(`create trigger ${fn} before insert or update on free_usage
      for each row execute function ${fn}()`);
    try {
      const { chunkId: cId, key } = await issued(cid, "webm");
      await post(key, 5, "webm");
      const res = await confirm(cid, cId, key, "PORTAL_AUDIO");
      expect(res.status).toBe(200);
      const [row] = await sql`select audio_seconds from conversation_chunk where id = ${cId}`;
      expect(row?.audio_seconds).toBeNull();
    } finally {
      await sql.unsafe(`drop trigger ${fn} on free_usage; drop function ${fn}()`);
    }
    expect(await used(p)).toBe(0);
  });

  test("a repeated confirm carries the stop signal", async () => {
    const { p, cid } = await account();
    await seeded(p, cid, CONV_LIMIT);
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 5, "webm");
    const first = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(((await first.json()) as { recording_stop?: string }).recording_stop).toBe(
      "audio_conversation",
    );
    await post(key, 5, "webm");
    const again = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { recording_stop?: string }).recording_stop).toBe(
      "audio_conversation",
    );
  });

  test("a live chunk confirmed while the tier read fails is kept at its upload key", async () => {
    const { cid } = await account();
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 5, "webm");
    await sql`alter table billing_account rename to billing_account_away`;
    let res: Response;
    try {
      res = await confirm(cid, cId, key, "PORTAL_AUDIO");
    } finally {
      await sql`alter table billing_account_away rename to billing_account`;
    }
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(bucket.urls.fileUrl(key));
  });

  test("txOf writes in the drizzle transaction it is given", async () => {
    const id = newId();
    const out = await Promise.resolve(
      d.db.transaction(async (tx) => {
        await txOf(tx as unknown as Db).sql`insert into org (id, name) values (${id}, 'tx')`;
        throw new Error("roll back");
      }),
    ).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(out).toBe("roll back");
    expect(await sql`select id from org where id = ${id}`).toHaveLength(0);
  });

  test("a live chunk whose measuring fails transiently is transcribed at any length, uncounted", async () => {
    const { p, cid } = await account();
    await seeded(p, cid, 10);
    const { chunkId: cId, key } = await issued(cid, "mp3");
    await post(key, 150, "mp3");
    const res = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(res.status).toBe(200);
    const id = await chunkId(res);
    // The media service times out on the decode; probing and splitting still work.
    const inner = new LocalMedia();
    media = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "decodedSeconds")
          return () => Promise.reject(new AudioError("transient", "decode timed out"));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const out = await prepareChunk(pd, id).then(
      (ids) => ids,
      () => [] as string[],
    );
    const leaked = out.length > 0 && (await used(p)) < 10 + 149;
    expect({ transcribed: out.length, used: await used(p), leaked }).toMatchObject({
      leaked: false,
    });
  });

  test("a live conversation past its grace takes more audio sent as an upload", async () => {
    const { cid } = await account();
    // Recorded last month: this month's ledger has room, the conversation has none.
    await sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, audio_seconds, created_at, updated_at)
      values (${newId()}, ${cid}, 's3://x/a.mp3', 'PORTAL_AUDIO', now(), ${CONV_LIMIT + GRACE + 5}, now(), now())`;
    const live = await issued(cid, "webm");
    await post(live.key, 2, "webm");
    expect((await confirm(cid, live.chunkId, live.key, "PORTAL_AUDIO")).status).toBe(402);
    const { chunkId: cId, key } = await issued(cid, "wav");
    await post(key, 15, "wav");
    const res = await confirm(cid, cId, key, "DASHBOARD_UPLOAD");
    expect(res.status).toBe(402);
  });

  test("a non-recording project takes uploads into a conversation that already has audio", async () => {
    const { org, acc, p } = await account();
    const other = await project(org, acc);
    const cid = await conversation(other, "PORTAL_AUDIO");
    await seeded(p, cid, 10);
    // get-upload-url only checks the live limits once the conversation has audio.
    const url = await app.request(`/api/participant/conversations/${cid}/get-upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "rec.wav",
        content_type: "audio/wav",
        conversation_id: cid,
      }),
    });
    expect(url.status).toBe(200);
    const { chunk_id, file_url } = (await url.json()) as { chunk_id: string; file_url: string };
    const key = bucket.urls.keyOf(file_url);
    await post(key, 15, "wav");
    const res = await confirm(cid, chunk_id, key, "DASHBOARD_UPLOAD");
    expect(res.status).toBe(402);
  });

  // Measuring that rejects (failing) or never answers (hanging); everything else works.
  let measureSignals: (AbortSignal | undefined)[] = [];
  function brokenMedia(how: "failing" | "hanging") {
    const inner = new LocalMedia();
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "decodedSeconds" || prop === "probe")
          return (_s: unknown, o?: { signal?: AbortSignal }) => {
            measureSignals.push(o?.signal);
            return how === "hanging"
              ? new Promise(() => {})
              : Promise.reject(new AudioError("transient", "media away"));
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  test("a retried upload confirm that would be refused keeps the saved file", async () => {
    const { p, cid } = await account("DASHBOARD_UPLOAD");
    await fill(p, 30);
    const { chunkId: cId, key } = await issued(cid, "wav");
    await post(key, 50, "wav");
    // Both pass the early duplicate check; the second sees the first's 50 s under the lock.
    const [a, b] = await Promise.all([
      confirm(cid, cId, key, "DASHBOARD_UPLOAD"),
      confirm(cid, cId, key, "DASHBOARD_UPLOAD"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await chunkId(a)).toBe(cId);
    expect(await chunkId(b)).toBe(cId);
    expect(await bucket.storage.size(key)).not.toBeNull();
    expect(
      await sql`select id from conversation_chunk where conversation_id = ${cid}`,
    ).toHaveLength(1);
    expect(await used(p)).toBe(80);
  });

  test("a retried live confirm that would be refused keeps the saved chunk", async () => {
    const { p, cid } = await account();
    await seeded(p, cid, CONV_LIMIT + GRACE - 20);
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 30, "webm");
    const [a, b] = await Promise.all([
      confirm(cid, cId, key, "PORTAL_AUDIO"),
      confirm(cid, cId, key, "PORTAL_AUDIO"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await bucket.storage.size(key)).not.toBeNull();
    const rows =
      await sql`select id from conversation_chunk where conversation_id = ${cid} and id = ${cId}`;
    expect(rows).toHaveLength(1);
    expect(await used(p)).toBe(CONV_LIMIT + GRACE - 20 + 30);
  });

  test("live chunks confirmed while measuring fails never stop the recording", async () => {
    const { p, cid } = await account();
    await seeded(p, cid, 10);
    const bytes = await (await audioOf(30, "webm")).arrayBuffer();
    media = brokenMedia("failing");
    for (let i = 0; i < 50; i++) {
      const { chunkId: cId, key } = await issued(cid, "webm");
      await bucket.storage.put(key, new Blob([bytes]));
      const res = await confirm(cid, cId, key, "PORTAL_AUDIO");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { recording_stop?: string }).recording_stop).toBeUndefined();
    }
    const url = await app.request(`/api/participant/conversations/${cid}/get-upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "rec.webm",
        content_type: "audio/webm",
        conversation_id: cid,
      }),
    });
    expect(url.status).toBe(200);
    expect(await used(p)).toBe(10);
  });

  test("measuring an upload that never answers is a retryable 503", async () => {
    const { p, cid } = await account("DASHBOARD_UPLOAD");
    const { chunkId: cId, key } = await issued(cid, "wav");
    await post(key, 5, "wav");
    timeouts = { upload: 300, live: 300 };
    media = brokenMedia("hanging");
    measureSignals = [];
    const res = await confirm(cid, cId, key, "DASHBOARD_UPLOAD");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe("upload.measure_failed");
    // The timed-out measure aborted the media request instead of leaving it decoding.
    expect(measureSignals.length).toBe(1);
    expect(measureSignals[0]?.aborted).toBe(true);
    expect(await bucket.storage.size(key)).not.toBeNull();
    expect(
      await sql`select id from conversation_chunk where conversation_id = ${cid}`,
    ).toHaveLength(0);
    expect(await used(p)).toBe(0);
    media = new LocalMedia();
    const again = await confirm(cid, cId, key, "DASHBOARD_UPLOAD");
    expect(again.status).toBe(200);
    expect(await used(p)).toBe(5);
  }, 10_000);

  test("uploads get 200 s to measure, under the API's 255 s idle timeout; live chunks 15 s", () => {
    expect(UPLOAD_MEASURE_TIMEOUT_MS).toBe(200_000);
    expect(LIVE_MEASURE_TIMEOUT_MS).toBe(15_000);
  });

  test("measuring a live chunk that never answers keeps the chunk", async () => {
    const { p, cid } = await account();
    const { chunkId: cId, key } = await issued(cid, "webm");
    await post(key, 5, "webm");
    timeouts = { upload: 300, live: 300 };
    media = brokenMedia("hanging");
    const res = await confirm(cid, cId, key, "PORTAL_AUDIO");
    expect(res.status).toBe(200);
    const [row] = await sql`select audio_seconds from conversation_chunk where id = ${cId}`;
    expect(row?.audio_seconds).toBeNull();
    expect(await used(p)).toBe(0);
  }, 10_000);

  const startLive = async (p: string) => {
    const res = await app.request(`/api/participant/projects/${p}/conversations/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "P", pin: "", source: "PORTAL_AUDIO" }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  };
  const uploadUrl = (cid: string) =>
    app.request(`/api/participant/conversations/${cid}/get-upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "rec.webm",
        content_type: "audio/webm",
        conversation_id: cid,
      }),
    });

  test("a month spent right after Record still takes the first chunk with a stop", async () => {
    const { p } = await account();
    const cid = await startLive(p);
    await fill(p, MONTH_LIMIT);
    const url = await uploadUrl(cid);
    expect(url.status).toBe(200);
    const { chunk_id, file_url } = (await url.json()) as { chunk_id: string; file_url: string };
    const key = bucket.urls.keyOf(file_url);
    await post(key, 30, "webm");
    const res = await confirm(cid, chunk_id, key, "PORTAL_AUDIO");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recording_stop?: string }).recording_stop).toBe("audio_month");
    expect(await used(p)).toBe(MONTH_LIMIT + 30);
  });

  test("a started recording with no audio yet is refused past the grace", async () => {
    const { p } = await account();
    const cid = await startLive(p);
    await fill(p, MONTH_LIMIT + GRACE);
    const res = await uploadUrl(cid);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { detail: { limit?: string } }).detail.limit).toBe("audio_month");
  });

  test("a started recording with no audio stays in the recording project", async () => {
    const { org, acc, p } = await account();
    const cid = await startLive(p);
    const other = await project(org, acc);
    await sql`update billing_account set recording_project_id = ${other} where id = ${acc}`;
    const res = await uploadUrl(cid);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { detail: { limit?: string } }).detail.limit).toBe(
      "recording_project",
    );
  });

  // A7: project-billed stateless transcription is refused on free outright.
  const voiceNote = async (projectId: string) => {
    const wav = await audioOf(30, "wav");
    const file = new File([await wav.arrayBuffer()], "note.wav", { type: "audio/wav" });
    const who: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
    return Promise.resolve(
      transcribeStateless(
        d,
        who,
        {
          projectId,
          file,
          audioFileUri: null,
          language: "en",
          hotwords: null,
          usePiiRedaction: false,
          anonymizeTranscripts: false,
          customGuidancePrompt: null,
          promptOverride: null,
        },
        { gate: async () => {}, checkFile: () => {} },
      ),
    ).then(
      () => null,
      (e) => e as PlatformError,
    );
  };

  test("stateless transcription spends a free account's audio with no check", async () => {
    const { p } = await account();
    const before = transcriber.calls.length;
    const err = await voiceNote(p);
    expect({
      status: err?.status,
      limit: (err?.details as { limit?: string } | undefined)?.limit,
      transcribed: transcriber.calls.length - before,
      used: await used(p),
    }).toEqual({ status: 402, limit: "audio_month", transcribed: 0, used: 0 });
  });

  test("stateless transcription is refused on a free sample project too", async () => {
    const { p } = await account();
    await sql`update project set is_sample = true where id = ${p}`;
    const before = transcriber.calls.length;
    const err = await voiceNote(p);
    expect({ status: err?.status, transcribed: transcriber.calls.length - before }).toEqual({
      status: 402,
      transcribed: 0,
    });
  });

  test("stateless transcription still runs on a paid project", async () => {
    const { acc, p } = await account();
    await sql`update billing_account set tier = 'changemaker' where id = ${acc}`;
    const before = transcriber.calls.length;
    const err = await voiceNote(p);
    expect({ err, transcribed: transcriber.calls.length - before }).toEqual({
      err: null,
      transcribed: 1,
    });
  });
});
