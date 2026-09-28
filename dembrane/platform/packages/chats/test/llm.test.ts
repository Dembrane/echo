import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateTitle } from "../src/llm";
import { generateSuggestions } from "../src/suggestions";
import { cleanGeneratedTitle, ensureConversationSummaries } from "../src/summaries";
import { countMessageTokens } from "../src/tokens";
import { fakeDeps, fakeModel } from "./fakes";

describe("tokens", () => {
  test("match litellm's token_counter for Gemini (cl100k plus message overhead)", () => {
    // Values computed by litellm.token_counter(model="vertex_ai/gemini-3.8-flash").
    expect(countMessageTokens("user", "")).toBe(7);
    expect(countMessageTokens("user", "hello world")).toBe(9);
    expect(countMessageTokens("assistant", "")).toBe(7);
    expect(
      countMessageTokens("user", "Hallo wereld, dit is een test van de tokenizer. Ünïcødé 你好"),
    ).toBe(27);
  });
});

describe("titles", () => {
  test("a chat title comes from the fast group; a one-letter message gets none", async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const d = fakeDeps({ models: { multi_modal_fast: fakeModel({ text: "Bus gaps", calls }) } });
    expect(await generateTitle(d.models, "Why are buses late?", "nl")).toBe("Bus gaps");
    expect(JSON.stringify(calls[0]?.prompt)).toContain('in \\"nl\\" (2 letter language code)');
    expect(await generateTitle(d.models, " a ", "en")).toBeNull();
  });

  test("a generated conversation title keeps the first candidate as plain text", () => {
    expect(cleanGeneratedTitle("Here are some options:\n1. **Bus gaps**\n2. Grid")).toBe(
      "Bus gaps",
    );
    expect(cleanGeneratedTitle('"Charging woes"')).toBe("Charging woes");
    expect(cleanGeneratedTitle("\n\n")).toBe("");
  });
});

describe("suggestions", () => {
  const store = (history: boolean) => ({
    lastAssistantMessage: async () => (history ? "Buses stop at eleven." : null),
    recentUserQueries: async () => (history ? ["What about buses?"] : []),
    lockedConversationsWithSummaries: async () => [
      { id: "c1", name: "Resident 1", summary: "Wants later buses." },
    ],
  });

  test("three at most, labels cut to 50 characters, from the fast group", async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const answer = JSON.stringify({
      suggestions: [
        { icon: "sparkles", label: "x".repeat(60), prompt: "p1" },
        { icon: "search", label: "b", prompt: "p2" },
        { icon: "quote", label: "c", prompt: "p3" },
        { icon: "list", label: "d", prompt: "p4" },
      ],
    });
    const d = fakeDeps({
      store: store(true),
      models: { multi_modal_fast: fakeModel({ text: answer, calls }) },
    });
    const out = await generateSuggestions(d, "p1", "chat", "deep_dive", "en");
    expect(out).toHaveLength(3);
    expect(out[0]?.label).toBe("x".repeat(50));
    const user = JSON.stringify(calls[0]?.prompt);
    expect(user).toContain("- Resident 1: Wants later buses.");
    expect(user).toContain("Recent questions asked:");
  });

  test("no mode, bad output or a failing model answer an empty list", async () => {
    const d = fakeDeps({ store: store(true), model: fakeModel({ text: "not json" }) });
    expect(await generateSuggestions(d, "p1", "chat", null, "en")).toEqual([]);
    expect(await generateSuggestions(d, "p1", "chat", "deep_dive", "en")).toEqual([]);
  });

  test("a fresh chat's suggestions are cached", async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const answer = JSON.stringify({ suggestions: [{ icon: "sparkles", label: "a", prompt: "p" }] });
    const d = fakeDeps({ store: store(false), model: fakeModel({ text: answer, calls }) });
    await generateSuggestions(d, "p1", "chat", "deep_dive", "en");
    await generateSuggestions(d, "p1", "chat", "deep_dive", "en");
    expect(calls).toHaveLength(1);
  });
});

describe("overview summaries", () => {
  test("missing summaries are generated with title and tags when the project opted in", async () => {
    const updates: [string, Record<string, unknown>][] = [];
    const tagged: string[] = [];
    const reads = {
      summaries: async () =>
        new Map([
          ["c1", "Has one"],
          ["c2", null],
          ["c3", " "],
        ]),
      liveConversation: async (id: string) => ({
        id,
        project_id: "p1",
        is_over_cap: false,
        title: null,
      }),
      projectTier: async () => "changemaker",
      project: async () => ({ name: "City", language: "nl", enable_ai_title_and_tags: true }),
      transcriptChunks: async (id: string) =>
        id === "c3" ? [] : [{ transcript: "We want buses." }],
      verifiedArtifacts: async () => [],
      recentTitles: async () => ["Grid"],
      projectTags: async () => [{ id: "t1", text: "mobility" }],
      conversationTagIds: async () => new Set<string>(),
      addConversationTag: async (_c: string, t: string) => {
        tagged.push(t);
      },
      updateConversation: async (id: string, v: Record<string, unknown>) => {
        updates.push([id, v]);
      },
    };
    const d = fakeDeps({
      reads,
      models: {
        multi_modal_pro: fakeModel({ text: "Wants buses." }),
        multi_modal_fast: fakeModel({
          text: (o) =>
            JSON.stringify(o.prompt).includes("tag_ids") ? '{"tag_ids":["t1","nope"]}' : "Buses",
        }),
      },
    });
    const res = await ensureConversationSummaries(d, ["c1", "c2", "c3"]);
    expect(res.succeeded.sort()).toEqual(["c1", "c2", "c3"]);
    expect(updates).toEqual([["c2", { summary: "Wants buses.", title: "Buses" }]]);
    expect(tagged).toEqual(["t1"]);
  });

  test("a locked conversation fails without a model call", async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const reads = {
      summaries: async () => new Map(),
      liveConversation: async (id: string) => ({ id, project_id: "p1", is_over_cap: true }),
      projectTier: async () => "free",
    };
    const d = fakeDeps({ reads, model: fakeModel({ calls }) });
    expect(await ensureConversationSummaries(d, ["c9"])).toEqual({ succeeded: [], failed: ["c9"] });
    expect(calls).toHaveLength(0);
  });
});
