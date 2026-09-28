import { BadRequestError, NotFoundError, PaymentRequiredError } from "@dembrane/core";
import type { ConversationsDeps } from "../deps";
import { isConversationLocked, resolveProjectTier } from "../tiers";
import { generateConversationTagIds, generateConversationTitle, generateSummary } from "./llm";
import { type V1Store, v1Store } from "./storage";

type SummaryDeps = Pick<ConversationsDeps, "db" | "models" | "logger" | "now">;

/** get_conversation_transcript without the access check: chunk transcripts joined by newlines. */
export async function conversationTranscript(store: V1Store, conversationId: string) {
  const chunks = await store.transcriptChunks(conversationId);
  return chunks
    .filter((c) => c.transcript)
    .map((c) => c.transcript as string)
    .join("\n");
}

/** project_service.get_context_for_prompt: the project facts the summary prompt reads. */
export async function projectContext(store: V1Store, projectId: string): Promise<string | null> {
  const p = await store.liveProject(projectId);
  if (!p) throw new NotFoundError("Project not found");
  const parts: string[] = [];
  if (p.name) parts.push(`name: ${p.name}`);
  if (p.context) parts.push(`context: ${p.context}`);
  if (p.default_conversation_transcript_prompt)
    parts.push(`hotwords that the user set: ${p.default_conversation_transcript_prompt}`);
  if (p.default_conversation_title)
    parts.push(
      `default title that was shown to the user (not always relevant but might add context): ${p.default_conversation_title}`,
    );
  if (p.default_conversation_description)
    parts.push(
      `default question that was shown to the user (not always relevant but might add context): ${p.default_conversation_description}`,
    );
  return parts.length ? `project context: ${parts.join("\n")}` : null;
}

/** The hours-cap gate shared by summarize and generate-title: 402 with the route's text. */
export async function assertNotLocked(
  d: Pick<ConversationsDeps, "db">,
  conversationId: string,
  detail: string,
) {
  const conv = await v1Store(d.db).conversation(conversationId);
  const tier = conv?.project_id ? await resolveProjectTier(d.db, conv.project_id) : null;
  if (isConversationLocked(conv ?? {}, tier)) throw new PaymentRequiredError(detail);
  return conv;
}

/**
 * summarize_conversation after its access check: the summary from the transcript, the
 * project context and the verified artifacts; with AI titles and tags on, a title and
 * up to three draft tags from the project's own vocabulary. Stores what it made and
 * answers the route's body. Title and tag failures are logged and skipped, as before.
 */
export async function summarizeAndStore(
  d: SummaryDeps,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const store = v1Store(d.db);
  const conv = await assertNotLocked(
    d,
    conversationId,
    "Conversation is locked. Upgrade to generate a summary.",
  );
  if (!conv) throw new NotFoundError("Conversation not found");
  const project = await store.projectAny(conv.project_id);
  const title = conv.title ?? null;

  const [transcript, context, artifacts] = await Promise.all([
    conversationTranscript(store, conversationId),
    projectContext(store, conv.project_id),
    store.verifiedArtifacts(conversationId),
  ]);
  const language = project?.language ?? null;

  if (transcript === "") {
    if (conv.is_all_chunks_transcribed || conv.is_finished)
      await store.updateConversation(
        conversationId,
        { summary: "[No transcript available]" },
        d.now(),
      );
    return { status: "success", message: "Transcript is empty, so no summary was generated" };
  }

  const summary = await generateSummary(
    d.models,
    transcript,
    language || "en",
    context,
    artifacts,
    title,
  );
  const update: { summary: string; title?: string } = { summary };
  let newTitle: string | null = null;
  let assigned: string[] = [];

  if (project?.enable_ai_title_and_tags && summary) {
    try {
      const existing = await store.recentTitles(project.id, 10);
      newTitle = await generateConversationTitle(
        d.models,
        summary,
        language || "en",
        existing,
        project.conversation_title_prompt ?? null,
      );
      if (newTitle) update.title = newTitle;
    } catch (err) {
      d.logger.error({ err, conversationId }, "title generation failed");
      newTitle = null;
    }
    try {
      const tags = (await store.projectTags(project.id))
        .filter((t) => typeof t.text === "string" && t.text.trim())
        .map((t) => ({ id: t.id, text: (t.text as string).trim() }));
      if (tags.length) {
        const ids = await generateConversationTagIds(d.models, summary, language || "en", tags);
        if (ids.length) assigned = await addTags(d, store, conversationId, ids);
      }
    } catch (err) {
      d.logger.error({ err, conversationId }, "draft tag assignment failed");
    }
  }

  await store.updateConversation(conversationId, update, d.now());
  const body: Record<string, unknown> = {
    status: "success",
    message: "Summary generated",
    summary,
  };
  if (newTitle) body.title = newTitle;
  if (assigned.length) body.tag_ids = assigned;
  return body;
}

/** Links the chosen tags the conversation does not carry yet; one failure skips that tag. */
async function addTags(d: SummaryDeps, store: V1Store, conversationId: string, ids: string[]) {
  const current = await store.currentTagIds(conversationId);
  const added: string[] = [];
  for (const id of ids) {
    if (current.has(id)) continue;
    try {
      await store.addTag(conversationId, id);
      added.push(id);
      current.add(id);
    } catch (err) {
      d.logger.error({ err, conversationId, tag: id }, "conversation tag create failed");
    }
  }
  return added;
}

/** generate_title_for_conversation after its access check. */
export async function generateTitleAndStore(
  d: SummaryDeps,
  conversationId: string,
): Promise<{ title: string }> {
  const store = v1Store(d.db);
  const conv = await assertNotLocked(
    d,
    conversationId,
    "Conversation is locked. Upgrade to generate a title.",
  );
  if (!conv) throw new NotFoundError("Conversation not found");
  if (!conv.summary)
    throw new BadRequestError("Conversation has no summary. Generate a summary first.");
  const project = await store.projectAny(conv.project_id);
  const language = project?.language ?? "en";
  const existing = await store.recentTitles(conv.project_id, 10);
  const title = await generateConversationTitle(
    d.models,
    conv.summary,
    language || "en",
    existing,
    project?.conversation_title_prompt ?? null,
  );
  if (title) await store.updateConversation(conversationId, { title }, d.now());
  return { title: title || "" };
}
