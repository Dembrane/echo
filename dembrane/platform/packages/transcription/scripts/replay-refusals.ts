// Replays chunk audio through Vertex with and without the transcription safety settings
// (ECHO-980). Only for audio from our own organisation, never customer audio.
// bun packages/transcription/scripts/replay-refusals.ts [--runs 3] file.mp3 [...]
import { readFileSync } from "node:fs";
import { createModels, type ModelCall } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import { renderPrompt } from "@dembrane/prompts";
import { GeminiTranscriber } from "@dembrane/transcription";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args.splice(runsAt, 2)[1]) : 3;
const project = process.env.LLM_VERTEX_PROJECT ?? "dembrane-web-previews";
const location = process.env.LLM_VERTEX_LOCATION ?? "eu";
const group = (
  process.env.LLM_MULTI_MODAL_PRO ?? "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash"
)
  .split(",")
  .map((s) => s.trim());

// Records what each request asked of the safety filters, as Vertex received it.
const sent: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (String(input).includes(":generateContent") && typeof init?.body === "string") {
    const body = JSON.parse(init.body) as { safetySettings?: { threshold: string }[] };
    const host = new URL(String(input)).host;
    sent.push(
      `${host} safetySettings=${JSON.stringify(body.safetySettings?.map((s) => s.threshold) ?? null)}`,
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

const say = (line: string) => process.stdout.write(`${line}\n`);
const calls: ModelCall[] = [];
const models = createModels(
  {
    vertexProject: project,
    vertexLocation: location,
    groups: { text_fast: group, multi_modal_fast: group, multi_modal_pro: group },
    embeddingModel: "text-embedding-004",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  },
  { observe: (c) => calls.push(c) },
);
const logger = createLogger({ service: "replay", release: "local", env: "local", level: "error" });
const prompt = renderPrompt("transcript_from_audio_workflow", "en", {
  hotwords_str: "",
  pii_redaction: false,
  custom_guidance_prompt: null,
  language: null,
});

/** Before: the old call, the primary deployment with no safety settings. */
async function before(audio: Uint8Array) {
  const m = models.model("multi_modal_pro");
  const r = await m.doGenerate({
    prompt: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: [{ type: "file", data: { type: "data", data: audio }, mediaType: "audio/mp3" }],
      },
    ],
    responseFormat: { type: "json" },
  });
  return `${String(r.finishReason.raw ?? r.finishReason.unified).toLowerCase()} [${sent.pop()}]`;
}

/** After: the real transcriber, as the worker runs it. */
async function after(audio: Uint8Array) {
  const from = calls.length;
  try {
    const out = await new GeminiTranscriber(models, logger).transcribe({ audio });
    return `ok (${out.transcript.length} chars)`;
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  } finally {
    const reasons = calls.slice(from).map((c) => `${c.model}:${c.finishReason ?? c.status}`);
    say(`      calls ${reasons.join(" -> ")}`);
    say(`      sent  ${sent.splice(0).join(" | ")}`);
  }
}

say(`project=${project} location=${location} group=${group.join(",")} runs=${runs}`);
for (const file of args) {
  const audio = new Uint8Array(readFileSync(file));
  say(`\n${file.split("/").pop()}`);
  for (let i = 0; i < runs; i++) say(`  before #${i + 1}: ${await before(audio)}`);
  for (let i = 0; i < runs; i++) say(`  after  #${i + 1}: ${await after(audio)}`);
}
