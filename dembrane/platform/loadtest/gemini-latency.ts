// Real Gemini transcription latency and throughput for the portal's 30 s chunk, through
// the worker's own transcriber and the configured Vertex location (EU by default).
//   bun loadtest/gemini-latency.ts [serial=5] [concurrent=10]
import { loadSections } from "../packages/config/src/index.ts";
import { createModels } from "../packages/llm/src/index.ts";
import { createLogger } from "../packages/observability/src/index.ts";
import { GeminiTranscriber } from "../packages/transcription/src/index.ts";

const [serial = 5, concurrent = 10] = process.argv.slice(2).map(Number);
const { llm } = loadSections(["llm"]).values;
const groups = {
  text_fast: llm.textFast,
  multi_modal_fast: llm.multiModalFast,
  multi_modal_pro: llm.multiModalPro,
};
const models = createModels({
  vertexProject: llm.vertexProject,
  vertexLocation: llm.vertexLocation,
  groups,
  embeddingModel: llm.embeddingModel,
  embeddingLocation: llm.embeddingLocation,
  embeddingDimensions: llm.embeddingDimensions,
});
const t = new GeminiTranscriber(models, createLogger({ service: "gemini-latency", level: "warn" }));
const audio = new Uint8Array(
  await Bun.file(`${import.meta.dir}/.fixtures/chunk-30s.mp3`).arrayBuffer(),
);
const once = async () => {
  const s = performance.now();
  try {
    const r = await t.transcribe({
      audio,
      language: "en",
      hotwords: null,
      usePiiRedaction: false,
      anonymizeTranscripts: false,
      customGuidancePrompt: null,
    });
    return { ms: performance.now() - s, ok: true, chars: r.transcript.length, models: r.models };
  } catch (e) {
    return { ms: performance.now() - s, ok: false, err: String(e).slice(0, 200) };
  }
};
const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const serialRuns = [];
for (let i = 0; i < serial; i++) serialRuns.push(await once());
const wall = performance.now();
const parallel = await Promise.all(Array.from({ length: concurrent }, once));
const wallS = (performance.now() - wall) / 1000;
const ms = (rs: typeof serialRuns) => rs.filter((r) => r.ok).map((r) => r.ms);
// biome-ignore lint/suspicious/noConsole: a CLI that prints its result as JSON
console.log(
  JSON.stringify(
    {
      project: llm.vertexProject,
      location: llm.vertexLocation,
      model: llm.multiModalFast,
      chunk: "30 s, mp3 128 kbps",
      serial: {
        n: serial,
        ok: ms(serialRuns).length,
        p50_ms: pct(ms(serialRuns), 0.5),
        max_ms: Math.max(...ms(serialRuns)),
      },
      concurrent: {
        n: concurrent,
        ok: ms(parallel).length,
        p50_ms: pct(ms(parallel), 0.5),
        p95_ms: pct(ms(parallel), 0.95),
        wall_s: wallS,
        chunks_per_s: ms(parallel).length / wallS,
      },
      errors: [...serialRuns, ...parallel]
        .filter((r) => !r.ok)
        .map((r) => r.err)
        .slice(0, 3),
      sample: serialRuns.find((r) => r.ok),
    },
    null,
    1,
  ),
);
process.exit(0);
