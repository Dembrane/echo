import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import { FakeTranscriber } from "@dembrane/transcription";
import { createChunk } from "../src/chunks";
import { finishConversation } from "../src/pipeline/defs";
import { bursts, fakeProvider, timedLive } from "./final-helpers";
import { admin, freshDatabase, type Harness, seed, startWorker, until } from "./pipeline-harness";

// A profile that does not improve uploads: an upload keeps its live text and nothing is queued.
// Its own file: one process registers the pipeline's workflows once.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("final transcript, uploads not improved", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  const whisper = fakeProvider(9);

  beforeAll(async () => {
    const url = await freshDatabase("conv_final_uploads_off_test");
    h = await startWorker(url, {
      transcriber: new FakeTranscriber(undefined, timedLive),
      final: {
        profile: "test-profile",
        recordings: "redo",
        uploads: "none",
        timedPieceSeconds: 9,
        providers: ["whisper"],
        transcribers: { whisper },
        redact: async (text) => text,
      },
    });
  });
  afterAll(async () => {
    await h?.stop();
  });

  test("an upload keeps its live text and queues no improved transcript", async () => {
    const cid = newId();
    await seed(h.sql, cid, { source: "DASHBOARD_UPLOAD" });
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-up.mp3`;
    await h.deps.audio.put(key, await bursts(join(h.bucket.root, "off.mp3"), 3));
    await createChunk(
      { ...h.deps, jobs: h.queue },
      {
        conversationId: cid,
        timestamp: new Date(),
        source: "DASHBOARD_UPLOAD",
        fileUrl: h.deps.audioUrls.fileUrl(key),
      },
      { chunkId },
    );
    await until(async () => {
      const rows =
        await h.sql`select transcript from conversation_chunk where conversation_id = ${cid}`;
      return rows.length && rows.every((r) => r.transcript) ? rows : null;
    });
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => {
      const [c] = await h.sql`select summary from conversation where id = ${cid}`;
      return c?.summary ? c : null;
    });
    await Bun.sleep(3000);
    expect(
      await h.sql`select 1 from conversation_final_transcript where conversation_id = ${cid}`,
    ).toHaveLength(0);
    expect(whisper.calls).toHaveLength(0);
    const queued =
      await h.sql`select 1 from dbos.workflow_status where workflow_uuid like ${`conversations.final-transcript:${cid}:%`}`;
    expect(queued).toHaveLength(0);
  });
});
