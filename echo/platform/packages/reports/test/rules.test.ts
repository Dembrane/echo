import { describe, expect, test } from "bun:test";
import {
  buildReportPrompt,
  type ConversationRow,
  conversationsToSummarise,
  extractArticle,
  modelFailure,
  ReportGenerationError,
} from "../src/generation";
import { pyRepr } from "../src/jinja";
import { renderPrompt } from "../src/prompts";
import { cleanGeneratedTitle, projectContext, selectTagIds } from "../src/summarize";
import recorded from "./recorded/prompts.json";

describe("prompt templates render as Jinja rendered them", () => {
  // Outputs recorded from jinja2 with the Python API's environment (see recorded/prompts.json).
  for (const [i, c] of (
    recorded as { template: string; vars: Record<string, unknown>; output: string }[]
  ).entries()) {
    test(`${c.template} #${i}`, () => {
      const [name, language] = c.template.replace(/\.jinja$/, "").split(/\.(?=[a-z]{2}$)/) as [
        string,
        string,
      ];
      expect(renderPrompt(name, language, c.vars)).toBe(c.output);
    });
  }

  test("a language without a template falls back to English", () => {
    expect(renderPrompt("system_report", "pt", { conversations: [], user_instructions: "" })).toBe(
      renderPrompt("system_report", "en", { conversations: [], user_instructions: "" }),
    );
  });

  test("a template nobody has is an error", () => {
    expect(() => renderPrompt("nope", "en", {})).toThrow(
      "Prompt template nope.en.jinja not found and no default available",
    );
  });

  test("values print as Python's repr", () => {
    expect(pyRepr({ id: "a", n: null, ok: true, q: "it's" })).toBe(
      `{'id': 'a', 'n': None, 'ok': True, 'q': "it's"}`,
    );
  });
});

describe("the model's answer", () => {
  test("the article between tags is kept, trimmed", () => {
    expect(extractArticle("Sure!\n<article>\n# Title\n\nBody\n</article> thanks")).toBe(
      "# Title\n\nBody",
    );
  });
  test("without tags the whole answer is kept, stray tags removed", () => {
    expect(extractArticle("  # Title <article>\nBody  ")).toBe("# Title \nBody");
  });
  test("provider failures read as the Python pipeline recorded them", () => {
    expect(
      modelFailure({ statusCode: 400, message: "input token count exceeds the maximum" }).message,
    ).toBe("Report content too large for the language model");
    expect(modelFailure({ statusCode: 400, message: "bad" }).message).toBe(
      "Invalid request to language model: bad",
    );
    expect(modelFailure({ statusCode: 429, message: "slow down" }).message).toBe(
      "Report generation failed after multiple retries: RateLimitError",
    );
    expect(modelFailure({ statusCode: 503, message: "down" }).message).toBe(
      "Report generation failed after multiple retries: APIError",
    );
    expect(modelFailure(new Error("boom")).message).toBe(
      "Unexpected error during report generation: boom",
    );
  });
});

const conv = (over: Partial<ConversationRow>): ConversationRow => ({
  id: "c",
  participant_name: "P",
  summary: "S",
  created_at: null,
  updated_at: null,
  chunks_count: 1,
  tag_texts: [],
  ...over,
});

describe("what phase one summarises", () => {
  test("no conversations and no content are errors the page shows", () => {
    expect(() => conversationsToSummarise([])).toThrow(
      new ReportGenerationError("No conversations found for project"),
    );
    expect(() => conversationsToSummarise([conv({ chunks_count: 0 })])).toThrow(
      "No conversations with content found for project",
    );
  });
  test("only conversations with chunks and no summary are summarised", () => {
    expect(
      conversationsToSummarise([
        conv({ id: "a", summary: null }),
        conv({ id: "b" }),
        conv({ id: "c", summary: null, chunks_count: 0 }),
      ]),
    ).toEqual({ withChunks: 2, missing: ["a"] });
  });
});

describe("the report prompt", () => {
  test("summaries first, then transcripts while they fit, tags joined", async () => {
    const built = await buildReportPrompt(
      [
        conv({
          id: "a",
          participant_name: "Ann",
          summary: "x".repeat(40),
          tag_texts: ["Energy", "Mobility,"],
        }),
        conv({ id: "b", participant_name: null, summary: "y".repeat(40) }),
      ],
      async (id) => (id === "a" ? "transcript a" : "z".repeat(4000)),
      { language: "en", userInstructions: "", maxTokens: 100 },
    );
    expect(built.conversations).toBe(2);
    expect(built.prompt).toContain("<name>Ann</name>");
    expect(built.prompt).toContain("<tags>Energy, Mobility</tags>");
    expect(built.prompt).toContain(`${"x".repeat(40)}\ntranscript a`);
    expect(built.prompt).toContain("<name>None</name>");
    expect(built.prompt).not.toContain("zzzz");
  });
  test("nothing usable saves the fallback text instead of calling the model", async () => {
    expect(
      await buildReportPrompt([conv({ summary: null })], async () => "", {
        language: "en",
        userInstructions: "",
        maxTokens: 100,
      }),
    ).toEqual({
      prompt: null,
      fallback: "No conversations with sufficient content available for report generation",
      conversations: 0,
    });
  });
});

describe("summaries", () => {
  test("titles keep the first candidate as plain text", () => {
    expect(cleanGeneratedTitle("Here are options:\n1. **Bus Lanes**\n2. Other")).toBe("Bus Lanes");
    expect(cleanGeneratedTitle('"Charging Points"')).toBe("Charging Points");
    expect(cleanGeneratedTitle("")).toBe("");
  });
  test("tag answers keep at most three known ids", () => {
    const allowed = new Set(["t1", "t2", "t3", "t4"]);
    expect(
      selectTagIds(
        '```json\n{"tag_ids": ["t1", "x", {"id": "t2"}, "t1", "t3", "t4"]}\n```',
        allowed,
      ),
    ).toEqual(["t1", "t2", "t3"]);
    expect(selectTagIds("not json", allowed)).toEqual([]);
  });
  test("project context lists what the project says about itself", () => {
    expect(projectContext({ name: "P", context: "C" })).toBe(
      "project context: name: P\ncontext: C",
    );
    expect(projectContext({})).toBeNull();
  });
});
