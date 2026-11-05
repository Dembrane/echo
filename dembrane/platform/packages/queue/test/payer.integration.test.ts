import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { migrate } from "@dembrane/db";
import { createLogger, initTracing, type Payer, payer, withPayer } from "@dembrane/observability";
import postgres from "postgres";
import { z } from "zod";
import { defineJob, installQueueSchema, Queue, startWorkflow, step, workflow } from "../src";
import { paidWorkflow } from "./fixtures/payer-jobs";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const base = admin ? admin.slice(0, admin.lastIndexOf("/")) : "";
const PROJECT = "a1000000-0000-4000-8000-000000000001";

setDefaultTimeout(60_000);

const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });

async function freshDatabase(name: string): Promise<string> {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name}`);
  await a.end();
  const url = `${base}/${name}`;
  await migrate(url, { appEnv: "test" });
  await installQueueSchema(url);
  return url;
}

async function until(check: () => boolean, ms = 30_000, what = () => "") {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out ${what()}`);
    await Bun.sleep(50);
  }
}

const byProject = z.object({ projectId: z.string() });
const paidJob = defineJob("test.payer-job", byProject, {
  retryLimit: 0,
  payer: (p) => ({ ref: "project", id: p.projectId }),
});
const paidFlow = defineJob("test.payer-flow", byProject, {
  retryLimit: 0,
  payer: (p) => ({ ref: "project", id: p.projectId }),
});
const unpaidJob = defineJob("test.payer-none", byProject, { retryLimit: 0 });
const nullPayer = defineJob("test.payer-null", byProject, { retryLimit: 0, payer: () => null });

run("jobs run under their payer", () => {
  let queue: Queue;
  const seen = new Map<string, Payer | undefined>();
  const standalone = workflow(
    "test.payer-standalone-local",
    (id: string) => step("model", async () => void seen.set(`standalone:${id}`, payer())),
    { payer: (id) => ({ ref: "agent_run", id }) },
  );

  beforeAll(async () => {
    const url = await freshDatabase("queue_payer_test");
    queue = new Queue(url, quiet, tracer, { pollingIntervalMs: 50 });
    await queue.start([paidJob, paidFlow, unpaidJob, nullPayer]);
    await queue.work(paidJob, { concurrency: 1 }, async (p) => {
      seen.set(`job:${p.projectId}`, payer());
    });
    await queue.workflow(paidFlow, { concurrency: 1 }, async (p) => {
      await step("model", async () => {
        seen.set(`flow:${p.projectId}`, payer());
      });
    });
    await queue.work(unpaidJob, { concurrency: 1 }, async (p) => {
      seen.set(`none:${p.projectId}`, payer());
    });
    await queue.work(nullPayer, { concurrency: 1 }, async (p) => {
      seen.set(`null:${p.projectId}`, payer());
    });
    await queue.run();
  });
  afterAll(async () => {
    await queue?.stop();
  });

  test("a job's handler runs under the payer its definition names", async () => {
    await queue.enqueue(paidJob, { projectId: PROJECT });
    await until(() => seen.has(`job:${PROJECT}`));
    expect(seen.get(`job:${PROJECT}`)).toEqual({ ref: "project", id: PROJECT });
  });

  test("a workflow's step runs under the payer its definition names", async () => {
    await queue.enqueue(paidFlow, { projectId: PROJECT });
    await until(() => seen.has(`flow:${PROJECT}`));
    expect(seen.get(`flow:${PROJECT}`)).toEqual({ ref: "project", id: PROJECT });
  });

  test("a job without a payer does not inherit the enqueuer's", async () => {
    await withPayer({ internal: "enqueuer" }, () =>
      Promise.all([
        queue.enqueue(unpaidJob, { projectId: PROJECT }),
        queue.enqueue(nullPayer, { projectId: PROJECT }),
      ]),
    );
    await until(() => seen.has(`none:${PROJECT}`) && seen.has(`null:${PROJECT}`));
    expect(seen.get(`none:${PROJECT}`)).toBeUndefined();
    expect(seen.get(`null:${PROJECT}`)).toBeUndefined();
  });

  test("a standalone workflow's step runs under the payer its options name", async () => {
    await (
      await startWorkflow(standalone, "standalone-1", paidJob.name)("standalone-1")
    ).getResult();
    expect(seen.get("standalone:standalone-1")).toEqual({ ref: "agent_run", id: "standalone-1" });
  });
});

const trace = join(tmpdir(), `echo-payer-recovery-${Date.now()}.log`);
const fixture = new URL("./fixtures/payer-worker.ts", import.meta.url).pathname;
const traceLines = () => readFileSync(trace, "utf8").trim().split("\n");

run("a recovered workflow runs under its payer again", () => {
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterEach(() => {
    for (const p of procs.splice(0)) p.kill(9);
  });

  test("a run resumed on another worker sees its payer in the step it resumes", async () => {
    const url = await freshDatabase("queue_payer_recovery_test");
    writeFileSync(trace, "");
    const spawn = (executor: string, env: Record<string, string>) => {
      const p = Bun.spawn(["bun", fixture], {
        env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, ...env },
        stdout: "ignore",
        stderr: "ignore",
      });
      procs.push(p);
      return p;
    };
    const has = (line: string) => traceLines().includes(line);
    const client = new Queue(url, quiet, tracer);
    try {
      await client.start([paidWorkflow]);
      await client.enqueue(paidWorkflow, { projectId: PROJECT }, { workflowId: "paid-1" });
      const first = spawn("worker-a", { START: "1", HANG: "1" });
      const read = () => readFileSync(trace, "utf8");
      await until(
        () =>
          has(`worker-a second start ${PROJECT} project:${PROJECT}`) &&
          has("worker-a second start run-1 agent_run:run-1"),
        30_000,
        read,
      );
      first.kill(9);

      spawn("worker-b", {});
      await until(
        () =>
          has(`worker-b finished ${PROJECT} project:${PROJECT}`) &&
          has("worker-b finished run-1 agent_run:run-1"),
        30_000,
        read,
      );
      expect(traceLines().filter((l) => l.startsWith("worker-b second"))).toEqual(
        expect.arrayContaining([
          `worker-b second start ${PROJECT} project:${PROJECT}`,
          "worker-b second start run-1 agent_run:run-1",
        ]),
      );
    } finally {
      await client.stop();
    }
  });
});
