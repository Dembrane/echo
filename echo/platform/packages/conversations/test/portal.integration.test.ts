import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { LocalMedia } from "@dembrane/audio";
import { newId, PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import type { EnqueueOptions, JobDefinition } from "@dembrane/queue";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { portalRoutes } from "../src/portal/routes";
import { conversationAudioRoutes } from "../src/v1/audio-routes";
import {
  admin,
  fakeModels,
  freshDatabase,
  localBucket,
  PROJECT,
  quiet,
  seed,
  tone,
} from "./pipeline-harness";

// The upload paths the parity stack cannot run (it has no bucket): the legacy upload,
// presigned form upload and confirm, the unplayable-file rule, merge on first play and
// retranscribe, against a real database, the filesystem bucket and real ffmpeg.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("portal uploads and audio routes", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  const bucket = localBucket();
  const enqueued: { job: string; payload: unknown; opts?: EnqueueOptions }[] = [];
  const staff: Signed = { appUserId: null, directusUserId: newId(), isStaff: true };

  beforeAll(async () => {
    const url = await freshDatabase("conv_portal_test");
    const database = createDb({ url, poolMax: 3 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: bucket.storage,
      audioUrls: bucket.urls,
      jobs: {
        async enqueue<J extends JobDefinition>(def: J, payload: unknown, opts?: EnqueueOptions) {
          enqueued.push({ job: def.name, payload, ...(opts && { opts }) });
          return "run";
        },
      },
      models: fakeModels().models,
      media: new LocalMedia(),
      transcriber: new FakeTranscriber(),
      hub: null,
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("t".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: true,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      now: () => new Date(),
    };
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", staff);
      await next();
    });
    app.route("/", portalRoutes(d));
    app.route("/", conversationAudioRoutes(d));
    // The API's error handler in one line: platform errors keep their status and detail.
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
  });
  afterAll(async () => {
    bucket.server.stop(true);
    await sql.end();
    await close();
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("initiate issues a participant token that the conversation routes accept", async () => {
    await seed(sql, newId());
    const res = await post(`/api/participant/projects/${PROJECT}/conversations/initiate`, {
      name: "P",
      pin: "",
    });
    expect(res.status).toBe(200);
    const token = res.headers.get("x-participant-token") as string;
    const { id } = (await res.json()) as { id: string };
    const ok = await app.request(`/api/participant/projects/${PROJECT}/conversations/${id}`, {
      headers: { "x-participant-token": token },
    });
    expect(ok.status).toBe(200);
    const forged = await app.request(`/api/participant/projects/${PROJECT}/conversations/${id}`, {
      headers: { "x-participant-token": `${token.slice(0, -2)}xx` },
    });
    expect(forged.status).toBe(403);
  });

  test("replies: oldest first, only through the conversation's own project", async () => {
    const conv = newId();
    await seed(sql, conv);
    await sql`insert into conversation_reply (id, conversation_id, content_text, type, date_created)
      values (${newId()}, ${conv}, 'second', 'assistant_reply', '2026-09-27T10:05:00Z'),
             (${newId()}, ${conv}, 'first', 'assistant_reply', '2026-09-27T10:00:00Z')`;
    const res = await app.request(
      `/api/participant/projects/${PROJECT}/conversations/${conv}/replies`,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { content_text: string; date_created: string }[];
    expect(rows.map((r) => r.content_text)).toEqual(["first", "second"]);
    expect(rows[0]?.date_created).toBe("2026-09-27T10:00:00.000Z");
    const elsewhere = await app.request(
      `/api/participant/projects/${newId()}/conversations/${conv}/replies`,
    );
    expect(elsewhere.status).toBe(404);
  });

  test("a presigned form upload is confirmed into a chunk; one under 1 KB is marked unplayable", async () => {
    const cid = newId();
    await seed(sql, cid);
    const url = await post(`/api/participant/conversations/${cid}/get-upload-url`, {
      filename: "rec.webm",
      content_type: "audio/webm",
      conversation_id: cid,
    });
    expect(url.status).toBe(200);
    const issued = (await url.json()) as {
      chunk_id: string;
      upload_url: string;
      fields: Record<string, string>;
      file_url: string;
    };
    expect(issued.file_url).toBe(
      bucket.urls.fileUrl(`conversation/${cid}/chunks/${issued.chunk_id}-rec.webm`),
    );
    const form = new FormData();
    for (const [k, v] of Object.entries(issued.fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(5000)], { type: "audio/webm" }), "rec.webm");
    expect((await fetch(issued.upload_url, { method: "POST", body: form })).status).toBe(204);
    const done = await post(`/api/participant/conversations/${cid}/confirm-upload`, {
      chunk_id: issued.chunk_id,
      file_url: issued.file_url,
      timestamp: new Date().toISOString(),
    });
    expect(done.status).toBe(200);

    const small = (await (
      await post(`/api/participant/conversations/${cid}/get-upload-url`, {
        filename: "tiny.webm",
        content_type: "audio/webm",
        conversation_id: cid,
      })
    ).json()) as typeof issued;
    const f2 = new FormData();
    for (const [k, v] of Object.entries(small.fields)) f2.append(k, v);
    f2.append("file", new Blob([new Uint8Array(100)]), "tiny.webm");
    await fetch(small.upload_url, { method: "POST", body: f2 });
    const tiny = await post(`/api/participant/conversations/${cid}/confirm-upload`, {
      chunk_id: small.chunk_id,
      file_url: small.file_url,
      timestamp: new Date().toISOString(),
    });
    expect(tiny.status).toBe(200);
    const rows =
      await sql`select path, error from conversation_chunk where conversation_id = ${cid} order by created_at`;
    expect(rows.map((r) => r.error)).toEqual([null, "Audio not playable"]);
    const probe = await post(`/api/participant/conversations/${cid}/check-s3`, {});
    const { probe_url } = (await probe.json()) as { probe_url: string };
    expect(
      (
        await fetch(probe_url, {
          method: "PUT",
          body: "probe",
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(200);
  });

  test("the first play merges the chunks; later plays reuse the merged file; retranscribe clones it", async () => {
    const cid = newId();
    await seed(sql, cid);
    for (const [i, name] of ["a.webm", "b.mp3"].entries()) {
      const key = `conversation/${cid}/chunks/${newId()}-${name}`;
      const codec = name.endsWith("mp3") ? ["-c:a", "libmp3lame"] : ["-c:a", "libopus"];
      await bucket.storage.put(key, await tone(join(bucket.root, `m${i}-${name}`), 2, codec));
      await sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source)
        values (${newId()}, ${cid}, now() + ${`${i} seconds`}::interval, ${bucket.urls.fileUrl(key)}, 'PORTAL_AUDIO')`;
    }
    const first = await app.request(
      `/api/conversations/${cid}/content?return_url=true&signed=false`,
    );
    expect(first.status).toBe(200);
    const merged = (await first.json()) as string;
    expect(merged).toContain(`audio-conversations/merged-${cid}-`);
    const [row] = await sql`select merged_audio_path, duration from conversation where id = ${cid}`;
    expect(row?.merged_audio_path).toBe(merged);
    expect(Number(row?.duration)).toBeGreaterThan(3.5);
    const again = await app.request(
      `/api/conversations/${cid}/content?return_url=true&signed=false`,
    );
    expect(await again.json()).toBe(merged);
    const redirect = await app.request(`/api/conversations/${cid}/content`);
    expect(redirect.status).toBe(307);
    expect(
      await (await fetch(redirect.headers.get("location") as string)).arrayBuffer(),
    ).toBeTruthy();

    const clone = await post(`/api/conversations/${cid}/retranscribe`, {
      new_conversation_name: "Again",
    });
    const body = (await clone.json()) as { status: string; new_conversation_id: string };
    expect(body.status).toBe("success");
    const [c] =
      await sql`select source, is_finished, participant_name, merged_audio_path from conversation where id = ${body.new_conversation_id}`;
    expect(c).toMatchObject({ source: "CLONE", is_finished: true, participant_name: "Again" });
    const links =
      await sql`select link_type from conversation_link where target_conversation_id = ${body.new_conversation_id}`;
    expect(links.map((l) => l.link_type)).toEqual(["CLONE"]);
  });
});
