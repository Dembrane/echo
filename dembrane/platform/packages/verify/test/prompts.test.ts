import { expect, test } from "bun:test";
import { DEFAULT_TOPICS, defaultTopicPrompt } from "../src/defaults";
import { audienceOf, generationInput, keyTermList, revisionSystem, selected } from "../src/service";

// ECHO-1052: the rendered Verify prompts, per built-in topic and language, with the project
// context and key terms present. The snapshots are what the model reads; a change to them is
// a change to what participants get, so it shows up in review.
const project = (language: string) => ({
  id: "p",
  name: "Benches for Lindenwijk",
  language,
  context: "A neighbourhood session about public seating.",
  default_conversation_transcript_prompt: "Lindenpad, Lindenwijk",
  anonymize_transcripts: false,
  template_key: "event",
});

for (const language of ["en", "nl"])
  for (const topic of DEFAULT_TOPICS)
    test(`${topic.key} renders in ${language}`, () => {
      const input = generationInput({
        project: project(language),
        conversationId: "c",
        topicPrompt: defaultTopicPrompt(topic.key, topic.prompt, language) ?? "",
        artifacts: [],
        transcript: "We need more benches along the Lindenpad.",
        audio: [],
      });
      expect(input.system).toMatchSnapshot();
      expect(input.text).toMatchSnapshot();
      expect(input.system).toContain(language === "nl" ? topic.promptNl : topic.prompt);
      expect(input.system).toContain("<key_terms>\nLindenpad, Lindenwijk\n</key_terms>");
      expect(input.system).toContain("A neighbourhood session about public seating.");
      expect(`${input.system}${input.text}`).not.toMatch(/Participant (name|email)/);
    });

test("the revision prompt carries the same reference material", () => {
  const system = revisionSystem({
    project: project("en"),
    transcript: "We need more benches.",
    outcome: "Draft for this table to correct.",
    feedback: "Add shade.",
  });
  expect(system).toMatchSnapshot();
  expect(system).toContain("<key_terms>\nLindenpad, Lindenwijk\n</key_terms>");
});

test("the PII rules point at the key terms that are now supplied", () => {
  const { system } = generationInput({
    project: { ...project("en"), anonymize_transcripts: true },
    conversationId: "c",
    topicPrompt: "x",
    artifacts: [],
    transcript: "t",
    audio: [],
  });
  expect(system).toContain("appears in the key terms in the reference material");
  expect(system).not.toContain("appears in keyterms");
});

test("without context or key terms there is no empty reference block", () => {
  const { system } = generationInput({
    project: { ...project("en"), context: null, default_conversation_transcript_prompt: null },
    conversationId: "c",
    topicPrompt: "x",
    artifacts: [],
    transcript: "t",
    audio: [],
  });
  expect(system).not.toContain("<reference_material>");
});

test("current templates speak to whom their setup records", () => {
  // ECHO-1053 retired event and conversation; the cards say how they are recorded.
  expect(audienceOf("world_cafe")).toBe("table");
  expect(audienceOf("resident_evening")).toBe("table");
  expect(audienceOf("interviews")).toBe("single");
  expect(audienceOf("focus_group")).toBe("single");
  for (const key of ["upload", "blank", "series", "no_such_template"])
    expect([key, audienceOf(key)]).toEqual([key, "neutral"]);
});

test("the first line follows who the draft is for", () => {
  expect(audienceOf("event")).toBe("table");
  expect(audienceOf("conversation")).toBe("single");
  expect(audienceOf(null)).toBe("neutral");
  const first = (template_key: string | null) =>
    generationInput({
      project: { ...project("en"), template_key },
      conversationId: "c",
      topicPrompt: "x",
      artifacts: [],
      transcript: "t",
      audio: [],
    }).system;
  expect(first("conversation")).toContain("First line: 'Draft for you to correct.'");
  expect(first(null)).toContain("First line: 'Draft to correct together.'");
});

test("an edited global topic keeps its own text in every language", () => {
  expect(defaultTopicPrompt("agreements", "Our own text.", "nl")).toBe("Our own text.");
  expect(defaultTopicPrompt("not-a-default", "Custom.", "nl")).toBe("Custom.");
});

test("key terms are listed once each", () => {
  expect(keyTermList(" Lindenpad,lindenpad , Lindenwijk,, ")).toBe("Lindenpad, Lindenwijk");
});

test("nothing selected means the table check alone; a selection is kept", () => {
  const topics = DEFAULT_TOPICS.map((t) => ({ key: t.key }));
  expect(selected(null, topics)).toEqual(["agreements"]);
  expect(selected("", topics)).toEqual(["agreements"]);
  expect(selected("gone-custom-topic", topics)).toEqual(["agreements"]);
  expect(selected("heard, actions", topics)).toEqual(["heard", "actions"]);
});
