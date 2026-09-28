import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCompleter } from "@echo/llm";
import { initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import type { Json } from "../src/contracts";
import { requestRun } from "../src/executor";
import { analysisJobs, analysisRuntime } from "../src/runtime";
import { appClient, dropDatabase, freshDatabase, hasTemplate, P1, quiet } from "./harness";

/**
 * The proof that an analysis run survives its worker: worker A is killed with kill -9 while
 * one conversation's extraction is in flight; worker B resumes the workflow at its execute
 * step with the same lease, reuses the extraction A already saved, calls the model only for
 * the unfinished conversation, and publishes.
 */
const DB = `analysis_recovery_${process.pid}`;
const run = (await hasTemplate()) ? describe : describe.skip;
const trace = join(tmpdir(), `analysis-recovery-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const lines = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean);

async function until(check: () => boolean | Promise<boolean>, ms = 45_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(200);
  }
}

run("analysis run recovery", () => {
  setDefaultTimeout(90_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(async () => {
    for (const p of procs) p.kill(9);
    await dropDatabase(DB);
  });

  test("a run on a killed worker resumes elsewhere without paying for finished model steps", async () => {
    const url = await freshDatabase(DB);
    writeFileSync(trace, "");
    const spawn = (executor: string, env: Record<string, string>) =>
      Bun.spawn(["bun", fixture], {
        env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, ...env },
        stdout: "ignore",
        stderr: "ignore",
      });

    const a = spawn("worker-a", { HANG: "cycle lanes" });
    procs.push(a);
    await until(() => lines().includes("worker-a ready"));

    // The API side: request the run, which enqueues the workflow on the shared queue.
    const { sql, close } = appClient(url);
    const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });
    const queue = new Queue(url, quiet, tracer, { maxConnections: 2 });
    await queue.start(analysisJobs);
    const rt = analysisRuntime({
      db: { $client: sql } as never,
      logger: quiet,
      completer: new FakeCompleter((g) => `vertex_ai/fake-${g}`),
      embedder: { model: "m", endpoint: "e", dimensions: 8, embed: async () => [1] },
      jobs: queue,
      config: { embeddingModel: "text-embedding-004", embeddingLocation: "europe-west4" },
    });
    const outcome = await requestRun(
      { projectId: P1, recipeId: "arguments", scopeKey: "project" },
      rt.executor,
    );
    const runId = outcome.run.id;

    // Worker A saved the first conversation's extraction and hangs in the second one.
    await until(async () => {
      const [row] = await sql`select count(*)::int as n from analysis_step
        where run_id = ${runId} and step_key like 'extract:%' and status = 'completed'`;
      return (row?.n ?? 0) >= 1 && lines().includes("worker-a model cycle lanes");
    });
    a.kill(9);

    const b = spawn("worker-b", {});
    procs.push(b);
    await until(async () => {
      const [row] = await sql`select status from analysis_run where id = ${runId}`;
      return row?.status === "ready";
    });

    const models = lines().filter((l) => l.includes(" model "));
    expect(models).toEqual([
      expect.stringMatching(/^worker-a model (charging points|cycle lanes)$/),
      expect.stringMatching(/^worker-a model (charging points|cycle lanes)$/),
      "worker-b model cycle lanes",
    ]);
    expect(models.filter((l) => l === "worker-a model charging points").length).toBe(1);
    const [done] =
      await sql`select output_manifest, metrics, attempt from analysis_run where id = ${runId}`;
    expect((((done?.output_manifest ?? {}) as Json).objects as Json[]).length).toBe(3);
    // The resumed workflow kept its lease: one claim, the same attempt.
    expect(done?.attempt).toBe(1);
    expect(Number(((done?.metrics ?? {}) as Json).stepsResumed ?? 0)).toBeGreaterThanOrEqual(1);
    await queue.stop();
    await close();
  });
});
