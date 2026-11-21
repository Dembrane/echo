import { requireAiRequest } from "@dembrane/allowance";
import { type ReplyProject, sampleReply } from "@dembrane/conversations";
import { BadRequestError, StatusError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { modelErrorShape } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { EXPLORE_MODES } from "@dembrane/projects";
import type { Limit } from "@dembrane/ratelimit";
import {
  type Ctx,
  projectOr404,
  requireUpdate,
  topicPromptOf,
  topicsFor,
  writeDraft,
} from "../service";
import { type SampleLanguage, sampleConversation } from "./samples";

/**
 * "Try it" in the portal editor (ECHO-1061): the host's Explore or Verify settings as they
 * are now, saved or not, run on the built-in sample conversation, so the preview shows a
 * real model result in place of the hand-written example.
 *
 * The same prompt builders and model calls as the live features (replyPrompt and replyText
 * in conversations, generationInput and writeDraft here). Nothing is stored: no
 * conversation, transcript, reply or draft. Gates, in order: may edit the project
 * (observers may not), the per-person limit, then the project's AI budget. The spend is
 * filed under the project (payer) and the route (operation), as every host call is.
 *
 * Later: running on one of the project's own conversations, which is the only way to show
 * "look at other conversations". That is a second TrySource, read in transcriptOf; the
 * prompts below take a transcript and other conversations already.
 */

/** Per person: each try is one model call, as suggestions' 20 are; the digest's 10 are several. */
export const TRY_IT_LIMIT: Limit = {
  name: "portal_editor_try_it",
  capacity: 20,
  windowSeconds: 3600,
};

/** The most of a result the dashboard gets; a reply or a draft is far shorter. */
export const TRY_IT_MAX_CHARS = 8_000;

/** What a try runs on. Only the built-in sample today. */
export type TrySource = { readonly kind: "sample" };

export interface TryItRequest {
  readonly kind: "explore" | "verify";
  /** The portal language in the editor now; the sample and the prompts follow it. */
  readonly language: string;
  readonly source: TrySource["kind"];
  /** Explore: the draft mode and custom prompt. */
  readonly get_reply_mode: string | null;
  readonly get_reply_prompt: string | null;
  /** Verify: the topic to draft, built-in or the host's own. */
  readonly topic_key: string | null;
}

export interface TryItResponse {
  readonly kind: "explore" | "verify";
  /** The Explore mode or Verify topic the text belongs to, as the preview's result names it. */
  readonly key: string;
  readonly text: string;
  readonly source: TrySource["kind"];
  /** The sample's language: the request's, or English for one without a sample. */
  readonly language: SampleLanguage;
}

/** The transcript a try reads. The seam for the host's own conversations (see above). */
function transcriptOf(source: TrySource, language: string) {
  switch (source.kind) {
    case "sample":
      return sampleConversation(language);
  }
}

/** The result as the dashboard shows it: trimmed and within the size it accepts. */
export function boundResult(text: string): string {
  return text.trim().slice(0, TRY_IT_MAX_CHARS);
}

type Project = Awaited<ReturnType<typeof projectOr404>>;

/** The Explore prompt's project fields: the saved ones, with the draft mode and prompt. */
export function exploreProject(
  project: Pick<
    Project,
    | "context"
    | "default_conversation_title"
    | "default_conversation_description"
    | "default_conversation_transcript_prompt"
    | "anonymize_transcripts"
  >,
  body: Pick<TryItRequest, "get_reply_mode" | "get_reply_prompt">,
): ReplyProject {
  const mode = (EXPLORE_MODES as readonly string[]).includes(body.get_reply_mode ?? "")
    ? body.get_reply_mode
    : "summarize";
  return {
    context: project.context,
    default_conversation_title: project.default_conversation_title,
    default_conversation_description: project.default_conversation_description,
    default_conversation_transcript_prompt: project.default_conversation_transcript_prompt,
    anonymize_transcripts: project.anonymize_transcripts,
    get_reply_mode: mode,
    get_reply_prompt: body.get_reply_prompt,
  };
}

export async function tryPortalSettings(
  ctx: Ctx,
  who: Signed,
  projectId: string,
  body: TryItRequest,
): Promise<TryItResponse> {
  await requireUpdate(ctx, who, projectId);
  const project = await projectOr404(ctx, projectId);
  const payer = { ref: "project", id: projectId } as const;
  await requireAiRequest(ctx.d, { limit: TRY_IT_LIMIT, userId: who.directusUserId, payer });

  const sample = transcriptOf({ kind: body.source }, body.language);
  const run = async (): Promise<{ key: string; text: string }> => {
    if (body.kind === "explore") {
      const replyProject = exploreProject(project, body);
      return {
        key: replyProject.get_reply_mode ?? "summarize",
        text: await sampleReply(ctx.d.models, {
          project: replyProject,
          language: sample.language,
          transcript: sample.transcript,
        }),
      };
    }
    const key = body.topic_key ?? "";
    const topic = (await topicsFor(ctx, projectId)).find((t) => t.key === key);
    if (!topic?.prompt)
      throw new BadRequestError("verify.topic_unknown", { params: { topic: key } });
    const language = sample.language;
    return {
      key,
      text: await writeDraft(ctx, {
        project: { ...project, language },
        conversationId: "sample",
        topicPrompt: topicPromptOf(topic, language),
        artifacts: [],
        transcript: sample.transcript,
        audio: [],
      }),
    };
  };

  let result: { key: string; text: string };
  try {
    result = await withPayer(payer, run);
    if (!result.text.trim()) throw new Error("empty result");
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    // Never the error itself: the model SDK's errors carry the request body.
    ctx.d.logger.error(
      { error: modelErrorShape(err), kind: body.kind, project: projectId },
      "portal try-it failed",
    );
    throw new StatusError(502, "portal.try_failed");
  }
  return {
    kind: body.kind,
    key: result.key,
    text: boundResult(result.text),
    source: body.source,
    language: sample.language,
  };
}
