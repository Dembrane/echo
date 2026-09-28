import { conversationTranscript } from "./context";
import type { ChatDeps } from "./deps";
import { complete } from "./llm";
import { renderPrompt } from "./prompts/render";
import { conversationIsLocked } from "./tiers";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
};

/** project_service.get_context_for_prompt: the host's framing, or null when there is none. */
export function projectContextForPrompt(project: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (project.name) parts.push(`name: ${project.name}`);
  if (project.context) parts.push(`context: ${project.context}`);
  if (project.default_conversation_transcript_prompt)
    parts.push(`hotwords that the user set: ${project.default_conversation_transcript_prompt}`);
  if (project.default_conversation_title)
    parts.push(
      `default title that was shown to the user (not always relevant but might add context): ${project.default_conversation_title}`,
    );
  if (project.default_conversation_description)
    parts.push(
      `default question that was shown to the user (not always relevant but might add context): ${project.default_conversation_description}`,
    );
  return parts.length ? `project context: ${parts.join("\n")}` : null;
}

/** The model sometimes lists options or quotes the title; keep the first candidate as plain text. */
export function cleanGeneratedTitle(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  let candidate = "";
  for (const line of lines) {
    const m = /^(?:[-*•]\s+|\d+[.):]\s+)(.+)$/.exec(line);
    if (m) {
      candidate = m[1] as string;
      break;
    }
  }
  if (!candidate) {
    for (const [i, line] of lines.entries()) {
      if (line.endsWith(":") && i < lines.length - 1) continue;
      candidate = line;
      break;
    }
  }
  candidate = candidate.replace(/^\*\*(.+?)\*\*$/, "$1");
  return candidate
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

function tagIdsFrom(content: string, allowed: Set<string>): string[] {
  let text = content.trim();
  if (text.startsWith("```")) {
    text = text
      .replace(/^```json/, "")
      .replace(/^```/, "")
      .trim();
    text = text.replace(/```$/, "").trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const raw: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (((parsed as Record<string, unknown>).tag_ids ??
          (parsed as Record<string, unknown>).tags ??
          []) as unknown[])
      : [];
  const out: string[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const id = r && typeof r === "object" ? (r as { id?: unknown }).id : r;
    if (typeof id !== "string") continue;
    const t = id.trim();
    if (allowed.has(t) && !out.includes(t)) out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Generates and stores one conversation's summary, as POST /conversations/{id}/summarize
 * did when overview mode called it: the summary, and when the project opted into AI
 * titles and tags, a title and up to three existing project tags. Throws on failure; the
 * batch caller counts it.
 */
export async function summarizeConversation(d: ChatDeps, conversationId: string): Promise<void> {
  const conv = await d.reads.liveConversation(conversationId);
  if (!conv) throw new Error("Conversation not found");
  const projectId = conv.project_id as string;
  const tier = await d.reads.projectTier(projectId);
  if (conversationIsLocked(conv, tier))
    throw new Error("Conversation is locked. Upgrade to generate a summary.");
  const project = (await d.reads.project(projectId)) ?? {};
  const transcript = await conversationTranscript(d, conversationId);
  const language = (project.language as string | null) || "en";
  if (transcript === "") {
    if (conv.is_all_chunks_transcribed || conv.is_finished)
      await d.reads.updateConversation(
        conversationId,
        { summary: "[No transcript available]" },
        d.now(),
      );
    return;
  }
  const prompt = renderPrompt("generate_conversation_summary", language, {
    quote_text_joined: transcript,
    project_context: projectContextForPrompt(project),
    verified_artifacts: await d.reads.verifiedArtifacts(conversationId),
    conversation_title: conv.title ?? null,
  });
  const summary =
    (await complete(d.models, "multi_modal_pro", [{ role: "user", content: prompt }])) ?? "";
  const update: Record<string, unknown> = { summary };
  if (project.enable_ai_title_and_tags && summary) {
    const languageName = LANGUAGE_NAMES[language] ?? "English";
    try {
      const titlePrompt = renderPrompt("generate_conversation_title", "en", {
        summary,
        language_name: languageName,
        existing_titles: await d.reads.recentTitles(projectId, 10),
        custom_prompt: project.conversation_title_prompt ?? null,
      });
      const raw = await complete(d.models, "multi_modal_fast", [
        { role: "user", content: titlePrompt },
      ]);
      const title = raw ? cleanGeneratedTitle(raw) : "";
      if (title) update.title = title;
    } catch (err) {
      d.logger.warn({ err, conversationId }, "conversation title not generated");
    }
    try {
      const tags = await d.reads.projectTags(projectId);
      if (tags.length) {
        const tagPrompt = renderPrompt("generate_conversation_tag_ids", "en", {
          summary,
          language_name: languageName,
          project_tags: tags,
          max_tags: 3,
        });
        const raw = await complete(d.models, "multi_modal_fast", [
          { role: "user", content: tagPrompt },
        ]);
        const chosen = raw ? tagIdsFrom(raw, new Set(tags.map((t) => t.id))) : [];
        const current = await d.reads.conversationTagIds(conversationId);
        for (const id of chosen) {
          if (current.has(id)) continue;
          await d.reads.addConversationTag(conversationId, id);
          current.add(id);
        }
      }
    } catch (err) {
      d.logger.warn({ err, conversationId }, "draft tags not assigned");
    }
  }
  await d.reads.updateConversation(conversationId, update, d.now());
}

/**
 * Makes sure each conversation has a summary, generating the missing ones five at a time.
 * Returns the ids that have one afterwards (existing or new) and those that failed.
 */
export async function ensureConversationSummaries(d: ChatDeps, ids: readonly string[]) {
  const succeeded: string[] = [];
  const failed: string[] = [];
  if (!ids.length) return { succeeded, failed };
  const existing = await d.reads.summaries(ids);
  const have = new Set(
    [...existing].filter(([, s]) => s && String(s).trim().length > 0).map(([id]) => id),
  );
  succeeded.push(...have);
  const todo = ids.filter((id) => !have.has(id));
  for (let i = 0; i < todo.length; i += 5) {
    const batch = todo.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((id) =>
        summarizeConversation(d, id).then(
          () => true,
          (err) => {
            d.logger.warn({ err, conversationId: id }, "summary failed");
            return false;
          },
        ),
      ),
    );
    batch.forEach((id, j) => {
      (results[j] ? succeeded : failed).push(id);
    });
  }
  return { succeeded, failed };
}
