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

describe("chat BFF and the free chats", () => {
  test("createChat refuses when the chats are spent", async () => {
    const w = world();
    const d = fakeDeps({ store: w.store, freeChats: fakeFreeChats(w.store, { refuse: "chats" }) });
    const err = await createChat(d, host, { project_id: P1, name: null }).then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ status: 402, details: { limit: "chats" } });
    expect(w.inserted).toHaveLength(0);
  });

  test("getChat carries free_turns", async () => {
    const w = world();
    const turns = { limit: 20, used: 4, frozen: false };
    const d = fakeDeps({ store: w.store, freeChats: fakeFreeChats(w.store, { turns }) });
    expect(await getChat(d, host, CHAT)).toMatchObject({ id: CHAT, free_turns: turns });
  });

  test("getChat reports a frozen chat", async () => {
    const w = world();
    const turns = { limit: 20, used: 20, frozen: true };
    const d = fakeDeps({ store: w.store, freeChats: fakeFreeChats(w.store, { turns }) });
    expect((await getChat(d, host, CHAT)).free_turns).toEqual(turns);
  });

  test("getChat has no free_turns off the free tier", async () => {
    const w = world();
    const d = fakeDeps({ store: w.store });
    expect((await getChat(d, host, CHAT)).free_turns).toBeNull();
  });
});
