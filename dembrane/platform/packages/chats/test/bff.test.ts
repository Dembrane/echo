import { describe, expect, test } from "bun:test";
import { createChat, getChat } from "../src/bff";
import { fakeDeps, fakeFreeChats, host, P1 } from "./fakes";

const CHAT = "c3000000-0000-4000-8000-000000000021";

function world() {
  const inserted: unknown[] = [];
  const store = {
    insertChat: async (v: unknown) => {
      inserted.push(v);
    },
    chat: async () => ({
      id: CHAT,
      name: "Existing",
      chat_mode: "deep_dive",
      deleted_at: null,
      is_private: false,
      user_created: null,
      project_id: { id: P1, directus_user_id: null },
    }),
    chatItem: async (id: string) => ({
      id,
      name: "Existing",
      project_id: P1,
      chat_mode: "deep_dive",
      date_created: "2026-09-27T10:00:00.000Z",
      date_updated: null,
    }),
  };
  return { store, inserted };
}

describe("chat BFF and the AI budget", () => {
  test("createChat refuses when the AI budget is used up", async () => {
    const w = world();
    const d = fakeDeps({
      store: w.store,
      freeChats: fakeFreeChats(w.store, { refuse: "ai_budget" }),
    });
    const err = await createChat(d, host, { project_id: P1, name: null }).then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(w.inserted).toHaveLength(0);
  });

  test("getChat keeps free_turns, always null", async () => {
    const w = world();
    const d = fakeDeps({ store: w.store });
    expect(await getChat(d, host, CHAT)).toMatchObject({ id: CHAT, free_turns: null });
  });
});
