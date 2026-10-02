import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { runForwardSupport, type SupportRow, supportInboxMessage } from "@dembrane/feedback";
import { createLogger } from "@dembrane/observability";
import {
  bookingInboxMessage,
  httpForwarder,
  type PricingRow,
  runForwardBookings,
} from "@dembrane/pricing";
import { samInboxForwarder, samInboxSignature } from "@dembrane/webhooks";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

// The worker picks sam's inbox when SAM_INBOX_* is set and the team webhook otherwise;
// these run each outbox the way registrations() wires it, against a local receiver.
describe("outboxes to sam", () => {
  const seen: { path: string; headers: Headers; raw: string }[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const secret = "q".repeat(48);
  const from = "api.staging.dembrane.com";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push({ path: new URL(req.url).pathname, headers: req.headers, raw: await req.text() });
        return new Response("ok");
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const inbox = (toMessage: Parameters<typeof samInboxForwarder>[2]) =>
    samInboxForwarder({ url: `${base}/inbox`, secret, from }, { allowPrivate: true }, toMessage);
  const team = () => httpForwarder(`${base}/team`, "team-token");

  const supportRow = (id: string, source: string): SupportRow => ({
    id,
    message: `help ${id}`,
    page_context: null,
    source,
    created_at: "2026-10-02T09:00:00.000Z",
    chat_id: null,
    project_id: null,
    workspace_id: null,
    app_user_id: null,
    directus_user_id: null,
    org_id: null,
  });

  const runSupport = async (forwarder: ReturnType<typeof team>) => {
    const stamped: string[] = [];
    const rows = [supportRow("s1", "dashboard"), supportRow("s2", "assistant")];
    await runForwardSupport({
      outbox: {
        unforwarded: async () => rows.filter((r) => !stamped.includes(r.id)),
        markForwarded: async (id: string) => {
          stamped.push(id);
        },
      },
      forwarder,
      environment: "echo-next",
      dashboardUrl: "",
      logger,
    });
    return stamped;
  };

  test("support requests with the inbox on: signed, coded by source, row id as message id", async () => {
    seen.length = 0;
    expect(await runSupport(inbox(supportInboxMessage))).toEqual(["s1", "s2"]);
    expect(seen.map((r) => r.path)).toEqual(["/inbox", "/inbox"]);
    expect(seen.map((r) => JSON.parse(r.raw).code)).toEqual([
      "echo_support_manual_escalated_v1",
      "echo_support_chat_escalated_v1",
    ]);
    for (const r of seen) {
      const id = r.headers.get("x-webhook-id") as string;
      expect(JSON.parse(r.raw).json.id).toBe(id);
      expect(r.headers.get("x-echo-support-token")).toBeNull();
      expect(r.headers.get("x-webhook-signature")).toBe(
        samInboxSignature({
          secret,
          from,
          timestamp: r.headers.get("x-webhook-timestamp") as string,
          id,
          body: r.raw,
        }),
      );
    }
  });

  test("support requests with the inbox off: the team webhook, unchanged", async () => {
    seen.length = 0;
    expect(await runSupport(team())).toEqual(["s1", "s2"]);
    expect(seen.map((r) => r.path)).toEqual(["/team", "/team"]);
    expect(seen[0]?.headers.get("x-echo-support-token")).toBe("team-token");
    expect(seen[0]?.headers.get("x-webhook-signature")).toBeNull();
    expect(JSON.parse(seen[0]?.raw ?? "")).toMatchObject({ id: "s1", source: "dashboard" });
  });

  const booking = {
    id: "p1",
    reference: "DEM-1",
    booking_uid: "bk-1",
    booking_status: "accepted",
    booking_notified_at: null,
    is_internal: false,
    email: "a@x.com",
    locale: null,
    workspace_id: null,
    org_id: null,
    mount: "app",
    project_id: null,
    config: null,
    answers_raw: null,
  } as unknown as PricingRow;

  test("pricing bookings go to the inbox under their booking uid, or to the team webhook", async () => {
    for (const [forwarder, path] of [
      [inbox(bookingInboxMessage), "/inbox"],
      [team(), "/team"],
    ] as const) {
      seen.length = 0;
      const stamped: string[] = [];
      await runForwardBookings({
        store: {
          unforwardedBookings: async () => (stamped.length ? [] : [booking]),
          update: async (id: string) => {
            stamped.push(id);
            return null as never;
          },
        },
        forwarder,
        environment: "echo-next",
        logger,
      });
      expect(stamped).toEqual(["p1"]);
      expect(seen.map((r) => r.path)).toEqual([path]);
      if (path === "/inbox") {
        expect(seen[0]?.headers.get("x-webhook-id")).toBe("bk-1");
        expect(JSON.parse(seen[0]?.raw ?? "").code).toBe("echo_pricing_booking_confirmed_v1");
      }
    }
  });
});
