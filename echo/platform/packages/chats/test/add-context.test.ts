import { describe, expect, test } from "bun:test";
import { addContext } from "../src/service";
import { MAX_CHAT_CONTEXT_LENGTH } from "../src/tokens";
import { fakeDeps, staff } from "./fakes";

const CHAT = "c3000000-0000-4000-8000-000000000009";

function setup(mode: string, counts: Record<string, number>, rows: Record<string, unknown>[]) {
  const attached: string[][] = [];
  const store = {
    chat: async () => ({
      id: CHAT,
      name: null,
      chat_mode: mode,
      deleted_at: null,
      is_private: false,
      user_created: null,
      project_id: { id: "p1", directus_user_id: null },
      used_conversations: [
        { id: 1, conversation_id: { id: "in", participant_name: "In", deleted_at: null } },
      ],
    }),
    messages: async () => [],
    attachConversations: async (_c: string, ids: string[]) => {
      attached.push(ids);
    },
  };
  const reads = {
    projectTier: async () => "free",
    withContent: async (ids: string[]) => new Set(ids.filter((i) => i !== "empty")),
    storedTokenCounts: async (ids: string[]) =>
      new Map(ids.filter((i) => i in counts).map((i) => [i, counts[i] as number])),
    liveConversation: async () => null,
    listWithFilters: async () => rows,
  };
  return { d: fakeDeps({ store, reads }), attached };
}

const body = {
  conversation_id: null,
  conversation_ids: null,
  select_all: true,
  project_id: null,
  tag_ids: null,
  verified_only: null,
  search_text: null,
};

describe("add-context budget", () => {
  test("walks the budget once, in order, and reports every skip reason", async () => {
    const half = Math.floor(MAX_CHAT_CONTEXT_LENGTH * 0.45);
    const { d, attached } = setup(
      "deep_dive",
      { in: 0, a: half, b: half, c: half, long: MAX_CHAT_CONTEXT_LENGTH + 1 },
      [
        { id: "in", participant_name: "In" },
        { id: "locked", participant_name: "L", is_over_cap: true },
        { id: "empty", participant_name: null },
        { id: "long", participant_name: "Long" },
        { id: "a", participant_name: "A" },
        { id: "b", participant_name: "B" },
        { id: "c", participant_name: "C" },
        { id: "gone", participant_name: "G" },
      ],
    );
    const res = await addContext(d, staff, CHAT, body);
    expect(attached).toEqual([["a", "b"]]);
    expect(res.added?.map((r) => r.conversation_id)).toEqual(["a", "b"]);
    expect(res.skipped?.map((r) => [r.conversation_id, r.reason])).toEqual([
      ["in", "already_in_context"],
      ["locked", "locked"],
      ["empty", "empty"],
      ["long", "too_long"],
      ["c", "context_limit_reached"],
      ["gone", "context_limit_reached"],
    ]);
    expect(res.skipped?.find((r) => r.conversation_id === "empty")?.participant_name).toBe(
      "Unknown",
    );
    expect(res.context_limit_reached).toBe(true);
    expect(res.total_processed).toBe(8);
  });

  test("agentic chats skip the budget and never count tokens", async () => {
    const { d, attached } = setup("agentic", {}, [
      { id: "a", participant_name: "A" },
      { id: "b", participant_name: "B" },
    ]);
    const res = await addContext(d, staff, CHAT, body);
    expect(attached).toEqual([["a", "b"]]);
    expect(res.context_limit_reached).toBe(false);
  });

  test("option rules", async () => {
    const { d } = setup("deep_dive", {}, []);
    await expect(addContext(d, staff, CHAT, { ...body, select_all: null })).rejects.toThrow(
      "One of conversation_id, conversation_ids or select_all is required",
    );
    await expect(addContext(d, staff, CHAT, { ...body, conversation_ids: [] })).rejects.toThrow(
      "Only one of conversation_id, conversation_ids or select_all can be provided",
    );
    await expect(addContext(d, staff, CHAT, { ...body, project_id: "p2" })).rejects.toThrow(
      "project_id does not match this chat",
    );
    await expect(
      addContext(d, staff, CHAT, { ...body, select_all: null, conversation_id: "x" }),
    ).rejects.toThrow("Conversation not found");
  });
});
