// A worker process for the crash test: the conversation pipeline on DBOS against a shared
// bucket directory, tracing each media and transcription call. With HANG=1 it stops
// forever inside transcription, so the test can kill it mid-step.
import { appendFileSync } from "node:fs";
import { LocalMedia, type Media } from "@dembrane/audio";
import { FakeTranscriber } from "@dembrane/transcription";
import { startWorker } from "../pipeline-harness";

const who = process.env.EXECUTOR as string;
const trace = (s: string) => appendFileSync(process.env.TRACE_FILE as string, `${who} ${s}\n`);
const local = new LocalMedia();
const media: Media = {
  probe: (s) => local.probe(s),
  probeUrl: (u) => local.probeUrl(u),
  async convert(req) {
    trace("convert");
    return local.convert(req);
  },
  split: (req) => local.split(req),
  merge: (req) => local.merge(req),
};
const transcriber = new FakeTranscriber();
const plain = transcriber.transcribe.bind(transcriber);
transcriber.transcribe = async (input) => {
  trace("transcribe start");
  if (process.env.HANG === "1") await Bun.sleep(600_000);
  const out = await plain(input);
  trace("transcribe done");
  return out;
};
await startWorker(process.env.QUEUE_URL as string, {
  media,
  transcriber,
  executorId: who,
  bucketRoot: process.env.BUCKET_ROOT as string,
});
trace("ready");
