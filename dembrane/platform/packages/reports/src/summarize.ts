import type { Completer } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import { renderPrompt } from "./prompts";

/**
 * Summarises one conversation. Reports fan summaries out before they generate, so the
 * report workflow takes this as a dependency: the conversations namespace can hand in its
 * own summarizer, and until it does, `summarizeConversation` below is the port of
 * task_summarize_conversation and writes exactly what it wrote.
 */
export interface Summarizer {
  summarize(conversationId: string): Promise<"summarized" | "skipped">;
}

export interface SummarizeDeps {
  readonly sql: postgres.Sql;
  readonly completer: Completer;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Sends conversation.summarized to the project's webhooks. */
  readonly onSummarized?: (projectId: string, conversationId: string) => Promise<unknown>;
}

/** Tiers without an hour cap; a locked conversation on any other tier is never summarised. */
const OVERAGE_TIERS = new Set(["innovator", "changemaker", "guardian"]);
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
};

/** _clean_generated_title: the first candidate of a list or preamble answer, as plain text. */
export function cleanGeneratedTitle(content: string): string {
  const lines = content
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const listItem = /^(?:[-*•]\s+|\d+[.):]\s+)(.+)$/;
  let candidate = "";
  for (const line of lines) {
    const m = listItem.exec(line);
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
  return strip(strip(candidate.trim(), "\"'“”‘’").trim(), " \t\n\r");
}

function strip(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a] as string)) a++;
  while (b > a && chars.includes(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

/** _select_valid_tag_ids_from_response: at most three known tag ids, first come first kept. */
export function selectTagIds(content: string, allowed: ReadonlySet<string>, max = 3): string[] {
  let stripped = content.trim();
  if (stripped.startsWith("```")) {
    stripped = stripped.startsWith("```json") ? stripped.slice(7) : stripped.slice(3);
    stripped = stripped.trim();
    if (stripped.endsWith("```")) stripped = stripped.slice(0, -3);
    stripped = stripped.trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  let raw: unknown[];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const v = (truthyList(o.tag_ids) ? o.tag_ids : o.tags) ?? [];
    raw = Array.isArray(v) ? v : [];
  } else if (Array.isArray(parsed)) raw = parsed;
  else return [];
  const out: string[] = [];
  for (const r of raw) {
    const id = r && typeof r === "object" ? (r as Record<string, unknown>).id : r;
    if (typeof id !== "string") continue;
    const t = id.trim();
    if (allowed.has(t) && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const truthyList = (v: unknown) => Array.isArray(v) && v.length > 0;

/** project_service.get_context_for_prompt. */
export function projectContext(p: Record<string, unknown>): string | null {
  const b: string[] = [];
  if (p.name) b.push(`name: ${p.name}`);
  if (p.context) b.push(`context: ${p.context}`);
  if (p.default_conversation_transcript_prompt)
    b.push(`hotwords that the user set: ${p.default_conversation_transcript_prompt}`);
  if (p.default_conversation_title)
    b.push(
      `default title that was shown to the user (not always relevant but might add context): ${p.default_conversation_title}`,
    );
  if (p.default_conversation_description)
    b.push(
      `default question that was shown to the user (not always relevant but might add context): ${p.default_conversation_description}`,
    );
  return b.length ? `project context: ${b.join("\n")}` : null;
}

export function summarizeConversation(d: SummarizeDeps): Summarizer {
  const { sql } = d;
  return {
    async summarize(conversationId) {
      const [conv] = await sql`select c.*, p.deleted_at as project_deleted_at, p.workspace_id,
          ba.tier
        from conversation c
        left join project p on p.id = c.project_id
        left join workspace w on w.id = p.workspace_id
        left join billing_account ba on ba.id = w.billing_account_id
        where c.id = ${conversationId} and c.deleted_at is null`;
      if (!conv?.project_id || conv.project_deleted_at) return "skipped";
      if (conv.is_finished && conv.summary) return "skipped";
      // Free's hour cap locks a conversation; its summary waits for an upgrade.
      if (conv.is_over_cap && conv.workspace_id && conv.tier && !OVERAGE_TIERS.has(conv.tier))
        return "skipped";

      const started = performance.now();
      try {
        await summarizeNow(d, conv as Record<string, unknown>);
      } catch (err) {
        await status(d, conversationId, "task_summarize_conversation.failed", String(err), started);
        throw err;
      }
      await status(d, conversationId, "task_summarize_conversation.completed", "", started);
      await d.onSummarized?.(String(conv.project_id), conversationId);
      return "summarized";
    },
  };
}

async function status(
  d: SummarizeDeps,
  conversationId: string,
  event: string,
  message: string,
  started: number,
) {
  await d.sql`insert into processing_status (conversation_id, event, message, duration_ms, timestamp)
    values (${conversationId}, ${event}, ${message}, ${Math.round(performance.now() - started)},
            ${d.now().toISOString()})`;
}

async function summarizeNow(d: SummarizeDeps, conv: Record<string, unknown>) {
  const { sql } = d;
  const conversationId = String(conv.id);
  const [project] = await sql`select * from project where id = ${conv.project_id as string}`;
  if (!project) throw new Error("Project not found");
  const chunks = await sql`select transcript from conversation_chunk
    where conversation_id = ${conversationId} order by timestamp nulls last, id limit 1500`;
  const transcript = chunks
    .map((c) => c.transcript as string | null)
    .filter((t): t is string => Boolean(t))
    .join("\n");
  const now = d.now().toISOString();
  if (transcript === "") {
    if (conv.is_all_chunks_transcribed || conv.is_finished)
      await sql`update conversation set summary = '[No transcript available]', updated_at = ${now}
        where id = ${conversationId}`;
    return;
  }
  const artifacts = await sql`select id, key, content from conversation_artifact
    where conversation_id = ${conversationId} and approved_at is not null
    order by approved_at desc nulls last limit 3`;
  const language = (project.language as string | null) || "en";
  const summaryPrompt = renderPrompt("generate_conversation_summary", language, {
    quote_text_joined: transcript,
    project_context: projectContext(project),
    // Rendered with Python's repr, as the Jinja template printed the Directus dicts.
    verified_artifacts: artifacts.map((a) => ({ id: a.id, key: a.key, content: a.content })),
    conversation_title: conv.title ?? null,
  });
  const summary = (await d.completer.complete({ group: "multi_modal_pro", user: summaryPrompt }))
    .text;
  const update: Record<string, unknown> = { summary };
  if (project.enable_ai_title_and_tags && summary) {
    try {
      const titles = await sql`select title from conversation
        where project_id = ${project.id as string} and title is not null and deleted_at is null
        order by created_at desc nulls last limit 10`;
      const titlePrompt = renderPrompt("generate_conversation_title", "en", {
        summary,
        language_name: LANGUAGE_NAMES[language] ?? "English",
        existing_titles: titles.map((t) => t.title),
        custom_prompt: project.conversation_title_prompt ?? null,
      });
      const title = cleanGeneratedTitle(
        (await d.completer.complete({ group: "multi_modal_fast", user: titlePrompt })).text,
      );
      if (title) update.title = title;
    } catch (err) {
      d.logger.error({ err, conversationId }, "title generation failed");
    }
    try {
      const tags = (
        await sql`select id, text from project_tag where project_id = ${project.id as string}
          order by sort nulls last, id`
      )
        .filter((t) => typeof t.text === "string" && (t.text as string).trim())
        .map((t) => ({ id: String(t.id), text: (t.text as string).trim() }));
      if (tags.length && summary.trim()) {
        const tagPrompt = renderPrompt("generate_conversation_tag_ids", "en", {
          summary,
          language_name: LANGUAGE_NAMES[language] ?? "English",
          project_tags: tags,
          max_tags: 3,
        });
        const answer = await d.completer.complete({ group: "multi_modal_fast", user: tagPrompt });
        const ids = selectTagIds(answer.text, new Set(tags.map((t) => t.id)));
        const current = new Set(
          (
            await sql`select project_tag_id from conversation_project_tag
              where conversation_id = ${conversationId}`
          ).map((r) => String(r.project_tag_id)),
        );
        for (const id of ids) {
          if (current.has(id)) continue;
          await sql`insert into conversation_project_tag (conversation_id, project_tag_id)
            values (${conversationId}, ${id})`;
          current.add(id);
        }
      }
    } catch (err) {
      d.logger.error({ err, conversationId }, "draft tag assignment failed");
    }
  }
  await sql`update conversation set summary = ${update.summary as string},
      title = ${(update.title as string | undefined) ?? (conv.title as string | null) ?? null},
      updated_at = ${now}
    where id = ${conversationId}`;
}
