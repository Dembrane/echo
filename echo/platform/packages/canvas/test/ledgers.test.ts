import { describe, expect, test } from "bun:test";
import {
  applyModelExtraction,
  freshCanvasState,
  normalizeCanvasTabs,
  renderTabbedCanvas,
  seedBoardCardsFromQuotes,
  statePatch,
} from "../src/ledgers";
import { CanvasSanitizationError, sanitizeCanvasHtml } from "../src/sanitize";
import { bannedVisibleCopy, generationDetail, windowedConversationBundles } from "../src/ticks";

const bundle = {
  project: { id: "p", workspace_id: "w", name: "City", language: "nl" },
  conversations: [
    {
      id: "c1",
      label: "Ann",
      created_at: "2026-09-01T10:00:00.000Z",
      latest_transcript: "",
      chunks: [
        {
          id: "k1",
          transcript:
            "We need more charging points near the flats. The waiting list is months long.",
          created_at: "2026-09-01T10:01:00.000Z",
        },
      ],
    },
  ],
};

describe("tabs", () => {
  test("default set, aliases, dedupe and board grouping", () => {
    expect(normalizeCanvasTabs(null).map((t) => t.kind)).toEqual([
      "crux",
      "concept_cloud",
      "story",
      "host_guide",
      "trace",
      "audit",
    ]);
    expect(
      normalizeCanvasTabs(["cloud", "concepts", { kind: "people", grouping: "voice" }, "x"]),
    ).toEqual([{ kind: "concept_cloud" }, { kind: "board", grouping: "person" }]);
    expect(normalizeCanvasTabs(["nonsense"]).length).toBe(6);
  });
});

describe("model extraction", () => {
  test("keeps verbatim quotes only and ties concepts to them", () => {
    const [state, detail] = applyModelExtraction(freshCanvasState(), bundle, {
      quotes: [
        {
          quote: "We need more charging points near the flats.",
          conversation_id: "c1",
          chunk_id: "k1",
        },
        { quote: "Buses are great", conversation_id: "c1", chunk_id: "k1" },
        { quote: "anything", conversation_id: "nope" },
      ],
      concepts: [
        { phrase: "charging points", supporting_quote_indices: [0] },
        { phrase: "invented idea", supporting_quote_indices: [0] },
        { phrase: "unsupported", supporting_quote_indices: [1] },
      ],
      crux: { question: "Where should the next chargers go?" },
      story_slides: [{ heading: "Charging", lede: "Scarce", quote_indices: [0] }],
    });
    expect(detail.quotes_added).toBe(1);
    expect(state.quotes_ledger[0]).toMatchObject({
      who: "Ann",
      quote: "We need more charging points near the flats.",
      source: { conversation_id: "c1", chunk_id: "k1" },
      when: "2026-09-01T10:01:00.000Z",
    });
    expect(state.concepts_ledger.map((c) => c.phrase)).toEqual(["charging points"]);
    expect(detail.crux_changed).toBe(true);
    expect(detail.story_changed).toBe(true);
    expect(detail.rejections).toEqual([
      "quote[1] not found verbatim: Buses are great",
      "quote[2] missing text or conversation: anything",
      "concept[1] phrase not found in supporting quote: invented idea",
      "concept[2] has no accepted supporting quote: unsupported",
    ]);
    // The same quote again reuses its id rather than growing the ledger.
    const [again, second] = applyModelExtraction(state, bundle, {
      quotes: [
        {
          quote: "We need more charging points near the flats.",
          conversation_id: "c1",
          chunk_id: "k1",
        },
      ],
      crux: { question: "Where should the next chargers go?" },
    });
    expect(second.quotes_added).toBe(0);
    expect(second.crux_changed).toBe(false);
    expect(again.quotes_ledger.length).toBe(1);
  });

  test("a replaced crux keeps its history", () => {
    const [s1] = applyModelExtraction(freshCanvasState(), bundle, { crux: { question: "First?" } });
    const [s2] = applyModelExtraction(s1, bundle, { crux: { question: "Second?" } });
    expect(s2.crux.question).toBe("Second?");
    expect((s2.crux.history as { question: string }[])[0]?.question).toBe("First?");
  });

  test("board cards seed from attributed quotes", () => {
    const state = freshCanvasState({ canvas_tabs: ["board"] });
    state.quotes_ledger.push(
      { id: "q1", who: "Ann", quote: "A" },
      { id: "q2", who: "participant", quote: "B" },
    );
    expect(seedBoardCardsFromQuotes(state, "now")).toBe(true);
    expect(state.board_cards).toMatchObject([{ group: "Ann", synthesis: "A", quote_ids: ["q1"] }]);
  });
});

describe("ledger columns", () => {
  test("state patch writes every ledger column", () => {
    expect(Object.keys(statePatch(freshCanvasState()))).toEqual([
      "canvas_tabs",
      "canvas_quotes_ledger",
      "canvas_concepts_ledger",
      "canvas_crux",
      "canvas_host_items",
      "canvas_story_slides",
      "canvas_host_guide",
      "canvas_board_cards",
    ]);
  });
});

describe("rendering and sanitising", () => {
  test("the wall renders from the ledgers, escaped, with the new-tab chat link", () => {
    const state = freshCanvasState({ canvas_crux: { question: "Who <decides>?", history: [] } });
    const html = renderTabbedCanvas({ state, project: bundle.project, reportName: "Mood" });
    expect(html).toContain("<h1>Who &lt;decides&gt;?</h1>");
    expect(html).toContain(
      'href="/nl-NL/w/w/projects/p/chats/new?prefill=I%20need%20a%20new%20tab%20in%20the%20Mood%20canvas%3A%20"',
    );
    expect(html.startsWith('<div class="canvas-shell tabbed-canvas"')).toBe(true);
    expect(sanitizeCanvasHtml(html).strippedReferences).toBe(0);
  });

  test("external references are stripped and empty output refused", () => {
    const out = sanitizeCanvasHtml(
      '```html\n<html><head><style>x</style></head><body><!-- note --><img src="https://x.y/a.png"><div style="background:url(//cdn/x)">k</div></body></html>\n```',
    );
    expect(out.html).toBe(`<img src="#"><div style="background:url('')">k</div>`);
    expect(out.strippedReferences).toBe(2);
    expect(() => sanitizeCanvasHtml("   ")).toThrow(CanvasSanitizationError);
    expect(() => sanitizeCanvasHtml("plain words")).toThrow(
      "Canvas output has no renderable content",
    );
  });

  test("visible copy checks ignore scripts and styles", () => {
    expect(bannedVisibleCopy("<style>.AI{}</style><p>We successfully used AI</p>")).toEqual([
      "AI",
      "successfully",
    ]);
  });

  test("generation detail lists ledger outcomes", () => {
    expect(
      generationDetail({
        strippedReferences: 1,
        bannedCopy: [],
        ledgerDetail: {
          quotes_added: 2,
          concepts_changed: 1,
          crux_changed: true,
          story_changed: false,
          board_changed: false,
          concepts_removed: [],
          rejections: ["r1"],
          conversation_outcomes: ["conv c1: 2 accepted / 1 rejected"],
        },
      }),
    ).toBe(
      "stripped 1 external reference(s); conv c1: 2 accepted / 1 rejected; ledger update: 2 quote(s), 1 concept change(s), crux changed, story unchanged, open questions unchanged, board unchanged; rejections: r1",
    );
  });

  test("long transcripts are windowed per conversation", () => {
    const conv = { id: "c", chunks: [{ id: "a", transcript: "x".repeat(2500) }] };
    const windows = windowedConversationBundles({ conversations: [] }, conv, 1000);
    expect(windows.length).toBe(3);
    const first = (windows[0]?.conversations ?? []) as { latest_transcript: string }[];
    expect(first[0]?.latest_transcript).toHaveLength(1000);
  });
});
