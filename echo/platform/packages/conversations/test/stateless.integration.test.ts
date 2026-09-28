import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import type { Media } from "@dembrane/audio";
import { PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { FakeTranscriber, TranscriptParseError } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import { AudioUrls } from "../src/audio-urls";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { statelessRoutes } from "../src/stateless/routes";

/**
 * Stateless transcription end to end against a copy of the parity seed, with the local
 * bucket, a fake transcriber and a fake media probe: the parity stack has neither an
 * object store nor model credentials, so parity only compares the gates.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = process.env.PARITY_TEMPLATE ?? "parity_template_platform";
const DB = "conv_verify_stateless_test";
const base = admin ? admin.slice(0, admin.lastIndexOf("/")) : "";
const hasTemplate = admin
  ? await (async () => {
      const sql = postgres(admin, { max: 1, onnotice: () => {} });
      const [row] = await sql`select 1 from pg_database where datname = ${TEMPLATE}`;
      await sql.end();
      return Boolean(row);
    })().catch(() => false)
  : false;
const run = hasTemplate ? describe : describe.skip;

const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const alice: Signed = { appUserId: id("a0", 2), directusUserId: id("d0", 2), isStaff: false };
const p1 = id("f0", 1);
const c1 = id("c1", 1);
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("stateless transcription against the seed", () => {
  setDefaultTimeout(20_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;
  let root: string;
  const transcriber = new FakeTranscriber(() => "hello from the note");
  const probed: string[] = [];

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    database = createDb({ url: `${base}/${DB}`, poolMax: 4 });
    sql = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    root = mkdtempSync(join(tmpdir(), "conv-stateless-"));
    const audio = new FilesystemStorage(root, "http://local.test", "/_local-audio");
    await audio.put(`conversation/${c1}/chunks/old.mp3`, new Uint8Array([9, 9, 9, 9]));
    const media = {
      async probeUrl(url: string) {
        probed.push(url);
        return { format: { duration: "12.5" } };
      },
    } as unknown as Media;
    const d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio,
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      jobs: { enqueue: async () => null },
      models: {} as ConversationsDeps["models"],
      media,
      transcriber,
      hub: null,
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("s".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: true,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      now: () => new Date("2026-09-27T12:00:00Z"),
    } satisfies ConversationsDeps;
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = c.req.header("x-as");
      c.set(
        "principal",
        who === "alice" ? { ...alice } : who === "staff" ? { ...alice, isStaff: true } : null,
      );
      await next();
    });
    app.route("/", statelessRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  const call = (form: Record<string, string | Blob>, as = "alice") => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    return app.request("/api/stateless/transcribe", {
      method: "POST",
      headers: { "x-as": as },
      body: fd,
    });
  };
  const note = () =>
    new File([new Uint8Array([1, 2, 3, 4, 5])], "note.webm", { type: "audio/webm" });

  test("an upload is transcribed, probed, removed, and metered as a deleted conversation", async () => {
    const res = await call({
      project_id: p1,
      file: note(),
      hotwords: "Dembrane, , Sameer",
      language: "nl",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: "hello from the note", note: "" });
    const input = transcriber.calls.at(-1);
    expect(input?.audio.byteLength).toBe(5);
    expect(input?.hotwords).toEqual(["Dembrane", "Sameer"]);
    expect(input?.language).toBe("nl");
    expect(probed.at(-1)).toContain("/_local-audio/stateless-transcription/");
    expect(readdirSync(join(root, "stateless-transcription"))).toEqual([]);
    const rows =
      await sql`select participant_name, source, duration, is_finished, deleted_at is not null as deleted
      from conversation where source = 'STATELESS_TRANSCRIPTION'`;
    expect([...rows]).toEqual([
      {
        participant_name: "Voice note",
        source: "STATELESS_TRANSCRIPTION",
        duration: 12.5,
        is_finished: true,
        deleted: true,
      },
    ]);
  });

  test("a stored chunk of the project is read by key", async () => {
    const res = await call({ project_id: p1, audio_file_uri: `conversation/${c1}/chunks/old.mp3` });
    expect(res.status).toBe(200);
    expect(transcriber.calls.at(-1)?.audio.byteLength).toBe(4);
  });

  test("URLs and keys outside the project are refused (H-6)", async () => {
    expect((await call({ project_id: p1, audio_file_uri: "https://evil.test/a.mp3" })).status).toBe(
      400,
    );
    expect(
      (await call({ project_id: p1, audio_file_uri: `conversation/${id("c1", 3)}/chunks/x.mp3` }))
        .status,
    ).toBe(400);
  });

  test("a purpose alone needs no project and is rate limited per person", async () => {
    for (let i = 0; i < 30; i++)
      expect((await call({ purpose: "issue_report", file: note() })).status).toBe(200);
    expect((await call({ purpose: "issue_report", file: note() })).status).toBe(429);
    // A purpose call is never metered.
    const [row] =
      await sql`select count(*)::int as n from conversation where source = 'STATELESS_TRANSCRIPTION'`;
    expect(row?.n).toBe(2);
  });

  test("a model failure answers 502 and still removes the upload", async () => {
    transcriber.failNext(new TranscriptParseError("Unparseable transcript JSON", "length"));
    const res = await call({ project_id: p1, file: note() });
    expect(res.status).toBe(502);
    expect(readdirSync(join(root, "stateless-transcription"))).toEqual([]);
  });
});
