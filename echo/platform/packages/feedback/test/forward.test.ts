import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "@echo/observability";
import { runForwardSupport, type SupportForwarder, type SupportRow, supportPayload } from "../src";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const row = (id: string, extra: Partial<SupportRow> = {}): SupportRow => ({
  id,
  message: `help ${id}`,
  page_context: null,
  source: "agentic_chat",
  created_at: "2026-09-28T10:00:00.000Z",
  chat_id: null,
  project_id: null,
  workspace_id: null,
  app_user_id: null,
  directus_user_id: null,
  org_id: null,
  ...extra,
});

function harness(rows: SupportRow[], statuses: (number | Error)[]) {
  const sent: Record<string, unknown>[] = [];
  const stamped: string[] = [];
  const forwarder: SupportForwarder = {
    async post(p) {
      sent.push(p);
      const s = statuses.shift() ?? 200;
      if (s instanceof Error) throw s;
      return { status: s, text: "" };
    },
  };
  const outbox = {
    unforwarded: async () => rows.filter((r) => !stamped.includes(r.id)),
    markForwarded: async (id: string) => {
      stamped.push(id);
    },
  };
  return {
    sent,
    stamped,
    d: {
      outbox,
      forwarder,
      environment: "echo-next",
      dashboardUrl: "https://dashboard.echo-next.dembrane.com/",
      logger,
    },
  };
}

test("2xx stamps, 4xx is skipped and left, 5xx stops the batch; the next run retries the rest", async () => {
  const { sent, stamped, d } = harness([row("1"), row("2"), row("3"), row("4")], [200, 422, 503]);
  expect(await runForwardSupport(d)).toBe(1);
  expect(sent.map((p) => p.id)).toEqual(["1", "2", "3"]);
  expect(stamped).toEqual(["1"]);
  expect(await runForwardSupport(d)).toBe(3);
  expect(stamped).toEqual(["1", "2", "3", "4"]);
  // Nothing left: a third run posts nothing, so each request reaches sam once.
  expect(await runForwardSupport(d)).toBe(0);
  expect(sent).toHaveLength(6);
});

test("a network failure stops the batch without stamping; forwarding off posts nothing", async () => {
  const { sent, stamped, d } = harness([row("1"), row("2")], [new Error("down")]);
  expect(await runForwardSupport(d)).toBe(0);
  expect(sent).toHaveLength(1);
  expect(stamped).toEqual([]);
  expect(await runForwardSupport({ ...d, forwarder: null })).toBe(0);
  expect(sent).toHaveLength(1);
});

test("payload: id, environment and message always; empty fields omitted; origin link", () => {
  expect(supportPayload(row("1", { message: "" }), "production", "https://x")).toEqual({
    id: "1",
    environment: "production",
    message: "(empty message)",
    source: "agentic_chat",
    created_at: "2026-09-28T10:00:00.000Z",
  });
  expect(
    supportPayload(
      row("2", {
        page_context: "chat",
        chat_id: "c1",
        project_id: "p1",
        workspace_id: "w1",
        app_user_id: "a1",
        directus_user_id: "d1",
        org_id: "o1",
      }),
      "echo-next",
      "https://dashboard.echo-next.dembrane.com/",
    ),
  ).toEqual({
    id: "2",
    environment: "echo-next",
    message: "help 2",
    page_context: "chat",
    source: "agentic_chat",
    created_at: "2026-09-28T10:00:00.000Z",
    chat_id: "c1",
    project_id: "p1",
    workspace_id: "w1",
    app_user_id: "a1",
    directus_user_id: "d1",
    org_id: "o1",
    origin_link: "https://dashboard.echo-next.dembrane.com/en-US/w/w1/projects/p1",
  });
});
