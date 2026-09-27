import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@echo/access";
import { createDb } from "@echo/db";
import type { Signed } from "@echo/http";
import { createLogger } from "@echo/observability";
import postgres from "postgres";
import { runCreateLibrary, runCreateView } from "../src/jobs";
import { exportTranscripts, type ProjectDeps } from "../src/projects";
import { createReport } from "../src/reports";
import { projectsStorage } from "../src/storage";
import { unzip } from "../src/zip";

/**
 * Runs against a copy of the parity seed (parity/prepare-platform-template.sh builds it):
 * the paths parity cannot compare byte for byte (the transcript zip) and the jobs, which
 * the Python ran in a worker the parity stack does not start.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = "parity_template_platform";
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
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("projects against the seed", () => {
  setDefaultTimeout(20_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: ProjectDeps;
  const enqueued: { name: string; payload: unknown; inTx: boolean }[] = [];
  const now = new Date("2026-09-27T12:00:00Z");

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists projects_test with (force)");
    await a.unsafe(`create database projects_test template ${TEMPLATE}`);
    await a.end();
    database = createDb({ url: `${base}/projects_test`, poolMax: 4 });
    sql = postgres(`${base}/projects_test`, { max: 1, onnotice: () => {} });
    d = {
      store: projectsStorage(database.db),
      access: new Access(new DrizzleAccessStore(database.db)),
      jobs: {
        async enqueue(def, payload, opts) {
          enqueued.push({ name: def.name, payload, inTx: Boolean(opts?.tx) });
          return "job-1";
        },
      },
      now: () => now,
    };
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  test("transcript export: one markdown file per transcribed conversation", async () => {
    const out = await exportTranscripts(d, alice, p1);
    expect(out.filename).toBe("City_listening_2026_transcripts.zip");
    const files = unzip(out.body);
    expect(files).toHaveLength(2);
    const byName = Object.fromEntries(
      files.map((f) => [f.name.replace(/^\d{8}_\d{6}_/, ""), new TextDecoder().decode(f.data)]),
    );
    expect(byName["Resident_1_c1000000-transcript.md"]).toBe(
      "We need more charging points near the flats, the waiting list is months long.\nBuses stop running at eleven, so people drive even when they would rather not.\nHeat pumps are fine but the grid connection took our street a year.\n",
    );
    expect(byName["Resident_2_c1000000-transcript.md"]).toBe(
      "Typed answer: the cycle lanes end abruptly at the ring road.\n",
    );
  });

  test("create report: the generation job is enqueued inside the report's transaction", async () => {
    enqueued.length = 0;
    const row = await createReport(d, alice, p1, {
      language: "en",
      user_instructions: null,
      scheduled_at: null,
    });
    expect(row.status).toBe("draft");
    expect(enqueued).toEqual([
      {
        name: "reports.generate",
        payload: { projectId: p1, reportId: Number(row.id), language: "en", userInstructions: "" },
        inTx: true,
      },
    ]);
  });

  test("library job: records a run once, even when retried, and its finishing status", async () => {
    const runId = id("f3", 7);
    await runCreateLibrary(
      { store: d.store, logger: quiet, now: () => now },
      {
        projectId: p1,
        runId,
        language: "en",
      },
    );
    await runCreateLibrary(
      { store: d.store, logger: quiet, now: () => now },
      {
        projectId: p1,
        runId,
        language: "en",
      },
    );
    const runs = await sql`select id from project_analysis_run where id = ${runId}`;
    expect(runs).toHaveLength(1);
    const statuses = await sql`
      select event, message from processing_status where project_id = ${p1} order by id`;
    expect(statuses.map((s) => s.event)).toEqual([
      "task_create_project_library.completed",
      "task_create_project_library.completed",
    ]);
    expect(statuses[0]?.message).toBe(`Successfully created library: ${runId}`);
  });

  test("view job: records that views are no longer generated", async () => {
    const runId = id("f3", 7);
    await runCreateView(
      { store: d.store, logger: quiet },
      {
        analysisRunId: runId,
        query: "buses",
        context: "",
        language: "en",
      },
    );
    const [row] = await sql`
      select event, message, project_id from processing_status
      where project_analysis_run_id = ${runId}`;
    expect(row).toMatchObject({
      event: "task_create_view.completed",
      message: "Topic modeler integration has been removed; skipping view creation.",
      project_id: p1,
    });
  });
});
