import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  advanceMapView,
  analysisRuntime,
  clientOf,
  execute,
  type Json,
  MapViewReads,
  requestRun,
} from "@echo/analysis";
import { createDb } from "@echo/db";
import { FakeCompleter, FakeEmbedder } from "@echo/llm";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import postgres from "postgres";
import { mapFactCheck } from "../src/factcheck";
import * as service from "../src/service";
import { MapStore } from "../src/store";

/**
 * A fact-check survives its worker: worker A dies inside the search-grounded call; worker B
 * resumes the workflow at that step, without loading the check again, and writes the
 * verdict for the same attempt.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = "parity_template_platform";
const DB = `map_recovery_${process.pid}`;
const hasTemplate = admin
  ? await (async () => {
      const sql = postgres(admin, { max: 1, onnotice: () => {} });
      const [row] = await sql`select 1 from pg_database where datname = ${TEMPLATE}`;
      await sql.end();
      return Boolean(row);
    })().catch(() => false)
  : false;
const run = hasTemplate ? describe : describe.skip;
const P1 = "f0000000-0000-4000-8000-000000000001";
const trace = join(tmpdir(), `map-recovery-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const lines = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean);
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

async function until(check: () => boolean | Promise<boolean>, ms = 45_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(200);
  }
}

run("fact-check recovery", () => {
  setDefaultTimeout(90_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(async () => {
    for (const p of procs) p.kill(9);
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  test("a check on a killed worker finishes elsewhere for the same attempt", async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    writeFileSync(trace, "");

    // A map with one claim, made in-process with a fake extractor.
    const database = createDb({ url, poolMax: 4 });
    const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });
    const queue = new Queue(url, quiet, tracer, { maxConnections: 2 });
    await queue.start([mapFactCheck]);
    const extractor = new FakeCompleter()
      .on(
        "charging points",
        JSON.stringify({
          items: [
            {
              kind: "claim",
              statement: "Charging waits are months long.",
              evidence: ["the waiting list is months long"],
              valence: "negative",
            },
          ],
        }),
      )
      .on("cycle lanes", JSON.stringify({ items: [] }));
    const rt = analysisRuntime({
      db: database.db,
      logger: quiet,
      completer: extractor,
      embedder: new FakeEmbedder(8),
      jobs: queue,
      config: { embeddingModel: "text-embedding-004", embeddingLocation: "europe-west4" },
    });
    const requested = await requestRun(
      { projectId: P1, recipeId: "arguments", scopeKey: "project" },
      { ...rt.executor, dispatchRun: null },
    );
    expect(await execute(rt.executor, requested.run.id, "lease-x")).toBe("ready");
    const snapshot = await advanceMapView(P1, rt.store, new MapViewReads(rt.store), {
      publish: rt.publishMap,
    });
    const claimId = String(((snapshot?.manifest.objects as Json[]) ?? [])[0]?.revisionId);

    const worker = (executor: string, env: Record<string, string>) =>
      Bun.spawn(["bun", fixture], {
        env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, ...env },
        stdout: "ignore",
        stderr: "ignore",
      });
    const first = worker("worker-a", { HANG: "1" });
    procs.push(first);
    await until(() => lines().includes("worker-a ready"));

    const store = new MapStore(clientOf(database.db));
    const started = await service.startFactCheck(
      {
        store,
        rt,
        dispatch: (job) =>
          queue.enqueue(mapFactCheck, job, { singletonKey: `${job.factCheckId}:${job.attempt}` }),
      },
      { kind: "snapshot", snapshot: snapshot as NonNullable<typeof snapshot>, resultId: null },
      claimId,
      "tester",
      false,
    );
    expect(started.status).toBe("processing");
    await until(() => lines().includes("worker-a investigate"));
    first.kill(9);

    const second = worker("worker-b", {});
    procs.push(second);
    await until(() => lines().some((l) => l.startsWith("worker-b finished")));
    expect(lines().filter((l) => !l.endsWith("ready"))).toEqual([
      "worker-a load",
      "worker-a investigate",
      "worker-b investigate",
      "worker-b classify",
      // The record step reads the finished check to record it as an assessment.
      "worker-b load",
      "worker-b finished done",
    ]);
    const rows = await clientOf(database.db)`select status, verdict, attempt from map_fact_check`;
    expect([...rows]).toEqual([{ status: "done", verdict: "false", attempt: 1 }]);
    await queue.stop();
    await database.close();
  });
});
