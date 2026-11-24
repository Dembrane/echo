import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import type { SpeechRouter } from "../src";
import { bffStore } from "../src/bff/storage";
import { finalTranscript } from "../src/pipeline/defs";
import { currentChunkHash } from "../src/pipeline/final";
import { bursts } from "./final-helpers";
import {
  PLANTED,
  REDACTED,
  routedWorker,
  stubbedRouter,
  withoutFinal,
} from "./final-route-helpers";
import { admin, freshDatabase, type Harness, until } from "./pipeline-harness";

// The final pass of a project on Google, moved to Scaleway while it runs: nothing is sent to
// Vertex after the move, whichever call of the pass would have gone there next.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("a final pass whose project leaves Google", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  const routed = stubbedRouter();
  const { wire, vertex } = routed;
  let router: SpeechRouter;

  beforeAll(async () => {
    ({ router } = routed);
    h = await routedWorker(router, await freshDatabase("conv_final_route"));
  });
  afterAll(async () => {
    await h?.stop();
  });

  /** A finished conversation of a project on Google, its live text in place and its recording in the bucket. */
  async function conversation(anonymised: boolean) {
    const orgId = newId();
    await h.sql`insert into org (id, name, ai_providers, ai_default_provider)
      values (${orgId}, 'o', array['scaleway','google'], 'scaleway')`;
    const accountId = newId();
    await h.sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = newId();
    await h.sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    const projectId = newId();
    await h.sql`insert into project (id, name, language, is_conversation_allowed, workspace_id, ai_provider)
      values (${projectId}, 'P', 'en', true, ${workspaceId}, 'google')`;
    const id = newId();
    await h.sql`insert into conversation (id, project_id, participant_name, source, ai_provider, is_anonymized,
        is_finished, is_all_chunks_transcribed, created_at, updated_at)
      values (${id}, ${projectId}, 'T', 'PORTAL_AUDIO', 'google', ${anonymised}, true, true,
        now() - interval '1 hour', now())`;
    for (let n = 0; n < 2; n++) {
      const chunkId = newId();
      const key = `conversation/${id}/chunks/${chunkId}-rec${n}.mp3`;
      await h.deps.audio.put(key, await bursts(join(h.bucket.root, `r${n}-${id}.mp3`), 3));
      await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source, transcript)
        values (${chunkId}, ${id}, ${new Date(Date.now() + n * 1000)}, ${h.deps.audioUrls.fileUrl(key)},
          'PORTAL_AUDIO', 'live')`;
    }
    return { id, projectId };
  }
  const toScaleway = (projectId: string) => () =>
    h.sql`update project set ai_provider = 'scaleway' where id = ${projectId}`;
  const startFinal = async (id: string) =>
    h.queue.enqueue(finalTranscript, {
      conversationId: id,
      provider: "gemini",
      record: true,
      hash: await currentChunkHash(h.deps, id),
    });
  const finals = (id: string) =>
    h.sql`select provider, text, sentences, raw_sentences, usage from conversation_final_transcript where conversation_id = ${id}`;
  const gaveUp = async (id: string) =>
    (
      await h.sql`select 1 from processing_status where conversation_id = ${id} and event = 'task_final_transcript.gave_up'`
    ).length;
  /** The dashboard says a final transcript is on its way while a pass is queued or running. */
  const improving = (id: string) => bffStore(h.deps.db).finalQueued(id);
  const liveText = async (id: string) =>
    (await h.sql`select transcript from conversation_chunk where conversation_id = ${id}`).map(
      (r) => r.transcript,
    );
  const vertexRequests = () => wire.seen.vertex.length;
  const whisperRequests = () =>
    wire.seen.compat.filter((r) => r.url.endsWith("/audio/transcriptions")).length;

  test("a pass that stays on Google reads every piece there", async () => {
    const c = await conversation(false);
    const before = vertexRequests();
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    expect(rows.map((r) => r.provider)).toEqual(["gemini"]);
    // Several pieces; the next test moves the project after the first.
    expect(vertexRequests() - before).toBeGreaterThanOrEqual(3);
  });

  test("a move at the second piece sends no piece, retry or fallback to Vertex after it, and Scaleway finishes", async () => {
    const c = await conversation(false);
    const before = vertexRequests();
    const whisperBefore = whisperRequests();
    vertex.after = async (n) => {
      if (n === before + 1) await toScaleway(c.projectId)();
    };
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    vertex.after = () => Promise.resolve();
    // Only the first piece reached Vertex; the transcript people read is Whisper's.
    expect(vertexRequests() - before).toBe(1);
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
    expect(String(rows[0]?.text)).toContain("whisper heard this");
    expect(whisperRequests() - whisperBefore).toBeGreaterThanOrEqual(1);
  });

  test("a move while a piece is retried sends no second attempt and no fast-model fallback to Vertex", async () => {
    const c = await conversation(false);
    const before = vertexRequests();
    vertex.status = 429;
    vertex.after = async (n) => {
      if (n === before + 1) await toScaleway(c.projectId)();
    };
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    vertex.status = null;
    vertex.after = () => Promise.resolve();
    expect(vertexRequests() - before).toBe(1);
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
  });

  test("a move after the last piece sends the redaction of an anonymised conversation nowhere near Vertex", async () => {
    const c = await conversation(true);
    // Every piece is read on Google; the project moves as the last one is answered.
    const probe = await conversation(false);
    const sizing = vertexRequests();
    await startFinal(probe.id);
    await until(async () => (await finals(probe.id)).length || null);
    const pieces = vertexRequests() - sizing;
    expect(pieces).toBeGreaterThanOrEqual(3);

    const before = vertexRequests();
    vertex.after = async (n) => {
      if (n === before + pieces) await toScaleway(c.projectId)();
    };
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    vertex.after = () => Promise.resolve();
    // The pieces went to Vertex; neither the text pass nor the redaction did.
    expect(vertexRequests() - before).toBe(pieces);
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
    // Scaleway redacted what Whisper heard: nothing the speaker said is stored, in the text
    // or anywhere beside it, and no sentences are kept that would show it.
    expect(rows[0]?.text).toBe(REDACTED);
    expect(rows[0]?.sentences).toBeNull();
    expect(rows[0]?.raw_sentences).toBeNull();
    for (const secret of PLANTED) expect(JSON.stringify(rows)).not.toContain(secret);
  });

  test("a move to a provider with no final pass keeps the live text, gives up, and stops saying a transcript is coming", async () => {
    const restore = withoutFinal(router, "scaleway");
    try {
      const c = await conversation(false);
      const before = vertexRequests();
      vertex.after = async (n) => {
        if (n === before + 1) await toScaleway(c.projectId)();
      };
      await startFinal(c.id);
      await until(async () => (await gaveUp(c.id)) && !(await improving(c.id)));
      vertex.after = () => Promise.resolve();
      expect(await finals(c.id)).toHaveLength(0);
      expect(await liveText(c.id)).toEqual(["live", "live"]);
      expect(vertexRequests() - before).toBe(1);
      expect(await gaveUp(c.id)).toBe(1);
    } finally {
      restore();
    }
  });
});
