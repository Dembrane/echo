import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@echo/core";
import { Queue } from "@echo/queue";
import postgres from "postgres";
import { finishConversation, processChunk } from "../src/pipeline/defs";
import { admin, freshDatabase, quiet, seed, tone, tracer, until } from "./pipeline-harness";

// The crash test ADR 0007 promises for the pipeline: a worker killed with SIGKILL in the
// middle of transcribing resumes on another worker at that step, without converting the
// audio again, and the conversation still finalizes.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;
const fixture = new URL("./fixtures/pipeline-worker.ts", import.meta.url).pathname;

run("pipeline crash recovery", () => {
  setDefaultTimeout(120_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill(9);
  });

  test("a chunk run killed inside transcription resumes elsewhere at that step", async () => {
    const url = await freshDatabase("conv_pipeline_crash");
    const root = mkdtempSync(join(tmpdir(), "echo-crash-"));
    const trace = join(root, "trace.log");
    writeFileSync(trace, "");
    const lines = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean);
    const spawn = (executor: string, env: Record<string, string> = {}) => {
      const p = Bun.spawn(["bun", fixture], {
        env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, BUCKET_ROOT: root, ...env },
        stdout: "ignore",
        stderr: "ignore",
      });
      procs.push(p);
      return p;
    };

    const sql = postgres(url, { max: 2, onnotice: () => {} });
    const cid = newId();
    const chunkId = newId();
    await seed(sql, cid);
    const key = `conversation/${cid}/chunks/${chunkId}-rec.webm`;
    await tone(join(root, key.replaceAll("/", "_")), 2);
    await Bun.write(join(root, key), Bun.file(join(root, key.replaceAll("/", "_"))));
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source)
      values (${chunkId}, ${cid}, now(), ${`http://audio.test/local/${key}`}, 'PORTAL_AUDIO')`;

    // The test process only enqueues (a DBOS client), like the API.
    const client = new Queue(url, quiet, tracer);
    await client.start([processChunk, finishConversation]);

    const first = spawn("worker-a", { HANG: "1" });
    await until(async () => lines().includes("worker-a ready"));
    await client.enqueue(processChunk, { chunkId, usePiiRedaction: false }, { workflowId: `conversations.chunk:${chunkId}` });
    await until(async () => lines().includes("worker-a transcribe start"));
    first.kill(9);

    spawn("worker-b");
    await until(async () => {
      const [row] = await sql`select transcript from conversation_chunk where conversation_id = ${cid}`;
      return row?.transcript;
    });
    expect(lines().filter((l) => !l.endsWith("ready"))).toEqual([
      "worker-a convert",
      "worker-a transcribe start",
      "worker-b transcribe start",
      "worker-b transcribe done",
    ]);

    await client.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const [c] = await until(async () => {
      const rows = await sql`select * from conversation where id = ${cid} and summary is not null and merged_audio_path is not null`;
      return rows.length ? rows : null;
    });
    expect(c?.is_all_chunks_transcribed).toBe(true);
    await client.stop();
    await sql.end();
  });
});
