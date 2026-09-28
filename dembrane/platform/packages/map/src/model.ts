import { dataBlock, jsonFromText } from "@dembrane/analysis";
import type { Completer } from "@dembrane/llm";
import classifyPrompt from "./prompts/map-factcheck-classify-v2.md" with { type: "text" };
import investigatePrompt from "./prompts/map-factcheck-investigate-v2.md" with { type: "text" };
import titlePrompt from "./prompts/map-title-v2.md" with { type: "text" };

/**
 * Model calls for Map: selection titles and fact-checks, on the fast multimodal group. A
 * prompt iteration is a new file and a new version constant, never an edit in place, so a
 * saved verdict names the prompts that produced it.
 */

export const TITLE_PROMPT = "map-title-v2";
export const FACTCHECK_INVESTIGATE_PROMPT = "map-factcheck-investigate-v2";
export const FACTCHECK_CLASSIFY_PROMPT = "map-factcheck-classify-v2";
export const FACTCHECK_PROMPT_VERSION = `${FACTCHECK_INVESTIGATE_PROMPT}+${FACTCHECK_CLASSIFY_PROMPT}`;
export const TITLE_MAX_TOKENS = 2048;
export const TITLE_TIMEOUT_MS = 60_000;
export const FACTCHECK_MAX_TOKENS = 4096;
export const FACTCHECK_TIMEOUT_MS = 180_000;
const GROUP = "multi_modal_fast" as const;

export const FACTCHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "justification"],
  properties: {
    verdict: { type: "string", enum: ["true", "false", "contested", "unknown"] },
    justification: { type: "string", minLength: 1 },
  },
};

const collapse = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

function projectBlock(name: string, context: string): string[] {
  const lines: string[] = [];
  if (name.trim()) lines.push(`Name: ${name.trim()}`);
  if (context.trim()) lines.push(`Context: ${context.trim()}`);
  return lines.length ? [dataBlock("PROJECT", lines.join("\n"))] : [];
}

/** A one-sentence title for a settled selection, from every selected line. */
export async function titleSelection(
  completer: Completer,
  o: { lines: readonly string[]; projectName: string; projectContext: string },
): Promise<string> {
  const user = [
    ...projectBlock(o.projectName, o.projectContext),
    `Arguments in cluster (sorted by relevance):\n${dataBlock("ARGUMENTS", o.lines.join("\n"))}`,
    "Distill the core idea into one clear, concise sentence (8-15 words) that captures what makes this cluster unique within the project context.",
  ].join("\n\n");
  const response = await completer.complete({
    group: GROUP,
    system: titlePrompt,
    user,
    temperature: 0,
    maxTokens: TITLE_MAX_TOKENS,
    // A title follows the analyst's cursor: thinking off for latency.
    thinkingBudget: 0,
    timeoutMs: TITLE_TIMEOUT_MS,
  });
  const lines = response.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = (lines[0] ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  const title = collapse(first);
  if (!title) throw new Error("the title answer was empty");
  return title;
}

export interface FactCheckOutcome {
  readonly verdict: string;
  readonly justification: string;
  readonly sources: { url: string; title: string }[];
}

/** Investigates a claim with Search grounding, then classifies the finding. */
export async function factcheckClaim(
  completer: Completer,
  o: {
    statement: string;
    evidence: readonly string[];
    projectName: string;
    projectContext: string;
  },
): Promise<FactCheckOutcome> {
  const user = [
    ...projectBlock(o.projectName, o.projectContext),
    dataBlock("CLAIM", o.statement),
    `The speaker's own words: do not fact-check these, use them only to understand what the speaker meant.\n${dataBlock(
      "EVIDENCE",
      o.evidence.map((quote) => `- "${quote}"`).join("\n"),
    )}`,
  ].join("\n\n");
  const investigation = await completer.complete({
    group: GROUP,
    system: investigatePrompt,
    user,
    googleSearch: true,
    temperature: 0,
    maxTokens: FACTCHECK_MAX_TOKENS,
    timeoutMs: FACTCHECK_TIMEOUT_MS,
  });
  const analysis = investigation.text.trim();
  if (!analysis) throw new Error("the fact-check investigation came back empty");
  const classification = await completer.complete({
    group: GROUP,
    system: classifyPrompt,
    user: `${dataBlock("CLAIM", o.statement)}\n\n${dataBlock("ANALYSIS", analysis)}`,
    temperature: 0,
    maxTokens: FACTCHECK_MAX_TOKENS,
    jsonSchema: FACTCHECK_SCHEMA,
    timeoutMs: FACTCHECK_TIMEOUT_MS,
  });
  let verdict = "unknown";
  let justification = analysis;
  try {
    const parsed = jsonFromText(classification.text);
    if (["true", "false", "contested", "unknown"].includes(String(parsed.verdict)))
      verdict = String(parsed.verdict);
    if (typeof parsed.justification === "string" && parsed.justification.trim())
      justification = parsed.justification.trim();
  } catch {
    // The prototype's fallback: the analysis stands in for the justification.
  }
  return { verdict, justification: collapse(justification), sources: [...investigation.sources] };
}
