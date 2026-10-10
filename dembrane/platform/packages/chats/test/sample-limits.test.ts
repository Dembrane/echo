import { describe, expect, test } from "bun:test";
import { Access, MemoryAccessStore } from "@dembrane/access";
import { createChat } from "../src/bff";
import { reply } from "../src/reply";
import { fakeDeps, fakeModel, host } from "./fakes";

// On a free workspace, a sample copy (project.is_sample) is there to be asked: a chat on it
// needs no free chat slot and is not stopped at three turns, while the workspace's own
// projects keep both limits.
const OWN = "f0000000-0000-4000-8000-000000000011";
const SAMPLE = "f0000000-0000-4000-8000-000000000012";
const CHAT = "c3000000-0000-4000-8000-000000000011";

function freeAccess(): Access {
  const store = new MemoryAccessStore();
  store.workspaces.set("w1", {
    id: "w1",
    orgId: "org",
    visibility: "open_to_organisation",
    deleted: false,
    stickyRemoved: [],
    inheritOrgMembers: false,
    tier: "free",
  });
  for (const [id, isSample] of [
    [OWN, false],
    [SAMPLE, true],
  ] as const)
    store.projects.set(id, {
      id,
      workspaceId: "w1",
      visibility: "workspace",
      deleted: false,
      legacyOwnerDirectusUserId: null,
      isSample,
    });
  store.memberships.push({
    workspaceId: "w1",
    appUserId: host.appUserId,
    role: "owner",
    customPolicies: null,
    source: "direct",
  });
  return new Access(store);
}

function deps(projectId: string, turns = 0) {
  const inserted: unknown[] = [];
  const store = {
    insertChat: async (v: unknown) => {
      inserted.push(v);
    },
    chatItem: async (id: string) => ({ id }),
    chat: async () => ({
      id: CHAT,
      name: "Existing",
      chat_mode: "deep_dive",
      deleted_at: null,
      is_private: false,
      user_created: null,
      project_id: { id: projectId, directus_user_id: null },
      used_conversations: [],
    }),
    countUserTurns: async () => turns,
    createMessage: async (v: unknown) => v,
    messages: async () => [],
    deleteMessage: async () => {},
  };
  const reads = {
    // The workspace already spent its one free chat on its own project.
    workspaceChatsWithUserMessages: async () => 1,
    projectTier: async () => "free",
    listByIds: async () => [],
    approvedArtifacts: async () => [],
    project: async () => ({ name: "P", language: "en" }),
    appUserEmail: async () => null,
  };
  const d = {
    ...fakeDeps({ store, reads, model: fakeModel({ text: "answer" }) }),
    access: freeAccess(),
  };
  return { d, inserted };
}

describe("free-tier chat limits and a sample project", () => {
  test("a new chat on the workspace's own project is refused once the free chat is spent", async () => {
    const { d, inserted } = deps(OWN);
    await expect(createChat(d, host, { project_id: OWN, name: null })).rejects.toMatchObject({
      status: 402,
      details: { error: "FREE_TIER_LIMIT", limit: "chats" },
    });
    expect(inserted).toHaveLength(0);
  });

  test("a new chat on the sample needs no free chat slot", async () => {
    const { d, inserted } = deps(SAMPLE);
    expect(await createChat(d, host, { project_id: SAMPLE, name: null })).toMatchObject({});
    expect(inserted).toHaveLength(1);
  });

  test("a sample chat is not stopped at three turns; the workspace's own chat is", async () => {
    const message = { messages: [{ role: "user" as const, content: "x" }], template_key: null };
    const own = deps(OWN, 3);
    await expect(reply(own.d, host, CHAT, message, "text", "en")).rejects.toMatchObject({
      status: 402,
      details: { limit: "chat_turns" },
    });
    const sample = deps(SAMPLE, 3);
    const res = await reply(sample.d, host, CHAT, message, "text", "en");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("answer");
  });
});
