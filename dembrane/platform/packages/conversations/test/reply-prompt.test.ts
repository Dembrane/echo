import { expect, test } from "bun:test";
import { replyPrompt } from "../src/v1/reply";

// ECHO-1052: the Explore prompt per mode and language, as the model reads it, with the
// project context and key terms present and no participant named.
const project = (mode: string) => ({
  context: "How people in the north of town get around.",
  default_conversation_title: null,
  default_conversation_description: null,
  default_conversation_transcript_prompt: "Noorderkade",
  get_reply_mode: mode,
  get_reply_prompt: mode === "custom" ? "Our own prompt." : null,
  anonymize_transcripts: false,
});
const current = {
  name: "this conversation",
  tags: [],
  transcript: "The bus stop by the school floods every winter.\n",
};

for (const language of ["en", "nl"])
  for (const mode of ["summarize", "brainstorm", "custom"])
    test(`${mode} renders in ${language}`, () => {
      const prompt = replyPrompt({ project: project(mode), language, current, others: "" });
      expect(prompt).toMatchSnapshot();
      expect(prompt).toContain("Noorderkade");
      expect(prompt).toContain("How people in the north of town get around.");
    });

test("the approved default and brainstorm texts replace the old ones in every language", () => {
  for (const language of ["en", "nl", "de", "es", "fr", "it", "uk", "cs"]) {
    const summarize = replyPrompt({ project: project("summarize"), language, current, others: "" });
    const brainstorm = replyPrompt({
      project: project("brainstorm"),
      language,
      current,
      others: "",
    });
    expect(summarize).toContain("25");
    expect(brainstorm).toContain("40");
    expect(brainstorm).not.toContain("detailed_analysis");
    expect(summarize).not.toMatch(/1-3|1 až 3/);
  }
});
