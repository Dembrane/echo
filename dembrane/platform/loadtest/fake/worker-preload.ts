// Preloaded into the Bun worker for load tests only (bun --preload). Replaces Gemini with
// a fixed latency so a run measures our pipeline, not the model provider, and lets a run
// raise the chunk queue's per-instance concurrency without touching the worker's code.
//   FAKE_TRANSCRIBE_MS (default 8000) plus up to FAKE_TRANSCRIBE_JITTER_MS (default 4000)
//   LOADTEST_CHUNK_CONCURRENCY: overrides conversations.chunk's concurrency when set
import { Queue } from "../../packages/queue/src/index.ts";
import { GeminiTranscriber } from "../../packages/transcription/src/index.ts";

const base = Number(process.env.FAKE_TRANSCRIBE_MS ?? 8000);
const jitter = Number(process.env.FAKE_TRANSCRIBE_JITTER_MS ?? 4000);

GeminiTranscriber.prototype.transcribe = async function (input) {
  // The real transcriber base64-encodes the audio into the request; keep that cost.
  Buffer.from(input.audio).toString("base64");
  await Bun.sleep(base + Math.random() * jitter);
  return { transcript: `fake transcript of ${input.audio.byteLength} bytes`, note: "", models: ["fake"] };
};

const chunkConcurrency = Number(process.env.LOADTEST_CHUNK_CONCURRENCY ?? 0);
if (chunkConcurrency > 0) {
  const workflow = Queue.prototype.workflow;
  Queue.prototype.workflow = function (def, opts, handler) {
    const o = def.name === "conversations.chunk" ? { ...opts, concurrency: chunkConcurrency } : opts;
    return workflow.call(this, def, o, handler);
  } as typeof workflow;
}
