// A worker process for the final-pass recovery test: the conversation pipeline with the Scaleway
// and Google kits over stubbed providers, tracing each request Vertex answers. With HANG_AT=n it
// stops forever inside the nth Vertex request, so the test can kill it mid-pass. With
// NO_FINAL=scaleway the Scaleway kit has no final pass.
import { appendFileSync } from "node:fs";
import { routedWorker, stubbedRouter, withoutFinal } from "../final-route-helpers";

const who = process.env.EXECUTOR as string;
const trace = (s: string) => appendFileSync(process.env.TRACE_FILE as string, `${who} ${s}\n`);
const { vertex, router } = stubbedRouter();
if (process.env.NO_FINAL === "scaleway") withoutFinal(router, "scaleway");
const hangAt = Number(process.env.HANG_AT ?? 0);
vertex.after = async (n) => {
  trace(`vertex ${n}`);
  if (n !== hangAt) return;
  trace("hung");
  await new Promise(() => {});
};
await routedWorker(router, process.env.QUEUE_URL as string, {
  executorId: who,
  bucketRoot: process.env.BUCKET_ROOT as string,
});
trace("ready");
