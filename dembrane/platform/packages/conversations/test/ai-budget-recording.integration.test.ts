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
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AI_SPEND_KEY, add, allowanceForProject, invalidateFreeLimits } from "@dembrane/allowance";
import { LocalMedia } from "@dembrane/audio";
import { errorBody, newId, PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import type { ConversationsDeps } from "../src/deps";
import { LIVE_GRACE_SECONDS } from "../src/free-audio";
import { ParticipantTokens } from "../src/participant-token";
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
const LIMIT = 5_000_000;

run("AI budget: recording and uploads", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  let clock: Date | null = null;

  beforeAll(async () => {
    const url = await freshDatabase("conv_ai_budget_recording_test");
    h = await startWorker(url);
    const database = createDb({ url, poolMax: 4 });
    close = () => database.close();
    d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: h.bucket.storage,
      audioUrls: h.bucket.urls,
      // Accepted chunks run through the real pipeline.
      jobs: h.queue,
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
  });
  afterAll(async () => {
    await h?.stop();
    await close?.();
  });
  beforeEach(() => {
    invalidateFreeLimits();
    clock = null;
  });

  async function account(tier: string, source = "PORTAL_AUDIO") {
    const org = newId();
    const acc = newId();
    const ws = newId();
    await h.sql`insert into org (id, name) values (${org}, 'O')`;
    await h.sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, ${tier})`;
    await h.sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    const p = newId();
    await h.sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at)
      values (${p}, 'P', 'en', ${ws}, true, now())`;
    const cid = newId();
    await h.sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${cid}, ${p}, 'P', ${source}, now(), now())`;
    return { acc, p, cid };
  }

  async function spend(p: string, amount = LIMIT) {
    const a = await allowanceForProject(d.db, p, new Date());
    if (!a) throw new Error("expected a free account");
    await add(d.db, a, AI_SPEND_KEY, amount);
  }

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function stored(cid: string, seconds: number, ext = "webm") {
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-rec.${ext}`;
    const codec = ext === "wav" ? ["-c:a", "pcm_s16le"] : ["-c:a", "libopus"];
    await h.bucket.storage.put(
      key,
      await tone(join(h.bucket.root, `${chunkId}.${ext}`), seconds, codec),
    );
    return { chunkId, key };
  }

  async function confirm(cid: string, source = "PORTAL_AUDIO") {
    const { chunkId, key } = await stored(cid, 2, source === "PORTAL_AUDIO" ? "webm" : "wav");
    const res = await post(`/api/participant/conversations/${cid}/confirm-upload`, {
      chunk_id: chunkId,
      file_url: h.bucket.urls.fileUrl(key),
      timestamp: new Date().toISOString(),
      source,
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
  const detail = async (res: Response) =>
    ((await res.json()) as { detail: Record<string, unknown> }).detail;
  const chunkIds = async (cid: string) =>
    (await h.sql`select id from conversation_chunk where conversation_id = ${cid}`).map(
      (r) => r.id,
    );
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000);

  test("a new recording at zero is refused, with no budget figures", async () => {
    const { p } = await account("free");
    await spend(p);
    const res = await post(`/api/participant/projects/${p}/conversations/initiate`, {
      name: "N",
      pin: "",
      source: "PORTAL_AUDIO",
    });
    expect(res.status).toBe(402);
    const dt = await detail(res);
    expect(dt.limit).toBe("ai_budget");
    expect(dt).not.toHaveProperty("used");
    expect(dt).not.toHaveProperty("cap");
  });

  test("a typed text conversation at zero is refused the same way; below zero it starts", async () => {
    const { p } = await account("free");
    const start = () =>
      post(`/api/participant/projects/${p}/conversations/initiate`, {
        name: "N",
        pin: "",
        source: "PORTAL_TEXT",
      });
    expect((await start()).status).toBe(200);
    await spend(p);
    const text = await start();
    expect(text.status).toBe(402);
    const dt = await detail(text);
    expect(dt.limit).toBe("ai_budget");
    expect(dt).not.toHaveProperty("percent");
    expect(dt).not.toHaveProperty("resets_at");
  });

  test("the portal project read says whether recording and AI are available", async () => {
    const { p } = await account("free");
    const open = await body(await app.request(`/api/participant/projects/${p}`));
    expect(open.is_taking_recordings).toBe(true);
    expect(open.is_ai_available).toBe(true);
    await spend(p);
    const shut = await body(await app.request(`/api/participant/projects/${p}`));
    expect(shut.is_taking_recordings).toBe(false);
    expect(shut.is_ai_available).toBe(false);
    const paid = await account("changemaker");
    const out = await body(await app.request(`/api/participant/projects/${paid.p}`));
    expect(out.is_taking_recordings).toBe(true);
    expect(out.is_ai_available).toBe(true);
  });

  test("a live recording that runs out between chunks stops, with a short grace", async () => {
    const { p, cid } = await account("free");
    const first = await confirm(cid);
    expect(first.res.status).toBe(200);
    expect(await body(first.res)).not.toHaveProperty("recording_stop");

    await spend(p);
    const stop = await confirm(cid);
    expect(stop.res.status).toBe(200);
    expect((await body(stop.res)).recording_stop).toBe("ai_budget");
    expect(await chunkIds(cid)).toContain(stop.chunkId);

    // A chunk already in flight lands within the grace.
    clock = later(60);
    const inFlight = await confirm(cid);
    expect(inFlight.res.status).toBe(200);
    expect((await body(inFlight.res)).recording_stop).toBe("ai_budget");
    expect(await chunkIds(cid)).toContain(inFlight.chunkId);
    expect((await uploadUrl(cid)).status).toBe(200);

    clock = later(LIVE_GRACE_SECONDS + 10);
    const late = await confirm(cid);
    expect(late.res.status).toBe(402);
    expect((await detail(late.res)).limit).toBe("ai_budget");
    expect(await h.bucket.storage.size(late.key)).toBeNull();
    expect(await chunkIds(cid)).not.toContain(late.chunkId);
    const url = await uploadUrl(cid);
    expect(url.status).toBe(402);
    expect((await detail(url)).limit).toBe("ai_budget");

    // A retried confirm of a kept chunk still says stop.
    const retry = await post(`/api/participant/conversations/${cid}/confirm-upload`, {
      chunk_id: stop.chunkId,
      file_url: h.bucket.urls.fileUrl(stop.key),
      timestamp: new Date().toISOString(),
      source: "PORTAL_AUDIO",
    });
    expect(retry.status).toBe(200);
    expect((await body(retry)).recording_stop).toBe("ai_budget");
  });

  test("chunks already accepted are transcribed at zero", async () => {
    const { p, cid } = await account("free");
    await spend(p);
    const { res, chunkId } = await confirm(cid);
    expect((await body(res)).recording_stop).toBe("ai_budget");
    const done = await until(async () => {
      const [c] = await h.sql`select transcript from conversation_chunk where id = ${chunkId}`;
      return c?.transcript ? c : null;
    });
    expect(String(done.transcript)).toStartWith("transcript of ");
  });

  test("room given back mid-recording clears the stop, and the next stop gets a fresh grace", async () => {
    const { acc, p, cid } = await account("free");
    await spend(p);
    expect((await body((await confirm(cid)).res)).recording_stop).toBe("ai_budget");
    await h.sql`update billing_account set ai_budget_micro_eur = ${LIMIT * 2} where id = ${acc}`;
    clock = later(LIVE_GRACE_SECONDS + 10);
    const open = await confirm(cid);
    expect(open.res.status).toBe(200);
    expect(await body(open.res)).not.toHaveProperty("recording_stop");
    await spend(p);
    clock = later(LIVE_GRACE_SECONDS + 20);
    const again = await confirm(cid);
    expect(again.res.status).toBe(200);
    expect((await body(again.res)).recording_stop).toBe("ai_budget");
  });

  test("an upload at zero is refused and deleted", async () => {
    const { p, cid } = await account("free", "PORTAL_UPLOAD");
    await spend(p);
    const url = await uploadUrl(cid);
    expect(url.status).toBe(402);
    expect((await detail(url)).limit).toBe("ai_budget");
    const { res, key, chunkId } = await confirm(cid, "PORTAL_UPLOAD");
    expect(res.status).toBe(402);
    expect((await detail(res)).limit).toBe("ai_budget");
    expect(await h.bucket.storage.size(key)).toBeNull();
    expect(await chunkIds(cid)).not.toContain(chunkId);
  });

  const typed = (cid: string, content = "Typed words.") =>
    post(`/api/participant/conversations/${cid}/upload-text`, {
      content,
      timestamp: new Date().toISOString(),
      source: "PORTAL_TEXT",
    });
  const finalizeRuns = async (cid: string) =>
    Number(
      (
        await h.sql`select count(*)::int as n from dbos.workflow_status
          where workflow_uuid like ${`conversations.finalize:${cid}:%`}`
      )[0]?.n,
    );
  // Tests run one at a time, so every finish run in the database is this test's or done.
  const finishRuns = async () =>
    (await h.sql`select status from dbos.workflow_status where name = 'conversations.finish'`).map(
      (r) => String(r.status),
    );
  const settled = async (n: number) => {
    const runs = await finishRuns();
    return runs.length === n && runs.every((s) => s === "SUCCESS");
  };
  // A typed conversation finished and summarised below the limit.
  async function summarised() {
    const { p, cid } = await account("free", "PORTAL_TEXT");
    expect((await typed(cid)).status).toBe(200);
    const before = (await finishRuns()).length;
    await post(`/api/participant/conversations/${cid}/finish`, {});
    const row = await until(async () => {
      const [c] = await h.sql`select summary from conversation where id = ${cid}`;
      return c?.summary ? c : null;
    });
    await until(() => settled(before + 1));
    return { p, cid, summary: String(row.summary) };
  }

  test("typed text on a finished conversation at zero is refused like a typed start", async () => {
    const { p, cid, summary } = await summarised();
    await spend(p);
    const res = await typed(cid, "More words after the end.");
    expect(res.status).toBe(402);
    const dt = await detail(res);
    expect(dt.limit).toBe("ai_budget");
    expect(dt).not.toHaveProperty("percent");
    expect(dt).not.toHaveProperty("resets_at");
    const [c] = await h.sql`select summary, is_finished from conversation where id = ${cid}`;
    expect({
      summary: c?.summary,
      finished: c?.is_finished,
      chunks: (await chunkIds(cid)).length,
    }).toEqual({ summary, finished: true, chunks: 1 });
  });

  test("typed text while a conversation is in progress keeps the grace at zero, then is refused", async () => {
    const { p, cid } = await account("free", "PORTAL_TEXT");
    expect((await typed(cid, "First thought.")).status).toBe(200);
    await spend(p);
    const inGrace = await typed(cid, "Last thought, just after zero.");
    expect(inGrace.status).toBe(200);
    expect((await body(inGrace)).recording_stop).toBe("ai_budget");
    const [c] = await h.sql`select ai_stopped_at from conversation where id = ${cid}`;
    expect(c?.ai_stopped_at).not.toBeNull();
    clock = later(LIVE_GRACE_SECONDS + 10);
    const late = await typed(cid, "Too late.");
    expect(late.status).toBe(402);
    expect((await detail(late)).limit).toBe("ai_budget");
    expect(await chunkIds(cid)).toHaveLength(2);
  });

  test("a finished recording reopened at zero takes no audio, with no grace", async () => {
    const { p, cid } = await account("free");
    expect((await confirm(cid)).res.status).toBe(200);
    const before = (await finishRuns()).length;
    await post(`/api/participant/conversations/${cid}/finish`, {});
    const row = await until(async () => {
      const [c] = await h.sql`select summary from conversation where id = ${cid}`;
      return c?.summary ? c : null;
    });
    await until(() => settled(before + 1));
    await spend(p);
    const url = await uploadUrl(cid);
    expect(url.status).toBe(402);
    expect((await detail(url)).limit).toBe("ai_budget");
    const { res, key } = await confirm(cid);
    expect(res.status).toBe(402);
    expect((await detail(res)).limit).toBe("ai_budget");
    expect(await h.bucket.storage.size(key)).toBeNull();
    const [c] =
      await h.sql`select summary, is_finished, ai_stopped_at from conversation where id = ${cid}`;
    expect({
      summary: c?.summary,
      finished: c?.is_finished,
      stamped: c?.ai_stopped_at !== null,
      chunks: (await chunkIds(cid)).length,
      finalizes: await finalizeRuns(cid),
    }).toEqual({ summary: row.summary, finished: true, stamped: false, chunks: 1, finalizes: 1 });
  });

  test("a tiny upload confirmed at zero does not reopen a finished conversation", async () => {
    const { p, cid, summary } = await summarised();
    // The upload URL was issued before zero; the confirm comes after.
    await spend(p);
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-rec.webm`;
    await h.bucket.storage.put(key, new Uint8Array(100));
    const res = await post(`/api/participant/conversations/${cid}/confirm-upload`, {
      chunk_id: chunkId,
      file_url: h.bucket.urls.fileUrl(key),
      timestamp: new Date().toISOString(),
      source: "PORTAL_UPLOAD",
    });
    expect(res.status).toBe(402);
    expect((await detail(res)).limit).toBe("ai_budget");
    expect(await h.bucket.storage.size(key)).toBeNull();
    const [c] = await h.sql`select summary, is_finished from conversation where id = ${cid}`;
    expect({
      summary: c?.summary,
      finished: c?.is_finished,
      chunks: (await chunkIds(cid)).length,
    }).toEqual({ summary, finished: true, chunks: 1 });
  });

  test("finishing again with nothing new runs no second summary", async () => {
    const { p, cid, summary } = await summarised();
    await spend(p);
    expect(await finalizeRuns(cid)).toBe(1);
    const before = (await finishRuns()).length;
    expect((await post(`/api/participant/conversations/${cid}/finish`, {})).status).toBe(200);
    await until(() => settled(before + 1));
    const [c] = await h.sql`select summary from conversation where id = ${cid}`;
    expect({ finalizes: await finalizeRuns(cid), summary: c?.summary }).toEqual({
      finalizes: 1,
      summary,
    });
  });

  test("below the limit, typed text reopens a finished conversation and is summarised again", async () => {
    const { cid } = await summarised();
    expect((await typed(cid, "An afterthought.")).status).toBe(200);
    await post(`/api/participant/conversations/${cid}/finish`, {});
    await until(async () => ((await finalizeRuns(cid)) === 2 ? true : null));
  });

  test("a paid account never stops for the AI budget", async () => {
    const { acc, cid } = await account("changemaker");
    await h.sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${acc}, date_trunc('month', now()), ${AI_SPEND_KEY}, ${LIMIT * 10})`;
    const { res } = await confirm(cid);
    expect(res.status).toBe(200);
    expect(await body(res)).not.toHaveProperty("recording_stop");
  });
});
