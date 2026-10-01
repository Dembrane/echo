import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { AudioError } from "@dembrane/audio";
import { newId } from "@dembrane/core";
import { createChunk } from "../src/chunks";
import { catchUpSummaries, finishConversation } from "../src/pipeline/defs";
import {
  idleConversations,
  measureDuration,
  pieceId,
  unsummarizedConversations,
} from "../src/pipeline/steps";
import {
  admin,
  freshDatabase,
  type Harness,
  seed,
  startWorker,
  tone,
  until,
} from "./pipeline-harness";

// Upload to transcript to merged audio to summary, through the real workflows on DBOS,
// the filesystem bucket served over HTTP and real ffmpeg. Needs Postgres and ffmpeg.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("conversation pipeline", () => {
  setDefaultTimeout(120_000);
  let h: Harness;

  beforeAll(async () => {
    const url = await freshDatabase("conv_pipeline_test");
    // A 60 KB split threshold, so a few seconds of mp3 is cut into pieces.
    h = await startWorker(url, { maxChunkBytes: 60_000 });
  });
  afterAll(async () => {
    await h?.stop();
  });

  async function upload(conversationId: string, file: Blob, name: string) {
    const chunkId = newId();
    const key = `conversation/${conversationId}/chunks/${chunkId}-${name}`;
    await h.deps.audio.put(key, file);
    return createChunk(
      { ...h.deps, jobs: h.queue },
      {
        conversationId,
        timestamp: new Date(),
        source: "PORTAL_AUDIO",
        fileUrl: h.deps.audioUrls.fileUrl(key),
      },
      { chunkId },
    );
  }

  const conversation = async (id: string) =>
    (await h.sql`select * from conversation where id = ${id}`)[0] as Record<string, unknown>;
  const chunks = (id: string) =>
    h.sql`select * from conversation_chunk where conversation_id = ${id} order by timestamp, id`;

  test("a webm chunk is converted, transcribed, then merged and summarised after finish", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const file = await tone(join(h.bucket.root, "in.webm"), 3);
    const chunk = await upload(cid, file, "rec.webm");

    // Converted to mp3 on the same key with the new extension, then transcribed.
    const [done] = await until(async () => {
      const rows = await chunks(cid);
      return rows[0]?.transcript ? rows : null;
    });
    expect(done?.id).toBe(chunk.id);
    expect(done?.path).toBe(
      h.deps.audioUrls.fileUrl(`conversation/${cid}/chunks/${chunk.id}-rec.mp3`),
    );
    expect(String(done?.transcript)).toStartWith("transcript of ");
    expect(done?.diarization).toMatchObject({ schema: "Dembrane-26-07-gemini" });
    expect((await conversation(cid)).recording_started_at).not.toBeNull();

    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const final = await until(async () => {
      const c = await conversation(cid);
      return c.summary && c.merged_audio_path && c.token_count !== null ? c : null;
    });
    expect(final.is_finished).toBe(true);
    expect(final.is_all_chunks_transcribed).toBe(true);
    expect(final.summary).toBe("A short summary.");
    expect(Number(final.duration)).toBeGreaterThan(2);
    expect(String(final.merged_audio_path)).toContain(`audio-conversations/merged-${cid}-`);
    const statuses =
      await h.sql`select event from processing_status where conversation_id = ${cid}`;
    expect(statuses.map((s) => s.event)).toEqual(
      expect.arrayContaining([
        "task_process_conversation_chunk.split_audio_chunk.completed",
        "task_transcribe_chunk.completed",
        "task_merge_conversation_chunks.completed",
        "task_summarize_conversation.completed",
      ]),
    );
  });

  test("a file above the split size becomes pieces with derived ids, and the original goes", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const file = await tone(join(h.bucket.root, "long.mp3"), 12, [
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
    ]);
    expect(file.size).toBeGreaterThan(120_000);
    const chunk = await upload(cid, file, "long.mp3");
    const rows = await until(async () => {
      const r = await chunks(cid);
      return r.length > 1 && r.every((c) => c.transcript) ? r : null;
    });
    const n = rows.length;
    expect(n).toBe(Math.ceil(file.size / 60_000));
    expect(rows.map((r) => r.id)).toEqual(
      Array.from({ length: n }, (_, i) => pieceId(chunk.id, i)),
    );
    expect(rows.some((r) => r.id === chunk.id)).toBe(false);
    expect(String(rows[1]?.path)).toContain(`chunks/${cid}/${pieceId(chunk.id, 1)}_1-of-${n}.mp3`);
    // Pieces are timestamped where they start in the recording.
    expect(new Date(String(rows[1]?.timestamp)).getTime()).toBeGreaterThan(
      new Date(String(rows[0]?.timestamp)).getTime(),
    );
  });

  test("a conversation whose merge fails still gets its duration from the chunks", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const media = h.deps.media as { merge: typeof h.deps.media.merge };
    const original = media.merge;
    media.merge = async () => {
      throw new AudioError("no_mergeable_chunks", "No processed data streams");
    };
    try {
      await upload(cid, await tone(join(h.bucket.root, "d1.webm"), 3), "d1.webm");
      await upload(cid, await tone(join(h.bucket.root, "d2.webm"), 2), "d2.webm");
      await until(async () => {
        const r = await chunks(cid);
        return r.length === 2 && r.every((c) => c.transcript) ? r : null;
      });
      const c = await finishAndSettle(cid);
      expect(c.merged_audio_path).toBeNull();
      expect(Number(c.duration)).toBeCloseTo(5, 0);
    } finally {
      media.merge = original;
    }
  });

  test("a merged file that cannot be probed is measured instead", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const media = h.deps.media as { merge: typeof h.deps.media.merge };
    const original = media.merge;
    media.merge = async (req) => ({ ...(await original.call(h.deps.media, req)), duration: -1 });
    try {
      await upload(cid, await tone(join(h.bucket.root, "p.webm"), 3), "p.webm");
      const c = await finishAndSettle(cid);
      expect(c.merged_audio_path).not.toBeNull();
      expect(Number(c.duration)).toBeCloseTo(3, 0);
    } finally {
      media.merge = original;
    }
  });

  test("audio too small to play is marked, and the conversation still finalizes", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await upload(cid, new Blob([new Uint8Array(200)]), "tiny.webm");
    const [row] = await until(async () => {
      const r = await chunks(cid);
      return r[0]?.error ? r : null;
    });
    expect(row?.error).toBe("Audio not playable");
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed ? x : null;
    });
    expect(c.is_finished).toBe(true);
  });

  test("a transcription that keeps failing saves its error and does not block finalize", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    h.transcriber.failNext(
      new Error("vertex 503"),
      new Error("vertex 503"),
      new Error("vertex 503"),
    );
    await upload(cid, await tone(join(h.bucket.root, "f.webm"), 2), "f.webm");
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed ? x : null;
    });
    expect(c.is_finished).toBe(true);
    const [row] = await chunks(cid);
    expect(row?.transcript).toBeNull();
    expect(String(row?.error)).toContain("vertex 503");
  });

  test("finishing before the last chunk is transcribed finalizes once the chunk lands", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    // Finish first: nothing uploaded yet is pending, so the finish hands over to finalize
    // only when the chunk run does.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = h.transcriber.transcribe.bind(h.transcriber);
    h.transcriber.transcribe = async (i) => {
      await gate;
      return original(i);
    };
    await upload(cid, await tone(join(h.bucket.root, "g.webm"), 2), "g.webm");
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => (await conversation(cid)).is_finished);
    await Bun.sleep(500);
    expect((await conversation(cid)).is_all_chunks_transcribed).not.toBe(true);
    release();
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed && x.summary ? x : null;
    });
    expect(c.summary).toBe("A short summary.");
    h.transcriber.transcribe = original;
  });

  test("finishing while a chunk waits to retry its transcription summarises the transcript", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    // The first attempt fails; the retry waits on the gate, so the finish lands in between.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = h.transcriber.transcribe.bind(h.transcriber);
    let attempts = 0;
    h.transcriber.transcribe = async (i) => {
      attempts++;
      if (attempts === 1) throw new Error("vertex 503");
      await gate;
      return original(i);
    };
    await upload(cid, await tone(join(h.bucket.root, "r.webm"), 2), "r.webm");
    await until(async () => attempts >= 2);
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => (await conversation(cid)).is_finished);
    // Longer than a queue poll, so a finalize queued by the finish would have run.
    await Bun.sleep(2500);
    const waiting = await conversation(cid);
    expect(waiting.is_all_chunks_transcribed).not.toBe(true);
    expect(waiting.summary).toBeNull();
    release();
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed && x.summary ? x : null;
    });
    expect(c.summary).toBe("A short summary.");
    const [row] = await chunks(cid);
    expect(row?.error).toBeNull();
    h.transcriber.transcribe = original;
  });

  test("the catch-up replaces a no-transcript summary once the conversation has a transcript", async () => {
    const withText = newId();
    const empty = newId();
    const blank = newId();
    for (const cid of [withText, empty, blank]) {
      await seed(h.sql, cid);
      await h.sql`update conversation set is_finished = true, is_all_chunks_transcribed = true,
        summary = '[No transcript available]' where id = ${cid}`;
    }
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${withText}, now(), 'words that arrived late', 'PORTAL_AUDIO')`;
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, error, source)
      values (${newId()}, ${empty}, now(), 'Audio not playable', 'PORTAL_AUDIO')`;
    // The summariser skips an empty transcript, so picking this one would repeat every tick.
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${blank}, now(), '', 'PORTAL_AUDIO')`;

    const due = await unsummarizedConversations(h.deps.db, new Date(), 1000);
    expect(due).toContain(withText);
    expect(due).not.toContain(empty);
    expect(due).not.toContain(blank);

    await h.queue.enqueue(catchUpSummaries, {});
    const c = await until(async () => {
      const x = await conversation(withText);
      return x.summary !== "[No transcript available]" ? x : null;
    });
    expect(c.summary).toBe("A short summary.");
    expect((await conversation(empty)).summary).toBe("[No transcript available]");
  });

  test("finishing twice finalizes once", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${cid}, now(), 'typed words', 'PORTAL_TEXT')`;
    await Promise.all([
      h.queue.enqueue(finishConversation, { conversationId: cid }),
      h.queue.enqueue(finishConversation, { conversationId: cid }),
    ]);
    await until(async () => (await conversation(cid)).summary);
    await Bun.sleep(1000);
    const summaries = await h.sql`
      select count(*)::int as n from processing_status
      where conversation_id = ${cid} and event = 'task_summarize_conversation.completed'`;
    expect(summaries[0]?.n).toBe(1);
  });
  // Replaces h.deps.media[op] for the length of fn.
  async function withMedia<K extends "merge" | "probe">(
    op: K,
    impl: (typeof h.deps.media)[K],
    fn: () => Promise<void>,
  ) {
    const media = h.deps.media as Record<K, (typeof h.deps.media)[K]>;
    const original = media[op];
    media[op] = impl;
    try {
      await fn();
    } finally {
      media[op] = original;
    }
  }
  const failMerge = async () => {
    throw new AudioError("no_mergeable_chunks", "No processed data streams");
  };
  async function finishAndSettle(cid: string) {
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    return until(async () => {
      const x = await conversation(cid);
      if (!x.is_all_chunks_transcribed || !x.summary) return null;
      // The measure step is the last one: its workflow finishing means it ran.
      const [wf] = await h.sql`select status from dbos.workflow_status
        where workflow_uuid like ${`conversations.finalize:${cid}:%`} order by created_at desc limit 1`;
      return wf?.status === "SUCCESS" ? x : null;
    });
  }

  test("split pieces are measured when the merge fails", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await withMedia("merge", failMerge, async () => {
      const file = await tone(join(h.bucket.root, "long2.mp3"), 12, [
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
      ]);
      await upload(cid, file, "long2.mp3");
      await until(async () => {
        const r = await chunks(cid);
        return r.length > 1 && r.every((c) => c.transcript) ? r : null;
      });
      const c = await finishAndSettle(cid);
      expect(c.merged_audio_path).toBeNull();
      expect(Number(c.duration)).toBeCloseTo(12, 0);
    });
  });

  test("an unreadable chunk is left out of the measured duration", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await withMedia("merge", failMerge, async () => {
      await upload(cid, await tone(join(h.bucket.root, "ok.webm"), 3), "ok.webm");
      // Past the size checks, so it reaches transcription; ffprobe rejects the bytes.
      await upload(cid, new Blob([new Uint8Array(4096).fill(7)]), "junk.mp3");
      await until(async () => {
        const r = await chunks(cid);
        return r.length === 2 && r.every((c) => c.transcript || c.error) ? r : null;
      });
      const c = await finishAndSettle(cid);
      expect(Number(c.duration)).toBeCloseTo(3, 0);
    });
  });

  test("a measure that keeps failing gives up without blocking the conversation", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await withMedia("merge", failMerge, async () => {
      await withMedia(
        "probe",
        async () => {
          throw new AudioError("transient", "media probe unreachable");
        },
        async () => {
          await upload(
            cid,
            await tone(join(h.bucket.root, "t.mp3"), 2, ["-c:a", "libmp3lame"]),
            "t.mp3",
          );
          await until(async () => (await chunks(cid))[0]?.transcript);
          const c = await finishAndSettle(cid);
          expect(c.duration).toBeNull();
          expect(c.summary).toBe("A short summary.");
        },
      );
    });
  });

  test("a merged conversation keeps the merge's duration and is not probed again", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await upload(cid, await tone(join(h.bucket.root, "m.webm"), 3), "m.webm");
    await until(async () => (await chunks(cid))[0]?.transcript);
    let probes = 0;
    const media = h.deps.media;
    const probe = media.probe.bind(media);
    await withMedia(
      "probe",
      async (s) => {
        probes++;
        return probe(s);
      },
      async () => {
        const c = await finishAndSettle(cid);
        expect(c.merged_audio_path).not.toBeNull();
        expect(Number(c.duration)).toBeCloseTo(3, 0);
        expect(probes).toBe(0);
      },
    );
  });

  test("a text conversation gets no duration and measure leaves it alone", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${cid}, now(), 'typed words', 'PORTAL_TEXT')`;
    const c = await finishAndSettle(cid);
    expect(c.duration).toBeNull();
    expect(await measureDuration(h.deps, cid)).toBeNull();
  });

  test("audio after a merged finish reopens, and the second finish counts both recordings", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await upload(cid, await tone(join(h.bucket.root, "a1.webm"), 3), "a1.webm");
    await until(async () => (await chunks(cid))[0]?.transcript);
    const first = await finishAndSettle(cid);
    expect(Number(first.duration)).toBeCloseTo(3, 0);
    await withMedia("merge", failMerge, async () => {
      await upload(cid, await tone(join(h.bucket.root, "a2.webm"), 2), "a2.webm");
      const reopened = await conversation(cid);
      expect(reopened.duration).toBeNull();
      await until(async () => {
        const r = await chunks(cid);
        return r.length === 2 && r.every((c) => c.transcript) ? r : null;
      });
      const c = await finishAndSettle(cid);
      expect(Number(c.duration)).toBeCloseTo(5, 0);
    });
  });

  test("measure never overwrites a duration that is already there", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await upload(cid, await tone(join(h.bucket.root, "k.webm"), 2), "k.webm");
    await until(async () => (await chunks(cid))[0]?.transcript);
    await h.sql`update conversation set duration = 42 where id = ${cid}`;
    expect(await measureDuration(h.deps, cid)).toBeNull();
    expect(Number((await conversation(cid)).duration)).toBe(42);
  });
  test("audio that arrives after an empty conversation was idle-finished reopens it", async () => {
    // Prod: the participant starts recording minutes after opening the portal, the idle
    // sweep finishes the empty conversation first, and the audio then lands on it.
    const cid = newId();
    await seed(h.sql, cid);
    // Past the grace for empty conversations and not pinging: the sweep finishes it empty.
    await h.sql`update conversation set created_at = now() - interval '3 hours' where id = ${cid}`;
    expect(await idleConversations(h.deps.db, new Date(), 1000)).toContain(cid);
    const empty = await finishAndSettle(cid);
    expect(empty.merged_audio_path).toBeNull();
    expect(empty.duration).toBeNull();

    await upload(cid, await tone(join(h.bucket.root, "late.webm"), 3), "late.webm");
    const reopened = await conversation(cid);
    expect(reopened.is_finished).toBe(false);
    expect(reopened.is_all_chunks_transcribed).toBe(false);
    expect(reopened.summary).toBeNull();
    await until(async () => (await chunks(cid))[0]?.transcript);

    const c = await finishAndSettle(cid);
    expect(c.merged_audio_path).not.toBeNull();
    expect(Number(c.duration)).toBeCloseTo(3, 0);
    expect(c.summary).toBe("A short summary.");
  });
  test("audio that lands while the finalize is merging is summarised by the next finalize", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await upload(cid, await tone(join(h.bucket.root, "r1.webm"), 3), "r1.webm");
    await until(async () => (await chunks(cid))[0]?.transcript);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let merging = false;
    const media = h.deps.media;
    const merge = media.merge.bind(media);
    await withMedia(
      "merge",
      async (req) => {
        merging = true;
        await gate;
        return merge(req);
      },
      async () => {
        await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
        await until(async () => merging);
        // The first finalize has claimed and is merging; the participant records on.
        await upload(cid, await tone(join(h.bucket.root, "r2.webm"), 2), "r2.webm");
        expect((await conversation(cid)).is_all_chunks_transcribed).toBe(false);
        release();
        await until(async () => {
          const r = await chunks(cid);
          return r.length === 2 && r.every((c) => c.transcript) ? r : null;
        });
        // The first run finishes against the reopened row before the second finish.
        await until(async () => {
          const [wf] = await h.sql`select status from dbos.workflow_status
            where workflow_uuid like ${`conversations.finalize:${cid}:%`} order by created_at limit 1`;
          return wf?.status === "SUCCESS";
        });
      },
    );
    const c = await finishAndSettle(cid);
    expect(Number(c.duration)).toBeCloseTo(5, 0);
    const [n] = await h.sql`select count(*)::int as n from processing_status
      where conversation_id = ${cid} and event = 'task_summarize_conversation.completed'`;
    expect(n?.n).toBe(2);
  });
  test("a chunk that lands while a finalize claims the conversation reopens it", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    // Finished with nothing pending: the state claimFinalize takes the row lock in.
    await h.sql`update conversation set is_finished = true where id = ${cid}`;
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${cid}, now(), 'first words', 'PORTAL_AUDIO')`;
    const file = await tone(join(h.bucket.root, "race.webm"), 3);
    let landing: Promise<unknown> = Promise.resolve();
    await h.sql.begin(async (tx) => {
      // claimFinalize's claim, held open while the chunk arrives.
      await tx`select id from conversation where id = ${cid} for update`;
      landing = upload(cid, file, "race.webm");
      await until(async () => {
        const [w] = await h.sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`;
        return (w?.n ?? 0) > 0;
      }, 10_000);
      await tx`update conversation set is_all_chunks_transcribed = true where id = ${cid}`;
    });
    await landing;
    const after = await conversation(cid);
    expect(after.is_finished).toBe(false);
    expect(after.is_all_chunks_transcribed).toBe(false);
    await until(async () => {
      const r = await chunks(cid);
      return r.length === 2 && r.every((c) => c.transcript) ? r : null;
    });
    const c = await finishAndSettle(cid);
    expect(c.merged_audio_path).not.toBeNull();
    expect(Number(c.duration)).toBeCloseTo(3, 0);
  });
  test("the idle sweep leaves an empty conversation open while its portal pings", async () => {
    const at = async (
      age: string,
      opts: { chunkAge?: string; pingAge?: string; state?: string } = {},
    ) => {
      const cid = newId();
      await seed(h.sql, cid);
      await h.sql`update conversation set created_at = now() - ${age}::interval where id = ${cid}`;
      if (opts.chunkAge)
        await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
          values (${newId()}, ${cid}, now() - ${opts.chunkAge}::interval, 'words', 'PORTAL_AUDIO')`;
      if (opts.pingAge)
        // A sticky state keeps the row alive for 30 minutes past its last ping.
        await h.sql`insert into platform_presence (kind, key, data, seen_at, expires_at)
          values ('liveness', ${cid}, ${JSON.stringify({ state: opts.state ?? "waiting" })}::jsonb,
            now() - ${opts.pingAge}::interval, now() + interval '30 minutes')`;
      return cid;
    };
    const justOpened = await at("10 minutes");
    const abandoned = await at("31 minutes");
    const waitingOnPage = await at("3 hours", { pingAge: "10 seconds" });
    const pingsStopped = await at("3 hours", { pingAge: "2 minutes" });
    const leftRecently = await at("3 hours", { pingAge: "5 minutes", state: "left" });
    const paused = await at("10 minutes", { chunkAge: "6 minutes" });
    const recording = await at("10 minutes", { chunkAge: "1 minute" });
    const idle = await idleConversations(h.deps.db, new Date(), 100_000);
    expect(idle).not.toContain(justOpened);
    expect(idle).toContain(abandoned);
    expect(idle).not.toContain(waitingOnPage);
    expect(idle).toContain(pingsStopped);
    expect(idle).toContain(leftRecently);
    // Conversations with audio keep the five-minute rule.
    expect(idle).toContain(paused);
    expect(idle).not.toContain(recording);
  });
});
