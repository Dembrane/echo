import type { Models } from "@echo/llm";
import { renderPrompt } from "@echo/prompts";
import { generateText } from "ai";

/**
 * The conversation LLM helpers of stateless.py: summary on multi_modal_pro, title and
 * draft tags on multi_modal_fast, each one user message with the rendered prompt and no
 * other parameters, as router_completion sent them.
 */

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
};

async function complete(
  models: Models,
  group: "multi_modal_pro" | "multi_modal_fast",
  prompt: string,
) {
  // Retries and fallback live in the model group, as they did in the LiteLLM router.
  const { text } = await generateText({
    model: models.model(group),
    messages: [{ role: "user", content: prompt }],
    maxRetries: 0,
  });
  return text;
}

export async function generateSummary(
  models: Models,
  transcript: string,
  language: string | null,
  projectContext: string | null,
  verifiedArtifacts: readonly Record<string, unknown>[],
  conversationTitle: string | null,
): Promise<string> {
  const prompt = renderPrompt("generate_conversation_summary", language || "en", {
    quote_text_joined: transcript,
    project_context: projectContext,
    verified_artifacts: verifiedArtifacts,
    conversation_title: conversationTitle,
  });
  return complete(models, "multi_modal_pro", prompt);
}

/**
 * _clean_generated_title: the model sometimes lists options or wraps the title in quotes
 * or markdown; keep the first candidate as plain text.
 */
export function cleanGeneratedTitle(content: string): string {
  const lines = content
    .split(/\r\n|\r|\n/)
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
      // Skip a preamble like "Here are some options:" when more lines follow.
      if (line.endsWith(":") && i < lines.length - 1) continue;
      candidate = line;
      break;
    }
  }
  candidate = candidate.replace(/^\*\*(.+?)\*\*$/, "$1");
  return pyStrip(pyStrip(candidate).replace(/^["'“”‘’]+|["'“”‘’]+$/g, ""));
}

/** Python's str.strip(): whitespace only, which trim() also covers for these inputs. */
function pyStrip(s: string): string {
  return s.trim();
}

export async function generateConversationTitle(
  models: Models,
  summary: string,
  language: string | null,
  existingTitles: readonly string[],
  customPrompt: string | null,
): Promise<string> {
  const prompt = renderPrompt("generate_conversation_title", "en", {
    summary,
    language_name: LANGUAGE_NAMES[language || "en"] ?? "English",
    existing_titles: existingTitles,
    custom_prompt: customPrompt,
  });
  return cleanGeneratedTitle(await complete(models, "multi_modal_fast", prompt));
}

function extractJson(content: string): unknown {
  let s = content.trim();
  if (s.startsWith("```")) {
    if (s.startsWith("```json")) s = s.slice(7);
    else if (s.startsWith("```")) s = s.slice(3);
    s = s.trim();
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  return JSON.parse(s);
}

/** Tag ids the model chose that exist in the vocabulary, in its order, at most three. */
export function selectValidTagIds(
  content: string,
  allowed: ReadonlySet<string>,
  maxTags = 3,
): string[] {
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return [];
  }
  let raw: unknown[];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const v = (truthy(o.tag_ids) ? o.tag_ids : truthy(o.tags) ? o.tags : []) as unknown;
    raw = Array.isArray(v) ? v : [];
  } else if (Array.isArray(parsed)) raw = parsed;
  else return [];
  const out: string[] = [];
  for (const r of raw) {
    let id: unknown =
      r && typeof r === "object" && !Array.isArray(r) ? (r as { id?: unknown }).id : r;
    if (typeof id !== "string") continue;
    id = id.trim();
    if (allowed.has(id as string) && !out.includes(id as string)) out.push(id as string);
    if (out.length >= maxTags) break;
  }
  return out;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Existing project tags that fit the summary. Never creates tags: a draft for review. */
export async function generateConversationTagIds(
  models: Models,
  summary: string,
  language: string | null,
  projectTags: readonly { id: string; text: string }[],
): Promise<string[]> {
  const allowed = new Set(projectTags.map((t) => t.id));
  if (!summary.trim() || !allowed.size) return [];
  const prompt = renderPrompt("generate_conversation_tag_ids", "en", {
    summary,
    language_name: LANGUAGE_NAMES[language || "en"] ?? "English",
    project_tags: projectTags,
    max_tags: 3,
  });
  return selectValidTagIds(await complete(models, "multi_modal_fast", prompt), allowed);
}
