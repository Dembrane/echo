import { describe, expect, test } from "bun:test";
import { replyPrompt, sampleReply } from "@dembrane/conversations";
import { LOCALES } from "@dembrane/i18n";
import { fakeModels } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { generationInput } from "../src/service";
import { SAMPLE_LANGUAGES, sampleConversation } from "../src/try-it/samples";
import { boundResult, exploreProject, TRY_IT_MAX_CHARS } from "../src/try-it/service";

// ECHO-1061: the portal editor's "Try it", without a database. The routes' gates and the
// promise to store nothing are in try-it.integration.test.ts.

/** The text parts of a prompt as the fake model receives it. */
type Prompt = readonly { content: string | readonly { type: string; text?: string }[] }[];
const textOf = (prompt: unknown) =>
  (prompt as Prompt)
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])),
    )
    .join("\n");

const saved = {
  context: "Resident evenings on the park by the library.",
  default_conversation_title: "The park",
  default_conversation_description: "Tell us what the park needs.",
  default_conversation_transcript_prompt: "Lindepark, Lindenwijk",
  anonymize_transcripts: true,
};

describe("the sample conversation", () => {
  test("exists in every portal language, about two minutes of several speakers", () => {
    expect([...SAMPLE_LANGUAGES].sort()).toEqual(["cs", "de", "en", "es", "fr", "it", "nl", "uk"]);
    for (const language of SAMPLE_LANGUAGES) {
      const { transcript } = sampleConversation(language);
      const words = transcript.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThan(240);
      expect(words).toBeLessThan(420);
      expect(transcript.split("\n").length).toBeGreaterThanOrEqual(12);
    }
  });

  test("follows the portal language, and English for one without a sample", () => {
    expect(sampleConversation("nl-NL").language).toBe("nl");
    expect(sampleConversation("uk").language).toBe("uk");
    expect(sampleConversation("pt").language).toBe("en");
    expect(sampleConversation(null).language).toBe("en");
  });

  test("there is a sample for every locale resolveLocale returns", () => {
    expect<string[]>([...SAMPLE_LANGUAGES].sort()).toEqual(
      LOCALES.map((l) => l.slice(0, 2)).sort(),
    );
  });
});

describe("Explore on the sample", () => {
  test("takes the draft mode and prompt over the saved project", () => {
    const p = exploreProject(saved, { get_reply_mode: "custom", get_reply_prompt: "Ask why." });
    expect(p).toMatchObject({ ...saved, get_reply_mode: "custom", get_reply_prompt: "Ask why." });
    expect(
      exploreProject(saved, { get_reply_mode: "nonsense", get_reply_prompt: null }),
    ).toMatchObject({ get_reply_mode: "summarize" });
  });

  test("sends the live Explore prompt, with the sample as this conversation and no others", async () => {
    const seen: string[] = [];
    const models = fakeModels({
      text: (prompt) => {
        seen.push(textOf(prompt));
        return "  What would make the evening feel safe?  ";
      },
    });
    const project = exploreProject(saved, { get_reply_mode: "summarize", get_reply_prompt: null });
    const { transcript } = sampleConversation("en");
    const text = await withPayer({ ref: "project", id: "p" }, () =>
      sampleReply(models, { project, language: "en", transcript }),
    );
    expect(text).toBe("What would make the evening feel safe?");
    expect(seen).toEqual([
      replyPrompt({
        project,
        language: "en",
        current: { name: "this conversation", tags: [], transcript },
        others: "",
      }),
    ]);
    expect(seen[0]).toContain("Lindepark, Lindenwijk");
  });
});

describe("Verify on the sample", () => {
  test("is the live draft's input, with no earlier drafts or audio", () => {
    const { system, text } = generationInput({
      project: { id: "p", name: "Park", language: "nl", ...saved },
      conversationId: "sample",
      topicPrompt: "List the agreements.",
      artifacts: [],
      transcript: sampleConversation("nl").transcript,
      audio: [],
    });
    expect(system).toContain("List the agreements.");
    expect(text).toContain("Previous artifacts: None");
    expect(text).toContain("Audio attachments: None.");
    expect(text).toContain("parkje naast de bibliotheek");
  });
});

test("a result is trimmed and kept within the size the dashboard accepts", () => {
  expect(boundResult("  hi  ")).toBe("hi");
  expect(boundResult("x".repeat(TRY_IT_MAX_CHARS + 10))).toHaveLength(TRY_IT_MAX_CHARS);
});
