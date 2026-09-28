import { conversationTranscript } from "./context";
import type { ChatDeps } from "./deps";
import { pyFloat, renderPrompt } from "./prompts/render";
import type { Row } from "./storage";
import { ensureConversationSummaries } from "./summaries";
import { countMessageTokens, MAX_CHAT_CONTEXT_LENGTH } from "./tokens";

const tagText = (conv: Row) =>
  ((conv.tags as { project_tag_id: { text: string | null } | null }[] | undefined) ?? [])
    .map((t) => t.project_tag_id?.text)
    .filter(Boolean)
    .join(", ");

const withContent = (convs: Row[]) => convs.filter((c) => Number(c.chunks_count ?? 0) > 0);

/**
 * The three system messages of a non-agentic reply (create_system_messages_for_chat):
 * instructions, the project, and the conversations. Overview mode uses every conversation's
 * summary (generated when missing) up to 70% of the context budget; deep dive uses the
 * full transcripts and approved artifacts of the attached conversations.
 */
export async function systemMessagesForChat(
  d: ChatDeps,
  lockedIds: readonly string[],
  language: string,
  projectId: string,
  chatMode: string | null,
): Promise<string[]> {
  const overview = chatMode === "overview";
  let conversations: Row[];
  if (overview) {
    conversations = withContent(await d.reads.overviewConversations(projectId));
    if (conversations.length) {
      await ensureConversationSummaries(
        d,
        conversations.map((c) => c.id as string),
      );
      conversations = withContent(await d.reads.overviewConversations(projectId));
    }
  } else {
    conversations = await d.reads.listByIds(lockedIds);
  }

  const artifacts = new Map<string, Row[]>();
  if (!overview && conversations.length) {
    try {
      for (const a of await d.reads.approvedArtifacts(conversations.map((c) => c.id as string))) {
        const cid = a.conversation_id as string;
        artifacts.set(cid, [...(artifacts.get(cid) ?? []), a]);
      }
    } catch (err) {
      d.logger.warn({ err }, "artifacts for chat context unavailable");
    }
  }

  const project = await d.reads.project(projectId);
  if (!project) throw new Error(`Invalid project id: ${projectId}`);
  const parts: string[] = [];
  if (project.name) parts.push(`name: ${project.name}`);
  if (project.language) parts.push(`language: ${project.language}`);
  if (project.context) parts.push(`context: ${project.context}`);
  if (project.default_conversation_transcript_prompt)
    parts.push(`hotwords (important terms): ${project.default_conversation_transcript_prompt}`);
  if (project.default_conversation_title)
    parts.push(`default conversation title: ${project.default_conversation_title}`);
  if (project.default_conversation_description)
    parts.push(`default conversation description: ${project.default_conversation_description}`);

  const data: Record<string, unknown>[] = [];
  let summaryTokens = 0;
  const maxSummaryTokens = Math.floor(MAX_CHAT_CONTEXT_LENGTH * 0.7);
  for (const conv of conversations) {
    if (overview) {
      const content = (conv.summary as string | null) ?? "";
      if (!content.trim()) continue;
      const tokens = countMessageTokens("user", content);
      if (summaryTokens + tokens > maxSummaryTokens) break;
      summaryTokens += tokens;
      data.push({
        name: conv.participant_name,
        tags: tagText(conv),
        created_at: conv.created_at,
        duration: pyFloat(conv.duration as number | null),
        summary: content,
        artifacts: [],
      });
    } else {
      data.push({
        name: conv.participant_name,
        tags: tagText(conv),
        created_at: conv.created_at,
        duration: pyFloat(conv.duration as number | null),
        transcript: await conversationTranscript(d, conv.id as string),
        artifacts: artifacts.get(conv.id as string) ?? [],
      });
    }
  }

  return [
    renderPrompt("system_chat", language, { is_overview_mode: overview }),
    renderPrompt("context_project", language, { project_context: parts.join("\n") }),
    renderPrompt("context_conversations", language, {
      conversations: data,
      is_overview_mode: overview,
    }),
  ];
}
