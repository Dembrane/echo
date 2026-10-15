import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { reply } from "../src/reply";
import { fakeDeps, fakeModel, host, P1 } from "./fakes";

const CHAT = "c3000000-0000-4000-8000-000000000001";
const CONV = "c1000000-0000-4000-8000-000000000001";

type Stored = { message_from: string; text: string | null };

const HISTORY: Stored[] = [
  { message_from: "user", text: "Earlier question" },
  { message_from: "assistant", text: "Earlier answer" },
  { message_from: "dembrane", text: "You added 1 conversation" },
];

function world(
  opts: {
    name?: string | null;
    mode?: string | null;
    tier?: string;
    turns?: number;
    history?: Stored[];
  } = {},
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
      project_id: { id: P1, directus_user_id: null },
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
      ...(opts.history ?? HISTORY).map((m, i) => ({
        id: `m${i + 1}`,
        ...m,
        tokens_count: 5,
        used_conversations: [],
      })),
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
      host,
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
      { chat_id: CHAT, project_id: P1, mode: "context" },
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
      host,
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
      host,
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
      host,
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
      host,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "data",
      "en",
    );
    expect(await body(res)).toBe(
      '2:[{"type": "high_load", "message": "High demand. Still working on your request..."}]\n0:"late"\n',
    );
  });

  test("the host stopping the reply keeps their message", async () => {
    const w = world();
    const slow = fakeModel({ chunks: ["a", "b", "c", "d"] });
    const inner = slow.doStream.bind(slow);
    slow.doStream = async (o) => {
      const r = await inner(o);
      const paced = new TransformStream({
        async transform(part, ctl) {
          await Bun.sleep(20);
          ctl.enqueue(part);
        },
      });
      return { ...r, stream: r.stream.pipeThrough(paced) };
    };
    const captured: unknown[][] = [];
    const d = fakeDeps({ store: w.store, reads: w.reads, captured, model: slow });
    const res = await reply(
      d,
      host,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "data",
      "en",
    );
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(200);
    expect(w.deleted).toEqual([]);
    expect(captured.map((c) => c[1])).not.toContain("server_chat_error");
  });

  test("a stored empty answer is left out of the history, so the chat keeps answering", async () => {
    const w = world({
      history: [
        { message_from: "user", text: "Earlier question" },
        { message_from: "assistant", text: "" },
        { message_from: "user", text: "Asked again" },
        { message_from: "assistant", text: "  " },
      ],
    });
    // Vertex refuses a turn with no text in it (400 INVALID_ARGUMENT).
    const calls: LanguageModelV4CallOptions[] = [];
    const strict = fakeModel({ chunks: ["Fine"], calls });
    const inner = strict.doStream.bind(strict);
    strict.doStream = async (o) => {
      const blank = o.prompt.some(
        (m) =>
          m.role !== "system" && !m.content.some((p) => p.type === "text" && p.text.trim() !== ""),
      );
      if (blank)
        throw Object.assign(new Error("contents.parts must not be empty"), { isRetryable: false });
      return inner(o);
    };
    const d = fakeDeps({ store: w.store, reads: w.reads, model: strict });
    const res = await reply(
      d,
      host,
      CHAT,
      { messages: [{ role: "user", content: "What now?" }], template_key: null },
      "data",
      "en",
    );
    expect(await body(res)).toBe('0:"Fine"\n');
    expect(w.deleted).toEqual([]);
    const turns = (calls[0]?.prompt ?? []).filter((m) => m.role !== "system");
    expect(turns.map((m) => m.role)).toEqual(["user", "user", "user"]);
  });

  test("a reply with no text fails the turn instead of handing back an empty answer", async () => {
    const w = world();
    const captured: unknown[][] = [];
    const d = fakeDeps({
      store: w.store,
      reads: w.reads,
      captured,
      model: fakeModel({ chunks: [] }),
    });
    const res = await reply(
      d,
      host,
      CHAT,
      { messages: [{ role: "user", content: "Hi" }], template_key: null },
      "data",
      "en",
    );
    // A code, so the dashboard can ask the host to reword instead of showing a generic error.
    expect(await body(res)).toBe('3:"chat.no_answer"\n');
    expect(w.deleted).toEqual([w.created[0]?.id as string]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.[1]).toBe("server_chat_error");
    expect(captured[0]?.[2]).toMatchObject({ error_code: "NO_ANSWER" });
  });

  test("agentic chats and spent free-tier turns are refused before anything is stored", async () => {
    const agentic = world({ mode: "agentic" });
    await expect(
      reply(
        fakeDeps({ store: agentic.store, reads: agentic.reads }),
        host,
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
        host,
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
