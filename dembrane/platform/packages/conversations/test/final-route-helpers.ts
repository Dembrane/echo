import {
  decide,
  type LlmSettings,
  PROFILES,
  profileForProvider,
  routingPolicyOf,
  STUB_VERTEX_AUTH,
  speechModels,
  type TranscriptionProfile,
  wireStubs,
} from "@dembrane/llm";
import { dbRoutingStore, providerResolver } from "@dembrane/metering";
import { GeminiFinal } from "@dembrane/transcription";
import { buildSpeechKit, type SpeechKit, type SpeechRouter } from "../src";
import { quiet, startWorker } from "./pipeline-harness";

// The speech router of the final-route tests: Scaleway and a Google kit with a final pass,
// over stubbed providers, shared by the test process and the worker processes it kills.

export const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
  baseUrl: "https://scaleway.final.test/v1",
  apiKey: "k",
  searchGrounding: true,
  textFast: ["gemini-a"],
  multiModalFast: ["gemini-a"],
  multiModalPro: ["gemini-a"],
  compatTextFast: ["glm-5.3"],
  compatMultiModalFast: ["glm-5.3"],
  compatMultiModalPro: ["glm-5.3"],
  vertexProject: "p",
  vertexLocation: "eu",
  embeddingModel: "text-embedding-004",
  compatEmbeddingModel: "qwen3-embedding-8b",
  embeddingLocation: "europe-west4",
  embeddingDimensions: 8,
};
export const policy = routingPolicyOf(SETTINGS);
// Google's profile with a final pass: Gemini hears the whole recording again after it ends.
const GOOGLE_WITH_FINAL: TranscriptionProfile = {
  ...PROFILES["dembrane-26-10-gemini"],
  recordings: "redo",
  uploads: "redo",
  redo: { provider: "gemini", model: "gemini-3.8-flash" },
};
// What a speaker said that an anonymised conversation must never show.
export const PLANTED = ["Maria Jansen", "Keizersgracht 12", "06 12345678"];
const SAID = `${PLANTED[0]} lives at ${PLANTED[1]} and can be called on ${PLANTED[2]}`;
// Both parsers read the same answer: the timed sentences and the redacted text.
const ANSWER = JSON.stringify({
  segments: [{ start: 0, end: 2, text: `google heard this. ${SAID}` }],
  corrected_transcript: "redacted by whoever answered",
  note: "",
});
export const REDACTED = "redacted by whoever answered";

/**
 * One router of a Scaleway kit and a Google kit with a final pass, over stubbed providers.
 * `vertex.after` runs once a Vertex request has been answered, with how many there have been.
 */
export function stubbedRouter() {
  const wire = wireStubs({ text: ANSWER, speech: `whisper heard this. ${SAID}` });
  // What the next Vertex request does once it has been answered, and the status it answers with.
  const vertex = {
    after: (_n: number) => Promise.resolve() as Promise<unknown>,
    status: null as number | null,
  };

  const hooks = {
    attemptsPerDeployment: 2,
    backoffMs: 0,
    sleep: async () => {},
    transport: {
      vertex: {
        fetch: (async (...a: Parameters<typeof fetch>) => {
          const res = await wire.vertex(...a);
          await vertex.after(wire.seen.vertex.length);
          return vertex.status ? new Response("{}", { status: vertex.status }) : res;
        }) as typeof fetch,
        ...STUB_VERTEX_AUTH,
      },
      compatFetch: wire.compat,
    },
  };
  const kit = (id: "scaleway" | "google"): SpeechKit => {
    const profile = id === "google" ? GOOGLE_WITH_FINAL : profileForProvider(SETTINGS, id);
    const built = buildSpeechKit({
      settings: SETTINGS,
      profile,
      hooks,
      logger: quiet,
      withFinal: true,
    });
    if (id !== "google" || !built.final) return built;
    // Pieces of nine seconds, so a short recording is read in several requests.
    const gemini = new GeminiFinal(speechModels(SETTINGS, profile, "gemini", hooks), quiet, {
      maxSeconds: 9,
    });
    return { ...built, final: { ...built.final, transcribers: { gemini } } };
  };
  const router: SpeechRouter = {
    default: "scaleway",
    kits: { scaleway: kit("scaleway"), google: kit("google") },
    decide: async () => {
      throw new Error("replaced below, once the database is up");
    },
  };
  return { wire, vertex, router };
}

/** A worker on the router, whose routing reads the database that worker is connected to. */
export async function routedWorker(
  router: SpeechRouter,
  url: string,
  opts: { executorId?: string; bucketRoot?: string } = {},
) {
  const h = await startWorker(url, {
    transcriber: router.kits.scaleway?.transcriber as never,
    speech: router,
    ...opts,
  });
  const resolver = providerResolver(dbRoutingStore(h.deps.db), policy, { ttlMs: 0 });
  (router as { decide: SpeechRouter["decide"] }).decide = (who) =>
    decide(resolver, policy, "transcription", who);
  return h;
}

/** The kit of a provider with its final pass taken away: its conversations keep their live text. */
export const withoutFinal = (router: SpeechRouter, id: "scaleway" | "google") => {
  const kits = router.kits as Record<string, SpeechKit | undefined>;
  const kept = kits[id] as SpeechKit;
  kits[id] = { ...kept, final: undefined };
  return () => {
    kits[id] = kept;
  };
};
