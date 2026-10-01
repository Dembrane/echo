import { describe, expect, test } from "bun:test";
import { Access, MemoryAccessStore } from "@dembrane/access";
import { BadRequestError, ConflictError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { buildCanvasHistory } from "../src/canvas/history";
import {
  appendHostItem,
  freshCanvasState,
  normalizeCanvasTabs,
  removeHostItem,
  statePatch,
} from "../src/canvas/ledgers";
import { sanitizeCanvasHtml } from "../src/canvas/sanitize";
import type { CanvasDeps, CanvasStore } from "../src/canvas/service";
import * as svc from "../src/canvas/service";

const P = "f0000000-0000-4000-8000-000000000001";
const LOOP = "ca000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-27T12:00:00.000Z");
/** The project's owner: the service is driven through the access resolver, never a staff bypass. */
const host: Signed = {
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
  store.projects.set(P, {
    id: P,
    workspaceId: "w1",
    visibility: "workspace",
    deleted: false,
    legacyOwnerDirectusUserId: null,
  });
  store.memberships.push({
    workspaceId: "w1",
    appUserId: host.appUserId as string,
    role: "owner",
    customPolicies: null,
    source: "direct",
  });
  return new Access(store);
}

type Row = Record<string, unknown>;

/** Just enough of the canvas store to drive the service without a database. */
function memoryStore(o: { ledger?: boolean; loop?: Row | null } = {}) {
  const writes: { kind: string; value: unknown }[] = [];
  let loop: Row | null =
    o.loop === undefined
      ? {
          id: LOOP,
          name: "Loop",
          status: "active",
          expires_at: "2099-01-01T00:00:00.000Z",
          cadence_minutes: 5,
          canvas_host_items: [],
        }
      : o.loop;
  const store = {
    hasLedgerColumns: async () => o.ledger ?? true,
    projectFlag: async (id: string) => (id === P ? true : null),
    report: async (id: string) =>
      id === "7"
        ? { id: "7", kind: "canvas", project_id: P, deleted_at: null, user_instructions: "Pulse" }
        : null,
    canvasReports: async () => [],
    reportInstructions: async () => [],
    loopForReport: async () => ((o.ledger ?? true) ? loop : null),
    latestConfig: async () =>
      (o.ledger ?? true)
        ? { id: "cfg", brief: "Track.\n\nStanding edits:\n- Keep it short", cadence_minutes: 5 }
        : null,
    latestLoopRun: async () => null,
    generations: async () => [],
    projectLoops: async () => [],
    recentLoopRuns: async () => [],
    chat: async () => null,
    historyLoop: async () => loop,
    historyGenerations: async () => [],
    historyRuns: async () => [],
    historyConfigs: async () => [],
    insertConfigRevision: async (v: Row) => {
      writes.push({ kind: "config", value: v });
      return { id: "rev", brief: v.brief };
    },
    insertGeneration: async (v: Row) => {
      writes.push({ kind: "generation", value: v });
      return { id: "gen", content_html: v.contentHtml };
    },
    insertLoopRun: async (v: Row) => {
      writes.push({ kind: "run", value: v });
    },
    updateLoop: async (_id: string, patch: Row) => {
      writes.push({ kind: "loop", value: patch });
      loop = { ...(loop ?? {}), ...patch };
      return loop;
    },
    scheduleTask: async (v: Row) => {
      writes.push({ kind: "task", value: v.payload });
    },
    cancelPendingTasks: async (_t: string, match: Row) => {
      writes.push({ kind: "cancel", value: match });
      return 1;
    },
  };
  return { store: store as unknown as CanvasStore, writes };
}

function deps(store: CanvasStore, enableCanvas = true): CanvasDeps {
  return {
    store,
    access: hostAccess(),
    enableCanvas,
    now: () => NOW,
    publishGeneration: async () => {},
  };
}

describe("canvas ledgers", () => {
  test("tabs normalise aliases, drop unknowns and duplicates, and default to the v1 set", () => {
    expect(
      normalizeCanvasTabs([
        "cloud",
        "Concepts",
        "people",
        { kind: "board", grouping: "voice" },
        "x",
      ]),
    ).toEqual([{ kind: "concept_cloud" }, { kind: "board" }]);
    expect(normalizeCanvasTabs([{ tab: "per-person", grouping: "Speaker" }])).toEqual([
      { kind: "board", grouping: "person" },
    ]);
    expect(normalizeCanvasTabs([]).map((t) => t.kind)).toEqual([
      "crux",
      "concept_cloud",
      "story",
      "host_guide",
      "trace",
      "audit",
    ]);
  });

  test("host items are appended, and removed by id or by contained text only once", () => {
    const item = { id: "h1", text: "Ask about night buses", removed_at: null };
    const state = appendHostItem(freshCanvasState({}), item);
    const [after, removed] = removeHostItem(state, "NIGHT", NOW);
    expect(removed).toBe(true);
    expect((after.host_items as Row[])[0]?.removed_at).toBe("2026-09-27T12:00:00.000000+00:00");
    const [again, removedAgain] = removeHostItem(after, "night", NOW);
    expect(removedAgain).toBe(false);
    expect(statePatch(again).canvas_host_items).toEqual(after.host_items as Row[]);
  });
});

describe("canvas html", () => {
  test("strips fences, document chrome, comments and external references", () => {
    const out = sanitizeCanvasHtml(
      '```html\n<html><head><style>x</style></head><body><!-- me --><img src="https://x.io/a.png"><div style="background:url(//cdn/x)">hi</div></body></html>\n```',
    );
    expect(out.html).toBe('<img src="#"><div style="background:url(\'\')">hi</div>');
    expect(out.strippedReferences).toBe(2);
  });

  test("refuses empty, text-only and oversize output with the Python texts", () => {
    expect(() => sanitizeCanvasHtml("  ")).toThrow("Empty canvas HTML");
    expect(() => sanitizeCanvasHtml("just words")).toThrow(
      "Canvas output has no renderable content",
    );
    expect(() => sanitizeCanvasHtml("<p>abcdef</p>", 5)).toThrow(
      "Canvas HTML is too large (13 bytes)",
    );
  });
});

describe("canvas service", () => {
  test("the beta gate answers 404 Not found when canvas is off globally", async () => {
    const { store } = memoryStore();
    await expect(svc.canvases(deps(store, false), host, P, null)).rejects.toThrow(NotFoundError);
  });

  test("a direct edit keeps a standing edit once, stores the generation and clears failures", async () => {
    const { store, writes } = memoryStore();
    const out = await svc.editCanvas(
      deps(store),
      host,
      P,
      "chat-1",
      "7",
      " Keep it short ",
      "<p>ok</p>",
    );
    expect(out).toMatchObject({ id: "7", status: "edited", generation: { id: "gen" } });
    const config = writes.find((w) => w.kind === "config")?.value as Row;
    expect(config.brief).toBe("Track.\n\nStanding edits:\n- Keep it short");
    expect(config.gatherSpec).toEqual({ window_minutes: 60 });
    expect((writes.find((w) => w.kind === "generation")?.value as Row | undefined)?.detail).toBe(
      "direct edit: Keep it short; chat_id=chat-1",
    );
    expect(writes.at(-1)).toEqual({ kind: "loop", value: { failure_count: 0 } });
  });

  test("without the ledger columns the config and loop read as missing, as in Python", async () => {
    const { store, writes } = memoryStore({ ledger: false });
    await expect(svc.editCanvas(deps(store), host, P, null, "7", "x", "<p>x</p>")).rejects.toThrow(
      "Canvas config not found",
    );
    await expect(
      svc.addCanvasHostItem(deps(store), host, P, null, "7", { text: "x", target_tab: "story" }),
    ).rejects.toThrow(BadRequestError);
    await expect(svc.canvasLoop(deps(store), host, P, null, "7", "pause")).rejects.toThrow(
      "Canvas loop not found",
    );
    expect(writes).toEqual([]);
  });

  test("a host item lands on the loop and asks for a manual tick", async () => {
    const { store, writes } = memoryStore();
    const out = await svc.addCanvasHostItem(deps(store), host, P, "chat-1", "7", {
      text: " Night buses ",
      target_tab: "Concepts",
      person: " Ana ",
      message_id: "m1",
    });
    expect(out.status).toBe("added");
    expect(out.host_item).toMatchObject({
      text: "Night buses",
      person: "Ana",
      target_tab: "concept_cloud",
      source: { chat_id: "chat-1", message_id: "m1" },
    });
    expect(writes.find((w) => w.kind === "task")?.value).toEqual({
      loop_id: LOOP,
      tick_kind: "manual",
    });
    await expect(
      svc.addCanvasHostItem(deps(store), host, P, null, "7", { text: "x", target_tab: "trace" }),
    ).rejects.toThrow("target_tab must be one of crux, concept_cloud, or story");
    const removed = await svc.removeCanvasHostItem(deps(store), host, P, null, "7", {
      item: "night",
    });
    expect(removed.status).toBe("removed");
  });

  test("loop actions: pause cancels ticks, resume refuses an ended loop with 409, bad actions 404", async () => {
    const { store, writes } = memoryStore();
    expect(await svc.canvasLoop(deps(store), host, P, null, "7", "pause")).toEqual({
      status: "paused",
      expires_at: "2099-01-01T00:00:00.000Z",
      cadence_minutes: 5,
    });
    expect(writes[0]).toEqual({ kind: "cancel", value: { loop_id: LOOP } });
    expect((await svc.canvasLoop(deps(store), host, P, null, "7", "resume")).status).toBe("active");
    const ended = memoryStore({
      loop: { id: LOOP, status: "active", expires_at: "2026-01-01T00:00:00.000Z" },
    });
    await expect(svc.canvasLoop(deps(ended.store), host, P, null, "7", "resume")).rejects.toThrow(
      ConflictError,
    );
    await expect(svc.canvasLoop(deps(store), host, P, null, "7", "explode")).rejects.toThrow(
      "Canvas loop action not found",
    );
  });

  test("history lists host items and versions newest first", async () => {
    const { store } = memoryStore({
      loop: {
        id: LOOP,
        canvas_host_items: [
          { id: "h", text: "Ask", added_at: "2026-09-20T10:00:00+00:00", removed_at: null },
        ],
      },
    });
    const entries = await buildCanvasHistory(store, "7");
    expect(entries).toEqual([
      {
        at: "2026-09-20T10:00:00+00:00",
        kind: "host item added",
        version: null,
        cause: { type: "host", chat_id: null, message_id: null, run_chat_id: null },
        heard: ["Ask"],
        changes: ["Ask"],
        kept_out: [],
      },
    ]);
  });
});
