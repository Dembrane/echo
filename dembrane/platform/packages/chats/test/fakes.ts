import { Writable } from "node:stream";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Access, MemoryAccessStore } from "@dembrane/access";
import { freeLimitError } from "@dembrane/allowance";
import { fakeLanguageModel } from "@dembrane/llm";
import { createLogger, type Logger } from "@dembrane/observability";
import type { ChatDeps } from "../src/deps";
import type { Admitted, FreeChats, FreeTurns, UserTurn } from "../src/free";

export const quietLogger: Logger = createLogger(
  { service: "test", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

/** A FreeChats over a fake store: admits by storing, undoes by deleting, records undo calls. */
export function fakeFreeChats(
  store: Record<string, unknown> | undefined,
  opts: { refuse?: "chats" | "chat_turns"; turns?: FreeTurns | null } = {},
): FreeChats & { undone: [UserTurn, Admitted][] } {
  const s = store as {
    createMessage?: (v: Record<string, unknown>) => Promise<unknown>;
    deleteMessage?: (id: string) => Promise<unknown>;
  };
  const undone: [UserTurn, Admitted][] = [];
  return {
    undone,
    async canStartChat() {
      if (opts.refuse === "chats") throw freeLimitError("chats");
    },
    async admitTurn(turn) {
      if (opts.refuse) throw freeLimitError(opts.refuse);
      await s.createMessage?.({
        id: turn.messageId,
        chatId: turn.chatId,
        from: "user",
        text: turn.text,
        templateKey: turn.templateKey ?? null,
        now: turn.now,
      });
      return { account: null, claimed: false };
    },
    async undoTurn(turn, admitted) {
      undone.push([turn, admitted]);
      await s.deleteMessage?.(turn.messageId);
    },
    async turnStatus() {
      return opts.turns ?? null;
    },
  };
}

/** ChatDeps over hand-written store and reads: only the methods a test touches need to exist. */
export function fakeDeps(parts: {
  store?: Record<string, unknown>;
  reads?: Record<string, unknown>;
  model?: LanguageModelV4;
  models?: Record<string, LanguageModelV4>;
  captured?: unknown[][];
  freeChats?: FreeChats;
}): ChatDeps {
  let n = 0;
  return {
    store: parts.store as never,
    reads: parts.reads as never,
    freeChats: parts.freeChats ?? fakeFreeChats(parts.store),
    access: hostAccess(),
    models: {
      model: (g: string) => (parts.models?.[g] ?? parts.model ?? fakeLanguageModel()) as never,
    },
    limiter: { check: async () => {} },
    capture: async (...args) => {
      parts.captured?.push(args);
    },
    logger: quietLogger,
    now: () => new Date("2026-09-27T10:00:00Z"),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    highLoadDelayMs: 20_000,
    suggestionCache: new Map(),
  };
}

/** The project every fake chat belongs to. */
export const P1 = "f0000000-0000-4000-8000-000000000001";

/** Its owner: the tests act as a host with every policy on P1, never through a staff bypass. */
export const host = {
  appUserId: "a0000000-0000-4000-8000-00000000000a",
  directusUserId: "d-host",
  isStaff: false,
};

function hostAccess(): Access {
  const store = new MemoryAccessStore();
  store.workspaces.set("w1", {
    id: "w1",
    orgId: "org",
    visibility: "open_to_organisation",
    deleted: false,
    stickyRemoved: [],
    inheritOrgMembers: false,
    tier: "guardian",
  });
  store.projects.set(P1, {
    id: P1,
    workspaceId: "w1",
    visibility: "workspace",
    deleted: false,
    legacyOwnerDirectusUserId: null,
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
