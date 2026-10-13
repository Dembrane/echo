import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { reply } from "../src/reply";
import { addContext, getContext, lockConversations } from "../src/service";
import { fakeDeps, fakeModel, host, P1 } from "./fakes";

const CHAT = "c3000000-0000-4000-8000-000000000011";
const LIVE = "c1000000-0000-4000-8000-000000000011";
const GONE = "c1000000-0000-4000-8000-000000000012";
const NEW = "c1000000-0000-4000-8000-000000000013";

/** A chat with one live and one soft-deleted conversation attached; reads behave like chatReads. */
function world(mode = "deep_dive") {
  const created: Record<string, unknown>[] = [];
  const attached: string[][] = [];
  const listed: string[][] = [];
  const deletedAt = "2026-10-13T09:43:22.000Z";
  const store = {
    chat: async () => ({
      id: CHAT,
      name: "Existing",
      chat_mode: mode,
      deleted_at: null,
      is_private: false,
      user_created: null,
      project_id: { id: P1, directus_user_id: null },
      used_conversations: [
        { id: 1, conversation_id: { id: LIVE, participant_name: "Live", deleted_at: null } },
        { id: 2, conversation_id: { id: GONE, participant_name: "Gone", deleted_at: deletedAt } },
      ],
    }),
    messages: async () =>
      created.map((c) => ({
        id: c.id,
        message_from: c.from,
        text: c.text,
        tokens_count: 5,
        used_conversations: ((c.usedConversationIds as string[]) ?? []).map((id) => ({
          conversation_id: { id },
        })),
      })),
    createMessage: async (v: Record<string, unknown>) => {
      created.push(v);
      return v;
    },
    countUserTurns: async () => 0,
    updateMessage: async () => {},
    deleteMessage: async () => {},
    attachConversations: async (_c: string, ids: string[]) => {
      attached.push(ids);
    },
  };
  const live = (id: string) =>
    id === GONE ? null : { id, project_id: P1, token_count: 100, is_over_cap: false };
  const reads = {
    projectTier: async () => "changemaker",
    // Both reads leave out deleted rows, as the SQL does.
    storedTokenCounts: async (ids: string[]) =>
      new Map(ids.filter((i) => i !== GONE).map((i) => [i, 100])),
    liveConversation: async (id: string) => live(id),
    withContent: async (ids: string[]) => new Set(ids),
    listWithFilters: async () => [{ id: NEW, participant_name: "New" }],
    listByIds: async (ids: string[]) =>
      ids
        .filter((i) => i !== GONE)
        .map((id) => ({ id, participant_name: "Live", duration: 60, tags: [] })),
    approvedArtifacts: async () => [],
    project: async () => ({ name: "City listening", language: "en", context: "Energy." }),
    transcriptChunks: async () => [{ transcript: "We need charging points." }],
    appUserEmail: async () => "host@example.com",
  };
  return { store, reads, created, attached, listed };
}

describe("a chat with a deleted conversation attached", () => {
  test("the context bar leaves the deleted conversation out", async () => {
    const w = world();
    const ctx = await getContext(fakeDeps(w), host, CHAT);
    expect(ctx.conversation_id_list).toEqual([LIVE]);
    expect(ctx.conversations.map((c) => c.conversation_participant_name)).toEqual(["Live"]);
  });

  test("a message still gets an answer from the live conversation", async () => {
    const w = world();
    const calls: LanguageModelV4CallOptions[] = [];
    const d = fakeDeps({ ...w, model: fakeModel({ text: "Charging.", calls }) });
    const res = await reply(
      d,
      host,
      CHAT,
      { messages: [{ role: "user", content: "What now?" }], template_key: null },
      "text",
      "en",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Charging.");
    expect(JSON.stringify(calls[0]?.prompt)).toContain("We need charging points.");
  });

  test("locking and adding more context work", async () => {
    const w = world();
    const d = fakeDeps(w);
    const locked = await lockConversations(d, host, CHAT);
    expect(locked.map((c) => c.id)).toEqual([LIVE]);
    expect(w.created[0]?.usedConversationIds).toEqual([LIVE]);
    await addContext(d, host, CHAT, {
      conversation_id: NEW,
      conversation_ids: null,
      select_all: null,
      project_id: null,
      tag_ids: null,
      verified_only: null,
      search_text: null,
    });
    expect(w.attached).toEqual([[NEW]]);
  });
});
