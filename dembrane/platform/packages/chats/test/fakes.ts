import { Writable } from "node:stream";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Access, MemoryAccessStore } from "@dembrane/access";
import { createLogger, type Logger } from "@dembrane/observability";
import type { ChatDeps } from "../src/deps";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: "stop" };

/** A language model that answers from a script and records every prompt it was sent. */
export function fakeModel(opts: {
  text?: string | ((o: LanguageModelV4CallOptions) => string);
  chunks?: string[];
  failStream?: boolean;
  calls?: LanguageModelV4CallOptions[];
}): LanguageModelV4 {
  const calls = opts.calls ?? [];
  const answer = (o: LanguageModelV4CallOptions) =>
    typeof opts.text === "function" ? opts.text(o) : (opts.text ?? "ok");
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate(o) {
      calls.push(o);
      return {
        content: [{ type: "text", text: answer(o) }],
        finishReason,
        usage,
        warnings: [],
      } as never;
    },
    async doStream(o) {
      calls.push(o);
      if (opts.failStream) throw Object.assign(new Error("boom"), { isRetryable: false });
      const chunks = opts.chunks ?? [answer(o)];
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        ...chunks.map((delta) => ({ type: "text-delta", id: "t", delta })),
        { type: "text-end", id: "t" },
        { type: "finish", finishReason, usage },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      } as never;
    },
  };
}

export const quietLogger: Logger = createLogger(
  { service: "test", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

/** ChatDeps over hand-written store and reads: only the methods a test touches need to exist. */
export function fakeDeps(parts: {
  store?: Record<string, unknown>;
  reads?: Record<string, unknown>;
  model?: LanguageModelV4;
  models?: Record<string, LanguageModelV4>;
  captured?: unknown[][];
}): ChatDeps {
  let n = 0;
  return {
    store: parts.store as never,
    reads: parts.reads as never,
    access: hostAccess(),
    models: {
      model: (g: string) => (parts.models?.[g] ?? parts.model ?? fakeModel({})) as never,
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
