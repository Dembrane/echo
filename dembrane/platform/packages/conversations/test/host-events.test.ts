import { describe, expect, test } from "bun:test";
import type { Capture } from "@dembrane/analytics";
import {
  conversationCreated,
  conversationOrigin,
  FIRST_VALUE,
  type HostEventDeps,
  type HostEventStore,
  type ProjectOwner,
  transcriptReady,
} from "../src/host-events";
import { quiet } from "./pipeline-harness";

const HOST = "d0000000-0000-4000-8000-000000000001";
const OTHER = "d0000000-0000-4000-8000-000000000002";

type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };

/** A fake store whose claim behaves like the primary key: first caller wins, even concurrently. */
function harness(projects: Record<string, ProjectOwner>, durations: Record<string, number> = {}) {
  const claimed = new Set<string>();
  const sent: Sent[] = [];
  const store: HostEventStore = {
    async projectOwner(id) {
      return projects[id] ?? null;
    },
    async conversationDuration(id) {
      return durations[id] ?? null;
    },
    async claimMilestone(user, milestone) {
      // Yield first, so concurrent callers really interleave.
      await Promise.resolve();
      const key = `${user}:${milestone}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
  const capture: Capture = async (distinctId, event, properties) => {
    sent.push({ distinctId, event, properties });
  };
  const d: HostEventDeps = { store, capture, logger: quiet, now: () => new Date("2026-11-10") };
  const firsts = () => sent.filter((s) => s.event === "server_first_value_reached");
  return { d, sent, claimed, firsts };
}

const owner = (o: Partial<ProjectOwner> = {}): ProjectOwner => ({
  directusUserId: HOST,
  email: "Host@Example.NL",
  isSample: false,
  language: "nl",
  ...o,
});

const created = (conversationId: string, projectId: string, source = "PORTAL_AUDIO") => ({
  conversationId,
  projectId,
  source,
  byHost: source === "DASHBOARD_UPLOAD",
});

describe("server_conversation_created", () => {
  test("goes to the project creator, by lowercased email, with ids only", async () => {
    const h = harness({ p1: owner() });
    await conversationCreated(h.d, created("c1", "p1", "DASHBOARD_UPLOAD"));
    expect(h.sent[0]).toEqual({
      distinctId: "host@example.nl",
      event: "server_conversation_created",
      properties: { conversation_id: "c1", project_id: "p1", source: "upload", by_host: true },
    });
  });

  test("falls back to the Directus id when the creator has no email", async () => {
    const h = harness({ p1: owner({ email: null }) });
    await conversationCreated(h.d, created("c1", "p1"));
    expect(h.sent.map((s) => s.distinctId)).toEqual([HOST, HOST]);
  });

  test("sends nothing for a project with no creator or no row", async () => {
    const h = harness({ p1: owner({ directusUserId: null }) });
    await conversationCreated(h.d, created("c1", "p1"));
    await conversationCreated(h.d, created("c2", "missing"));
    expect(h.sent).toEqual([]);
  });

  test("names the origin: an upload, everything else the portal", () => {
    expect(conversationOrigin("DASHBOARD_UPLOAD")).toBe("upload");
    expect(conversationOrigin("PORTAL_AUDIO")).toBe("portal");
    expect(conversationOrigin("PORTAL_TEXT")).toBe("portal");
    expect(conversationOrigin(null)).toBe("portal");
  });
});

describe("server_first_value_reached", () => {
  test("fires the first time only, for the creator", async () => {
    const h = harness({ p1: owner(), p2: owner() });
    await conversationCreated(h.d, created("c1", "p1"));
    await conversationCreated(h.d, created("c2", "p1"));
    await conversationCreated(h.d, created("c3", "p2", "DASHBOARD_UPLOAD"));
    expect(h.firsts()).toEqual([
      {
        distinctId: "host@example.nl",
        event: "server_first_value_reached",
        properties: { project_id: "p1", definition_version: 1 },
      },
    ]);
    expect([...h.claimed]).toEqual([`${HOST}:${FIRST_VALUE}`]);
  });

  test("is per host: another creator gets their own", async () => {
    const h = harness({
      p1: owner(),
      p2: owner({ directusUserId: OTHER, email: "other@example.nl" }),
    });
    await conversationCreated(h.d, created("c1", "p1"));
    await conversationCreated(h.d, created("c2", "p2"));
    expect(h.firsts().map((s) => s.distinctId)).toEqual(["host@example.nl", "other@example.nl"]);
  });

  test("never fires for a sample project, and a sample does not use it up", async () => {
    const h = harness({ sample: owner({ isSample: true }), real: owner() });
    await conversationCreated(h.d, created("c1", "sample"));
    expect(h.firsts()).toEqual([]);
    expect(h.claimed.size).toBe(0);
    await conversationCreated(h.d, created("c2", "real"));
    expect(h.firsts().map((s) => s.properties.project_id)).toEqual(["real"]);
  });

  test("is idempotent under retries and concurrent conversations", async () => {
    const h = harness({ p1: owner() });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => conversationCreated(h.d, created(`c${i}`, "p1"))),
    );
    await conversationCreated(h.d, created("c0", "p1"));
    expect(h.firsts()).toHaveLength(1);
    expect(h.sent.filter((s) => s.event === "server_conversation_created")).toHaveLength(11);
  });
});

describe("server_transcript_ready", () => {
  test("carries the duration in whole seconds and the project's language", async () => {
    const h = harness({ p1: owner() }, { c1: 61.6 });
    await transcriptReady(h.d, { conversationId: "c1", projectId: "p1" });
    expect(h.sent).toEqual([
      {
        distinctId: "host@example.nl",
        event: "server_transcript_ready",
        properties: { conversation_id: "c1", project_id: "p1", duration_s: 62, language: "nl" },
      },
    ]);
  });

  test("sends a null duration before it is measured", async () => {
    const h = harness({ p1: owner() });
    await transcriptReady(h.d, { conversationId: "c1", projectId: "p1" });
    expect(h.sent[0]?.properties.duration_s).toBeNull();
  });
});
