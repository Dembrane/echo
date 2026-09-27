import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { reply } from "../src/reply";
import { fakeDeps, fakeModel, staff } from "./fakes";

const CHAT = "c3000000-0000-4000-8000-000000000001";
const CONV = "c1000000-0000-4000-8000-000000000001";

function world(
  opts: { name?: string | null; mode?: string | null; tier?: string; turns?: number } = {},
) {
  const created: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const named: string[] = [];
  const updated: [string, Record<string, unknown>][] = [];
  const store = {
    chat: async () => ({
      id: CHAT,
      name: opts.name === undefined ? "Existing" : opts.name,
      chat_mode: opts.mode === undefined ? "deep_dive" : opts.mode,
      deleted_at: null,
      is_private: false,
      user_created: null,
      project_id: { id: "p1", directus_user_id: null },
      used_conversations: [
        { id: 1, conversation_id: { id: CONV, participant_name: "Resident 1", deleted_at: null } },
      ],
    }),
    countUserTurns: async () => opts.turns ?? 0,
    createMessage: async (v: Record<string, unknown>) => {
      created.push(v);
      return v;
    },
    messages: async () => [
      {
        id: "m1",
        message_from: "user",
        text: "Earlier question",
        tokens_count: 5,
        used_conversations: [],
      },
      {
        id: "m2",
        message_from: "assistant",
        text: "Earlier answer",
        tokens_count: 5,
        used_conversations: [],
      },
      {
        id: "m3",
        message_from: "dembrane",
        text: "You added 1 conversation",
        tokens_count: 5,
        used_conversations: [],
      },
      ...created.map((c) => ({
        id: c.id,
        message_from: "user",
        text: c.text,
        tokens_count: 5,
        used_conversations: [],
      })),
    ],
    updateMessage: async (id: string, v: Record<string, unknown>) => {
      updated.push([id, v]);
    },
    setChatName: async (_id: string, n: string) => {
      named.push(n);
    },
    deleteMessage: async (id: string) => {
      deleted.push(id);
    },
  };
  const reads = {
    projectTier: async () => opts.tier ?? "changemaker",
    storedTokenCounts: async () => new Map([[CONV, 100]]),
    listByIds: async () => [
      {
        id: CONV,
        participant_name: "Resident 1",
        created_at: "2026-01-01T00:00:00.000Z",
        duration: 60,
        tags: [],
      },
    ],
    approvedArtifacts: async () => [],
    project: async () => ({ name: "City listening", language: "en", context: "Energy." }),
    transcriptChunks: async () => [
      { transcript: "We need charging points." },
      { transcript: null },
    ],
    appUserEmail: async () => "Alice@Example.com",
  };
  return { store, reads, created, deleted, named, updated };
}

async function body(res: Response) {
  return await res.text();
}

describe("chat reply stream", () => {
  test("data protocol streams 0: parts, with the transcript and history in the prompt", async () => {
    const w = world({ name: null });
    const calls: LanguageModelV4CallOptions[] = [];
    const captured: unknown[][] = [];
    const d = fakeDeps({
      store: w.store,
      reads: w.reads,
      captured,
      models: {
        multi_modal_pro: fakeModel({ chunks: ["Char", "ging é"], calls }),
        multi_modal_fast: fakeModel({ text: "Charging needs" }),
      },
    });
    const res = await reply(
      d,
      staff,
      CHAT,
      { messages: [{ role: "user", content: "What now?" }], template_key: "t1" },
      "data",
      "en",
    );
    expect(res.headers.get("x-vercel-ai-data-stream")).toBe("v1");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await body(res)).toBe('0:"Char"\n0:"ging \\u00e9"\n');
    expect(w.created[0]?.text).toBe("What now?");
    expect(w.named).toEqual(["Charging needs"]);
    expect(w.updated).toContainEqual([w.created[0]?.id as string, { template_key: "t1" }]);
    const prompt = calls[0]?.prompt ?? [];
    expect(prompt.slice(0, 3).map((m) => m.role)).toEqual(["system", "system", "system"]);
    const context = JSON.stringify(prompt[2]);
    expect(context).toContain("We need charging points.");
    expect(context).toContain("<duration>60.0</duration>");
    // History keeps user and assistant turns only; the dembrane notice is not model input.
    expect(prompt.slice(3).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(prompt)).not.toContain("You added 1 conversation");
    expect(captured[0]).toEqual([
      "alice@example.com",
      "server_chat_response_received",
      { chat_id: CHAT, project_id: "p1", mode: "context" },
    ]);
  });

  test("text protocol sends bare text and keeps an existing name", async () => {
    const w = world();
    const d = fakeDeps({
      store: w.store,
      reads: w.reads,
      model: fakeModel({ chunks: ["a", "b"] }),
    });
    const res = await reply(
      d,
      staff,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "text",
      "en",
    );
    expect(res.headers.get("x-vercel-ai-data-stream")).toBeNull();
    expect(await body(res)).toBe("ab");
    expect(w.named).toEqual([]);
  });

  test("a failed stream reports the error and removes the host's message", async () => {
    const w = world();
    const captured: unknown[][] = [];
    const d = fakeDeps({
      store: w.store,
      reads: w.reads,
      captured,
      model: fakeModel({ failStream: true }),
    });
    const res = await reply(
      d,
      staff,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "data",
      "en",
    );
    expect(await body(res)).toBe('3:"An error occurred while processing the chat response."\n');
    expect(w.deleted).toEqual([w.created[0]?.id as string]);
    expect((captured[0] as unknown[])[1]).toBe("server_chat_error");
    const textRes = await reply(
      d,
      staff,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "text",
      "en",
    );
    expect(await body(textRes)).toBe(
      "Error: An error occurred while processing the chat response.",
    );
  });

  test("a silent model gets the high-load notice first", async () => {
    const w = world();
    const slow = fakeModel({ chunks: ["late"] });
    const inner = slow.doStream.bind(slow);
    slow.doStream = async (o) => {
      await Bun.sleep(60);
      return inner(o);
    };
    const d = { ...fakeDeps({ store: w.store, reads: w.reads, model: slow }), highLoadDelayMs: 10 };
    const res = await reply(
      d,
      staff,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "data",
      "en",
    );
    expect(await body(res)).toBe(
      '2:[{"type": "high_load", "message": "High demand. Still working on your request..."}]\n0:"late"\n',
    );
  });

  test("agentic chats and spent free-tier turns are refused before anything is stored", async () => {
    const agentic = world({ mode: "agentic" });
    await expect(
      reply(
        fakeDeps({ store: agentic.store, reads: agentic.reads }),
        staff,
        CHAT,
        { messages: [{ role: "user", content: "x" }], template_key: null },
        "data",
        "en",
      ),
    ).rejects.toThrow("Agentic chats must use /api/agentic endpoints");
    const free = world({ tier: "free", turns: 3 });
    await expect(
      reply(
        fakeDeps({ store: free.store, reads: free.reads }),
        staff,
        CHAT,
        { messages: [{ role: "user", content: "x" }], template_key: null },
        "data",
        "en",
      ),
    ).rejects.toMatchObject({
      status: 402,
      details: { error: "FREE_TIER_LIMIT", limit: "chat_turns" },
    });
    expect(agentic.created.length + free.created.length).toBe(0);
  });
});
