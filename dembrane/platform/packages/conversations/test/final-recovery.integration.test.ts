import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import { Queue } from "@dembrane/queue";
import postgres from "postgres";
import { bffStore } from "../src/bff/storage";
import { finalTranscript } from "../src/pipeline/defs";
import { currentChunkHash } from "../src/pipeline/final";
import { bursts } from "./final-helpers";
import { PLANTED, REDACTED } from "./final-route-helpers";
import { admin, freshDatabase, quiet, tracer, until } from "./pipeline-harness";

// A Google final pass whose worker dies in the middle of it and whose project moves to Scaleway
// before another worker takes the run over. The recovered run must end the way a live move
// does: Whisper's transcript through the Scaleway run, or the live text with the gave-up mark.
// It must never end silently, and it must never send a request to Vertex again.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;
const fixture = new URL("./fixtures/final-worker.ts", import.meta.url).pathname;

run("a final pass recovered after its project left Google", () => {
  setDefaultTimeout(180_000);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const root = mkdtempSync(join(tmpdir(), "echo-final-recovery-"));
  const trace = join(root, "trace.log");
  let url: string;
  let sql: postgres.Sql;
  let client: Queue;
  let close: () => Promise<void>;
  let db: ReturnType<typeof createDb>["db"];

  const lines = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean);
  const spawn = (executor: string, env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bun", fixture], {
      env: {
        ...process.env,
        QUEUE_URL: url,
        TRACE_FILE: trace,
        EXECUTOR: executor,
        BUCKET_ROOT: root,
        ...env,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(p);
    return p;
  };

  beforeAll(async () => {
    writeFileSync(trace, "");
    url = await freshDatabase("conv_final_recovery");
    sql = postgres(url, { max: 2, onnotice: () => {} });
    ({ db, close } = createDb({ url, poolMax: 2 }));
    // The test process only enqueues, like the API.
    client = new Queue(url, quiet, tracer);
    await client.start([finalTranscript]);
  });
  // Only the worker a test starts may take its run: a worker left over would run the next one.
  afterEach(async () => {
    for (const p of procs.splice(0)) {
      p.kill(9);
      await p.exited;
    }
  });
  afterAll(async () => {
    await client?.stop();
    await sql?.end();
    await close?.();
  });

  /** A finished conversation of a project on Google: its live text in place and its recording in the bucket. */
  async function conversation(anonymised: boolean) {
    const orgId = newId();
    await sql`insert into org (id, name, ai_providers, ai_default_provider)
      values (${orgId}, 'o', array['scaleway','google'], 'scaleway')`;
    const accountId = newId();
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = newId();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    const projectId = newId();
    await sql`insert into project (id, name, language, is_conversation_allowed, workspace_id, ai_provider)
      values (${projectId}, 'P', 'en', true, ${workspaceId}, 'google')`;
    const id = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, ai_provider, is_anonymized,
        is_finished, is_all_chunks_transcribed, created_at, updated_at)
      values (${id}, ${projectId}, 'T', 'PORTAL_AUDIO', 'google', ${anonymised}, true, true,
        now() - interval '1 hour', now())`;
    for (let n = 0; n < 2; n++) {
      const chunkId = newId();
      const key = `conversation/${id}/chunks/${chunkId}-rec${n}.mp3`;
      mkdirSync(dirname(join(root, key)), { recursive: true });
      const audio = await bursts(join(root, `r${n}-${id}.mp3`), 3);
      await Bun.write(join(root, key), audio);
      await sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source, transcript)
        values (${chunkId}, ${id}, ${new Date(Date.now() + n * 1000)}, ${`http://audio.test/local/${key}`},
          'PORTAL_AUDIO', 'live')`;
    }
    return { id, projectId };
  }

  const finals = (id: string) =>
    sql`select provider, text, sentences, raw_sentences from conversation_final_transcript where conversation_id = ${id}`;
  const gaveUp = async (id: string) =>
    (
      await sql`select 1 from processing_status where conversation_id = ${id} and event = 'task_final_transcript.gave_up'`
    ).length;
  const improving = (id: string) => bffStore(db).finalQueued(id);
  const liveText = async (id: string) =>
    (await sql`select transcript from conversation_chunk where conversation_id = ${id}`).map(
      (r) => r.transcript,
    );
  const vertexBy = (who: string) => lines().filter((l) => l.startsWith(`${who} vertex `)).length;

  /**
   * Worker `a` starts the Google pass and is killed inside its second Vertex request, after the
   * first piece was recorded. The project moves to Scaleway, then worker `b` starts and takes
   * the run over.
   */
  async function crashAndRecover(
    c: { id: string; projectId: string },
    tag: string,
    env: Record<string, string> = {},
  ) {
    const a = `${tag}-a`;
    const b = `${tag}-b`;
    const first = spawn(a, { HANG_AT: "2" });
    await until(async () => lines().includes(`${a} ready`));
    await client.enqueue(finalTranscript, {
      conversationId: c.id,
      provider: "gemini",
      record: true,
      hash: await currentChunkHash({ db }, c.id),
    });
    await until(async () => lines().includes(`${a} hung`));
    await sql`update project set ai_provider = 'scaleway' where id = ${c.projectId}`;
    first.kill(9);
    await first.exited;
    spawn(b, env);
    return { a, b };
  }

  test("a Google pass killed mid-pass and recovered after the move is finished by Whisper", async () => {
    const c = await conversation(false);
    const { a, b } = await crashAndRecover(c, "whisper");
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
    expect(String(rows[0]?.text)).toContain("whisper heard this");
    // Both Vertex requests were the first worker's, before the move; the second sent none.
    expect(vertexBy(a)).toBe(2);
    expect(vertexBy(b)).toBe(0);
    await until(async () => !(await improving(c.id)));
    expect(await gaveUp(c.id)).toBe(0);
  });

  test("recovered after a move to a provider with no final pass it gives up to the live text", async () => {
    const c = await conversation(false);
    const { a, b } = await crashAndRecover(c, "nofinal", { NO_FINAL: "scaleway" });
    await until(async () => (await gaveUp(c.id)) && !(await improving(c.id)));
    expect(await finals(c.id)).toHaveLength(0);
    expect(await liveText(c.id)).toEqual(["live", "live"]);
    expect(await gaveUp(c.id)).toBe(1);
    expect(vertexBy(a)).toBe(2);
    expect(vertexBy(b)).toBe(0);
  });

  test("an anonymised pass recovered after the move is redacted and shows nothing the speaker said", async () => {
    const c = await conversation(true);
    const { b } = await crashAndRecover(c, "anon");
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
    expect(rows[0]?.text).toBe(REDACTED);
    expect(rows[0]?.sentences).toBeNull();
    for (const secret of PLANTED) expect(JSON.stringify(rows)).not.toContain(secret);
    expect(vertexBy(b)).toBe(0);
  });
});
