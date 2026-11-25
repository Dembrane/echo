import type { RouteDecision } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { type StepConfig, step } from "@dembrane/queue";
import { FinalRouteMoved } from "../speech";
import { conversationStore } from "../storage";
import { finalTranscript } from "./defs";
import {
  editFinal,
  type FinalPart,
  type FinalPlan,
  type FinalSettings,
  finalTreatment,
  loadFinalContext,
  markFinalGaveUp,
  planFinal,
  planFromFirstPass,
  redactFinal,
  storeFinal,
  transcribeFinalPiece,
} from "./final";
import {
  claimFinalize,
  claimFinish,
  handOver,
  loadChunk,
  measureDuration,
  mergeAudio,
  type PipelineDeps,
  prepareChunk,
  redactTypedChunk,
  stampOverCap,
  summarize,
  summarizedWebhook,
  transcribePiece,
  updateChunk,
  warmTokenCount,
  withSpeech,
} from "./steps";

type Retry = Omit<StepConfig, "name">;

/** How often each kind of step is retried. Tests shorten the intervals. */
export interface RetryPolicy {
  /** Every attempt re-sends the audio to Gemini: five retries, 30 s doubling (about fifteen minutes). */
  readonly transcribe: Retry;
  /** ffmpeg on the media service: a killed instance or a network blip. */
  readonly media: Retry;
  /** The summary call and its writes. */
  readonly llm: Retry;
  /** Plain database steps: a dropped connection or a failover. */
  readonly db: Retry;
}

export const RETRIES: RetryPolicy = {
  transcribe: { retriesAllowed: true, maxAttempts: 6, intervalSeconds: 30, backoffRate: 2 },
  media: { retriesAllowed: true, maxAttempts: 8, intervalSeconds: 15, backoffRate: 2 },
  llm: { retriesAllowed: true, maxAttempts: 6, intervalSeconds: 15, backoffRate: 2 },
  db: { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2, backoffRate: 2 },
};

// Names a run's merged file, so a retried merge overwrites the file it wrote before.
const RUN_NAMESPACE = "2f7c6b1e-3d4a-4e8f-9b0c-1a2b3c4d5e6f";

/**
 * The conversation pipeline as durable workflows, replacing the five-phase
 * Dramatiq saga and the crons that repaired it. Each side effect is a step whose result
 * DBOS checkpoints; after a crash a run resumes at its first unfinished step on any
 * worker. The steps and why each is safe to run twice are in README.md.
 */
export function pipelineWorkflows(d: PipelineDeps, retry: RetryPolicy = RETRIES) {
  return {
    /** conversations.chunk: load, convert and split, transcribe each piece, hand over. */
    async chunk(p: {
      chunkId: string;
      usePiiRedaction: boolean;
      typed?: boolean | undefined;
    }): Promise<void> {
      const typed = p.typed === true;
      const loaded = await step("load", () => loadChunk(d, p.chunkId, typed), retry.db);
      const conversationId = loaded.conversationId;
      if (!conversationId) return;
      // The job names only its chunk: its calls are billed to the conversation the load
      // found, a checkpoint, so a recovered run gets the same one.
      await withPayer({ ref: "conversation", id: conversationId }, async () => {
        if (!loaded.skip && typed) {
          try {
            await step(
              "redact",
              () =>
                redactTypedChunk(d, p.chunkId, {
                  usePiiRedaction: p.usePiiRedaction,
                  anonymize: loaded.anonymize,
                }),
              retry.transcribe,
            );
          } catch {
            // Out of retries: the last attempt saved its error on the chunk, so it counts as
            // done and holds no text: the raw text is cleared with it, never kept.
          }
        } else if (!loaded.skip) {
          let pieces: string[] = [];
          try {
            pieces = await step("prepare", () => prepareChunk(d, p.chunkId), retry.media);
          } catch (err) {
            // Out of retries. The Python left such a chunk pending forever, which kept its
            // conversation from ever finalizing; marking it lets the rest go through.
            const message = (err as Error).message;
            await step(
              "prepare-failed",
              () => updateChunk(d, p.chunkId, conversationId, { error: message }, false),
              retry.db,
            );
          }
          for (const piece of pieces) {
            try {
              await step(
                "transcribe",
                () =>
                  transcribePiece(d, piece, {
                    usePiiRedaction: p.usePiiRedaction,
                    anonymize: loaded.anonymize,
                  }),
                retry.transcribe,
              );
            } catch {
              // Out of retries: the last attempt saved its error on the chunk, which is
              // what makes it count as done rather than pending.
            }
          }
        }
        await step("hand-over", () => handOver(d, conversationId), retry.db);
      });
    },

    /** conversations.finish: claim, stamp the cap, hand over. */
    async finish(p: { conversationId: string }): Promise<void> {
      const claimed = await step("claim", () => claimFinish(d, p.conversationId), retry.db);
      if (!claimed) return;
      await step("stamp-over-cap", () => stampOverCap(d, p.conversationId), retry.db);
      await step("hand-over", () => handOver(d, p.conversationId), retry.db);
    },

    /** conversations.finalize: claim (and the transcribed webhook), merge, summarise, count, measure. */
    async finalize(p: { conversationId: string }, runId: string): Promise<void> {
      const projectId = await step("claim", () => claimFinalize(d, p.conversationId), retry.db);
      if (!projectId) return;
      const run = Bun.randomUUIDv5(runId, RUN_NAMESPACE);
      try {
        await step("merge", () => mergeAudio(d, p.conversationId, run), retry.media);
      } catch (err) {
        // The merged file is also built on demand when a host plays the conversation.
        d.logger.warn(
          { conversationId: p.conversationId, err: (err as Error).message },
          "merge gave up",
        );
      }
      await summarizeWithWebhook(d, p.conversationId, retry, true);
      await step("token-count", () => warmTokenCount(d, p.conversationId), retry.db);
      // Last, so runs recorded before this step existed resume on the same step order.
      try {
        await step("measure", () => measureDuration(d, p.conversationId), retry.media);
      } catch (err) {
        d.logger.warn(
          { conversationId: p.conversationId, err: (err as Error).message },
          "measure gave up",
        );
      }
    },

    /**
     * conversations.final-transcript: merge, cut at pauses, transcribe each piece, keep the
     * result beside the chunks and, when it is the record, summarise from it. Any failure
     * leaves the live text as the transcript.
     */
    async finalTranscript(p: {
      conversationId: string;
      provider: "gemini" | "whisper";
      record: boolean;
      hash: string;
    }): Promise<void> {
      // The kit of the provider the conversation is on now: its final pass, its clean-up.
      return withSpeech(d, p.conversationId, async (d) => {
        const final = d.final;
        if (!d.speech && !final) return;
        // The kit is picked outside any step, so a run recovered after the project moved holds
        // the kit of the provider it moved to, not the one this pass began on. Every call below
        // runs inside its own step and, on a kit that is not this pass's own, ends as a move
        // instead of calling it: what a step recorded is replayed, the rest is decided afresh
        // and recorded, so the steps come in the same order on every recovery.
        const foreign = d.speech !== undefined && final?.providers.includes(p.provider) !== true;
        const movedNow = async () => ({
          moved: await (d.speech as NonNullable<typeof d.speech>).decide({
            ref: "conversation",
            id: p.conversationId,
          }),
        });
        const onKit = <T>(call: (own: FinalSettings) => Promise<T>) =>
          foreign ? movedNow() : unlessMoved(() => call(final as FinalSettings));
        const transcriber = final?.transcribers[p.provider];
        let wrote = false;
        // Another run took the work over on the kit of the provider the project moved to.
        let handedOn = false;
        const handOn = async (to: RouteDecision) => {
          handedOn = await step("final-moved", () => moveOn(d, p, to), retry.db);
        };
        try {
          // An upload whose first reading is kept: its own sentences, moved to their place in
          // the merged file; nothing is sent to the speech model again. When the first reading
          // cannot give the times, the recording is read again as for a recorded conversation.
          const kind = await step(
            "final-kind",
            async () => {
              if (foreign) return movedNow();
              const own = final as FinalSettings;
              const conv = await conversationStore(d.db).conversation(p.conversationId);
              const treatment = finalTreatment(own, conv?.source);
              return {
                treatment,
                // The first reading's sentences are Whisper's: only a Whisper run keeps them.
                firstPass:
                  treatment === "first-pass" && p.provider === "whisper"
                    ? await planFromFirstPass(d, p.conversationId, p.hash)
                    : null,
              };
            },
            retry.media,
          );
          if ("moved" in kind) {
            await handOn(kind.moved);
            return;
          }
          if (kind.treatment === "none") return;
          let plan: FinalPlan | null = kind.firstPass?.plan ?? null;
          let parts: FinalPart[] = kind.firstPass ? [...kind.firstPass.parts] : [];
          if (!plan) {
            const planned = await step(
              "final-plan",
              async (): Promise<FinalPlan | { moved: RouteDecision } | null> =>
                foreign
                  ? movedNow()
                  : transcriber
                    ? planFinal(d, p.conversationId, p.hash, transcriber)
                    : null,
              retry.media,
            );
            if (planned && "moved" in planned) {
              await handOn(planned.moved);
              return;
            }
            plan = planned;
            if (!plan) return;
          }
          const ctx = await step(
            "final-context",
            () => loadFinalContext(d, p.conversationId),
            retry.db,
          );
          if (!kind.firstPass) {
            parts = [];
            for (const piece of (plan as FinalPlan).pieces) {
              const part = await step(
                "final-transcribe",
                () =>
                  onKit(() =>
                    transcribeFinalPiece(
                      d,
                      piece,
                      transcriber as NonNullable<typeof transcriber>,
                      ctx,
                    ),
                  ),
                retry.transcribe,
              );
              if ("moved" in part) {
                await handOn(part.moved);
                return;
              }
              parts.push(part);
            }
          }
          const done = plan as FinalPlan;
          // The text pass, then redaction, each once over the whole transcript. A failed text
          // pass leaves Whisper's words; redaction that fails stops the run, since an anonymised
          // conversation must never show text that was not redacted.
          const edited = await step(
            "final-edit",
            () => onKit((own) => editFinal(own, p.provider, parts, ctx)),
            retry.llm,
          );
          if ("moved" in edited) {
            await handOn(edited.moved);
            return;
          }
          let redacted: string | null = null;
          if (ctx.anonymized) {
            const text = await step(
              "final-redact",
              () => onKit((own) => redactFinal(own, edited.sentences, ctx)),
              retry.llm,
            );
            if (typeof text !== "string") {
              await handOn(text.moved);
              return;
            }
            redacted = text;
          }
          const assembled =
            redacted !== null
              ? {
                  sentences: [],
                  text: redacted,
                  edit: edited.edit,
                  raw: null,
                }
              : {
                  sentences: edited.sentences,
                  text: edited.sentences.map((s) => s.text).join(" "),
                  edit: edited.edit,
                  raw: edited.raw,
                };
          const stored = await step(
            "final-store",
            () =>
              onKit((own) =>
                storeFinal(
                  d,
                  p.conversationId,
                  p.hash,
                  p.provider,
                  p.record,
                  done,
                  parts,
                  assembled,
                  own.profile,
                ),
              ),
            retry.db,
          );
          if (typeof stored !== "boolean") {
            await handOn(stored.moved);
            return;
          }
          wrote = stored;
          if (wrote && p.record)
            await summarizeWithWebhook(d, p.conversationId, retry, true, false);
        } catch (err) {
          d.logger.warn(
            {
              conversationId: p.conversationId,
              provider: p.provider,
              err: (err as Error).message,
              signal: "conversation.final_transcript_gave_up",
            },
            "final transcript gave up; the live text stays",
          );
        } finally {
          if (!wrote && p.record && !handedOn)
            await step(
              "final-gave-up",
              () => markFinalGaveUp(d, p.conversationId, p.hash),
              retry.db,
            ).catch(() => undefined);
        }
      });
    },

    /** conversations.summarize: the catch-up for a summary that failed or was locked. */
    async summarize(p: { conversationId: string }): Promise<void> {
      await summarizeWithWebhook(d, p.conversationId, retry);
    },
  };
}

/**
 * A call of the final pass that stops because its project left the provider the pass began on.
 * The stop is a result, not a failure: a failure would be retried by the step, and a result
 * is what a resumed run reads back instead of calling the old provider again.
 */
async function unlessMoved<T>(call: () => Promise<T>): Promise<T | { moved: RouteDecision }> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof FinalRouteMoved) return { moved: err.to };
    throw err;
  }
}

/**
 * The final pass began on a provider the project has left, and sent nothing more there. When
 * the provider it is on now has a final pass for this conversation, that one runs in its own
 * run (its transcripts say which provider made them) and this run ends; otherwise the live
 * text stays. Returns whether another run took over.
 */
async function moveOn(
  d: PipelineDeps,
  p: { conversationId: string; provider: string; record: boolean; hash: string },
  to: RouteDecision,
): Promise<boolean> {
  const router = d.speech;
  const kit = router ? (router.kits[to.provider] ?? router.kits[router.default]) : undefined;
  const conv = await conversationStore(d.db).conversation(p.conversationId);
  const next =
    kit?.final && finalTreatment(kit.final, conv?.source) !== "none"
      ? kit.final.providers[0]
      : undefined;
  const handOn = next !== undefined && next !== p.provider;
  d.logger.warn(
    {
      conversationId: p.conversationId,
      provider: p.provider,
      movedTo: to.provider,
      continuedBy: handOn ? next : null,
      signal: "conversation.final_transcript_moved",
    },
    handOn
      ? "the project left this final pass's provider; the rest runs on its new one"
      : "the project left this final pass's provider and its new one has no final pass; the live text stays",
  );
  if (!handOn) return false;
  await d.jobs.enqueue(
    finalTranscript,
    { conversationId: p.conversationId, provider: next, record: p.record, hash: p.hash },
    {
      workflowId: `conversations.final-transcript:${p.conversationId}:${next}:${p.hash}`,
    },
  );
  return true;
}

async function summarizeWithWebhook(
  d: PipelineDeps,
  conversationId: string,
  retry: RetryPolicy,
  fresh = false,
  announce = true,
) {
  let wrote = false;
  try {
    wrote = await step("summarize", () => summarize(d, conversationId, { fresh }), retry.llm);
  } catch (err) {
    // The summary catch-up picks it up again in five minutes.
    d.logger.warn({ conversationId, err: (err as Error).message }, "summary gave up");
  }
  if (wrote && announce)
    await step("summarized-webhook", () => summarizedWebhook(d, conversationId), retry.db);
}
