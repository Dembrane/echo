import { renderPrompt } from "./prompts";

/** A failure the page may show as the report's error, recorded as GENERATION_FAILED. */
export class ReportGenerationError extends Error {
  override readonly name = "ReportGenerationError";
}

export interface ConversationRow {
  readonly id: string;
  readonly participant_name: string | null;
  readonly summary: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly chunks_count: number;
  readonly tag_texts: readonly string[];
}

/** Which conversations phase one must summarise, or why no report can be made. */
export function conversationsToSummarise(rows: readonly ConversationRow[]): {
  withChunks: number;
  missing: string[];
} {
  if (!rows.length) throw new ReportGenerationError("No conversations found for project");
  const withChunks = rows.filter((r) => Number(r.chunks_count) > 0);
  if (!withChunks.length)
    throw new ReportGenerationError("No conversations with content found for project");
  return {
    withChunks: withChunks.length,
    missing: withChunks.filter((r) => !r.summary).map((r) => r.id),
  };
}

/**
 * litellm's token_counter could not name Gemini models, so the Python code counted with
 * its fallback in practice: a quarter of the characters. The budget stays that estimate.
 */
export const estimateTokens = (text: string) => Math.floor(text.length / 4);

export interface Built {
  readonly prompt: string | null;
  /** Content saved when there is nothing to send to the model. */
  readonly fallback: string | null;
  readonly conversations: number;
}

/**
 * generate_report_after_summaries up to the model call: summaries in update order until
 * the context budget, then each included conversation's transcript while it still fits,
 * rendered into system_report in the report's language.
 */
export async function buildReportPrompt(
  rows: readonly ConversationRow[],
  transcript: (conversationId: string) => Promise<string | null>,
  opts: { language: string; userInstructions: string; maxTokens: number },
): Promise<Built> {
  if (!rows.length)
    return { prompt: null, fallback: "No conversations available for report", conversations: 0 };
  const data = new Map<
    string,
    {
      name: string | null;
      tags: string;
      transcript: string;
      created_at: string | null;
      updated_at: string | null;
    }
  >();
  let tokens = 0;
  for (const r of rows) {
    if (!r.id || Number(r.chunks_count) === 0 || !r.summary) continue;
    const n = estimateTokens(r.summary);
    if (tokens + n >= opts.maxTokens) break;
    data.set(r.id, {
      name: r.participant_name,
      tags: r.tag_texts
        .filter(Boolean)
        .map((t) => `${t}, `)
        .join("")
        .replace(/[, ]+$/, ""),
      transcript: r.summary,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
    tokens += n;
  }
  for (const r of rows) {
    const entry = data.get(r.id);
    if (!entry) continue;
    const t = await transcript(r.id);
    if (t === null || t === "") continue;
    const n = estimateTokens(t);
    if (tokens + n < opts.maxTokens) {
      entry.transcript += `\n${t}`;
      tokens += n;
    } else break;
  }
  if (!data.size)
    return {
      prompt: null,
      fallback: "No conversations with sufficient content available for report generation",
      conversations: 0,
    };
  return {
    prompt: renderPrompt("system_report", opts.language, {
      conversations: [...data.values()],
      user_instructions: opts.userInstructions,
    }),
    fallback: null,
    conversations: data.size,
  };
}

/** The article between <article> tags, or the whole answer with stray tags removed. */
export function extractArticle(response: string): string {
  const m = /<article>([\s\S]*?)<\/article>/.exec(response);
  if (m) return (m[1] as string).trim();
  return response.replaceAll("<article>", "").replaceAll("</article>", "").trim();
}

/**
 * The texts the Python pipeline recorded for a failed model call, keyed by the litellm
 * exception it would have raised for the provider's answer.
 */
export function modelFailure(err: unknown): ReportGenerationError {
  const e = (err ?? {}) as { statusCode?: number; name?: string; message?: string };
  const message = e.message ?? String(err);
  if (e.statusCode === 400) {
    if (/context|token count|too long|exceeds the maximum/i.test(message))
      return new ReportGenerationError("Report content too large for the language model");
    if (/safety|policy|blocked/i.test(message))
      return new ReportGenerationError("Report content violates content policy");
    return new ReportGenerationError(`Invalid request to language model: ${message}`);
  }
  if (e.statusCode === 429)
    return new ReportGenerationError(
      "Report generation failed after multiple retries: RateLimitError",
    );
  if (e.name === "TimeoutError" || e.name === "AbortError")
    return new ReportGenerationError("Report generation failed after multiple retries: Timeout");
  if (typeof e.statusCode === "number")
    return new ReportGenerationError("Report generation failed after multiple retries: APIError");
  return new ReportGenerationError(`Unexpected error during report generation: ${message}`);
}
