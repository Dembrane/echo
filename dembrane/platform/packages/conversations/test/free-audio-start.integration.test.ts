import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { add, allowanceForProject, invalidateFreeLimits, setFreeLimit } from "@dembrane/allowance";
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

run("free audio: starting a recording", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  const bucket = localBucket();

  beforeAll(async () => {
    const url = await freshDatabase("conv_free_audio_start_test");
    const database = createDb({ url, poolMax: 4 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    d = {
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
  beforeEach(() => invalidateFreeLimits());

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const initiate = (projectId: string, source?: string) =>
    post(`/api/participant/projects/${projectId}/conversations/initiate`, {
      name: "P",
      pin: "",
      ...(source && { source }),
    });
  const portalProject = async (projectId: string) => {
    const res = await app.request(`/api/participant/projects/${projectId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      is_taking_recordings: boolean;
      conversation_limit_seconds: number | null;
    };
  };
  const uploadUrl = (cid: string) =>
    post(`/api/participant/conversations/${cid}/get-upload-url`, {
      filename: "rec.mp3",
      content_type: "audio/mpeg",
      conversation_id: cid,
    });
  const limitOf = async (res: Response) =>
    ((await res.json()) as { detail: { limit?: string } }).detail.limit;

  async function project(workspaceId: string | null, createdAt = new Date().toISOString()) {
    const id = newId();
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at)
      values (${id}, 'P', 'en', ${workspaceId}, true, ${createdAt})`;
    return id;
  }

  async function account(tier: string) {
    const org = newId();
    const acc = newId();
    const ws = newId();
    await sql`insert into org (id, name) values (${org}, 'O')`;
    await sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    return { acc, ws };
  }

  // A free account with two projects: the older one is the recording project.
  async function freeTwo() {
    const { acc, ws } = await account("free");
    const recording = await project(ws, "2026-01-01T00:00:00Z");
    const other = await project(ws, "2026-01-02T00:00:00Z");
    await sql`update billing_account set recording_project_id = ${recording} where id = ${acc}`;
    return { acc, ws, recording, other };
  }

  async function conversation(projectId: string, source: string) {
    const id = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${id}, ${projectId}, 'P', ${source}, now(), now())`;
    return id;
  }

  async function storedRecording(acc: string) {
    const [r] = await sql`select recording_project_id from billing_account where id = ${acc}`;
    return (r?.recording_project_id as string | null) ?? null;
  }

  async function fillMonth(projectId: string, seconds: number) {
    const a = await allowanceForProject(d.db, projectId, new Date());
    if (!a) throw new Error("expected a free account");
    await add(d.db, a, "audio_seconds", seconds);
  }

  test("paid, pioneer, unknown and workspace-less projects are untouched", async () => {
    const ids: { p: string; acc: string | null }[] = [];
    for (const tier of ["changemaker", "pioneer", "mystery", ""]) {
      const { acc, ws } = await account(tier);
      await project(ws);
      ids.push({ p: await project(ws), acc });
    }
    ids.push({ p: await project(null), acc: null });
    for (const { p, acc } of ids) {
      expect((await initiate(p, "PORTAL_AUDIO")).status).toBe(200);
      expect((await initiate(p, "DASHBOARD_UPLOAD")).status).toBe(200);
      expect(await portalProject(p)).toMatchObject({
        is_taking_recordings: true,
        conversation_limit_seconds: null,
      });
      if (acc) expect(await storedRecording(acc)).toBeNull();
    }
    const [row] = await sql`select count(*)::int as n from free_usage`;
    expect(row?.n).toBe(0);
  });

  test("the only project becomes the recording project and records", async () => {
    const { acc, ws } = await account("free");
    const p = await project(ws);
    const res = await initiate(p, "PORTAL_AUDIO");
    expect(res.status).toBe(200);
    expect(await storedRecording(acc)).toBe(p);
    expect(await portalProject(p)).toMatchObject({
      is_taking_recordings: true,
      conversation_limit_seconds: 3600,
    });
  });

  test("another project is refused with recording_project", async () => {
    const { other, recording } = await freeTwo();
    const res = await initiate(other, "PORTAL_AUDIO");
    expect(res.status).toBe(402);
    expect(await limitOf(res)).toBe("recording_project");
    expect((await portalProject(other)).is_taking_recordings).toBe(false);
    expect((await portalProject(recording)).is_taking_recordings).toBe(true);
  });

  test("no initiate source is audio too", async () => {
    const { other } = await freeTwo();
    const res = await initiate(other);
    expect(res.status).toBe(402);
    expect(await limitOf(res)).toBe("recording_project");
  });

  test("no hours left refuses with audio_month", async () => {
    const { ws } = await account("free");
    const p = await project(ws);
    expect(await portalProject(p)).toMatchObject({
      is_taking_recordings: true,
      conversation_limit_seconds: 3600,
    });
    await fillMonth(p, 18000);
    const res = await initiate(p, "PORTAL_AUDIO");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { detail: Record<string, unknown> };
    expect(body.detail).toMatchObject({ limit: "audio_month", remaining_seconds: 0 });
    expect((await portalProject(p)).is_taking_recordings).toBe(false);
  });

  test("typed text still starts anywhere", async () => {
    const { other, recording } = await freeTwo();
    expect((await initiate(other, "PORTAL_TEXT")).status).toBe(200);
    await fillMonth(recording, 18000);
    expect((await initiate(recording, "PORTAL_TEXT")).status).toBe(200);
  });

  test("dashboard uploads meet the same gate", async () => {
    const { other } = await freeTwo();
    const res = await initiate(other, "DASHBOARD_UPLOAD");
    expect(res.status).toBe(402);
    expect(await limitOf(res)).toBe("recording_project");
  });

  test("the upload URL refuses with the reason, not a 500", async () => {
    const { other, recording } = await freeTwo();
    const cid = await conversation(other, "DASHBOARD_UPLOAD");
    const res = await uploadUrl(cid);
    expect(res.status).toBe(402);
    expect(await limitOf(res)).toBe("recording_project");
    const ok = await uploadUrl(await conversation(recording, "DASHBOARD_UPLOAD"));
    expect(ok.status).toBe(200);
  });

  test("a text conversation's first audio is a start", async () => {
    const { other } = await freeTwo();
    const cid = await conversation(other, "PORTAL_TEXT");
    const res = await uploadUrl(cid);
    expect(res.status).toBe(402);
    expect(await limitOf(res)).toBe("recording_project");
  });

  test("a text conversation that already has audio is not a start", async () => {
    const { other } = await freeTwo();
    const cid = await conversation(other, "PORTAL_TEXT");
    await sql`insert into conversation_chunk (id, conversation_id, path, source, timestamp, created_at, updated_at)
      values (${newId()}, ${cid}, 's3://x/a.mp3', 'PORTAL_TEXT', now(), now(), now())`;
    expect((await uploadUrl(cid)).status).toBe(200);
  });

  test("a limit raised by staff applies", async () => {
    const { ws } = await account("free");
    const p = await project(ws);
    await fillMonth(p, 18000);
    expect((await initiate(p, "PORTAL_AUDIO")).status).toBe(402);
    await setFreeLimit(d.db, "audio_seconds_month", 21600, null);
    invalidateFreeLimits();
    expect((await initiate(p, "PORTAL_AUDIO")).status).toBe(200);
    await setFreeLimit(d.db, "audio_seconds_month", 18000, null);
  });
});
