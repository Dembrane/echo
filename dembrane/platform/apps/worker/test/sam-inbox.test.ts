import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { overageInboxMessage } from "@dembrane/billing";
import { runForwardSupport, type SupportRow, supportInboxMessage } from "@dembrane/feedback";
import { createLogger } from "@dembrane/observability";
import {
  bookingInboxMessage,
  httpForwarder,
  type PricingRow,
  runForwardBookings,
} from "@dembrane/pricing";
import {
  deliverSamMessage,
  httpSamInbox,
  MemorySamQueue,
  quarantineSamMessage,
  runDeliverSamMessage,
  type SamEnvelope,
  samInboxForwarder,
  samInboxSignature,
} from "@dembrane/webhooks";

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

  const supportOutbox = (rows: SupportRow[]) => {
    const stamped: string[] = [];
    return {
      stamped,
      outbox: {
        // Oldest first, 50 at a time, as the real outbox reads.
        unforwarded: async (limit: number) =>
          rows.filter((r) => !stamped.includes(r.id)).slice(0, limit),
        markForwarded: async (id: string) => {
          stamped.push(id);
        },
      },
    };
  };

  test("support requests with the inbox on: queued by source code, delivered signed", async () => {
    const q = new MemorySamQueue();
    const o = supportOutbox([supportRow("s1", "dashboard"), supportRow("s2", "assistant")]);
    await runForwardSupport({
      outbox: o.outbox,
      forwarder: samInboxForwarder(q, supportInboxMessage),
      environment: "echo-next",
      dashboardUrl: "",
      logger,
    });
    expect(o.stamped).toEqual(["s1", "s2"]);
    const queued = q.of<SamEnvelope>(deliverSamMessage.name);
    expect(queued.map((e) => [e.code, e.id])).toEqual([
      ["echo_support_manual_escalated_v1", "s1"],
      ["echo_support_chat_escalated_v1", "s2"],
    ]);

    // The worker then sends each stored envelope.
    seen.length = 0;
    const post = httpSamInbox({ url: `${base}/inbox`, secret, from }, { allowPrivate: true });
    for (const e of queued)
      await runDeliverSamMessage({ post, logger, quarantine: async () => {} }, e);
    expect(seen.map((r) => r.path)).toEqual(["/inbox", "/inbox"]);
    for (const [i, r] of seen.entries()) {
      expect(r.raw).toBe(queued[i]?.body as string);
      expect(r.headers.get("x-echo-support-token")).toBeNull();
      expect(r.headers.get("x-webhook-signature")).toBe(
        samInboxSignature({
          secret,
          from,
          timestamp: r.headers.get("x-webhook-timestamp") as string,
          id: r.headers.get("x-webhook-id") as string,
          body: r.raw,
        }),
      );
    }
  });

  test("fifty unsendable rows at the head of the outbox no longer hold back newer ones", async () => {
    const q = new MemorySamQueue();
    const rows = [
      ...Array.from({ length: 55 }, (_, i) => supportRow(`old-${i}`, "legacy_source")),
      supportRow("new", "dashboard"),
    ];
    const o = supportOutbox(rows);
    const d = {
      outbox: o.outbox,
      forwarder: samInboxForwarder(q, supportInboxMessage),
      environment: "echo-next",
      dashboardUrl: "",
      logger,
    };
    await runForwardSupport(d);
    await runForwardSupport(d);
    expect(o.stamped).toHaveLength(56);
    expect(q.of(quarantineSamMessage.name)).toHaveLength(55);
    expect(q.of<SamEnvelope>(deliverSamMessage.name).map((e) => e.id)).toEqual(["new"]);
  });

  test("support requests with the inbox off: the team webhook, unchanged", async () => {
    seen.length = 0;
    const o = supportOutbox([supportRow("s1", "dashboard"), supportRow("s2", "assistant")]);
    await runForwardSupport({
      outbox: o.outbox,
      forwarder: team(),
      environment: "echo-next",
      dashboardUrl: "",
      logger,
    });
    expect(o.stamped).toEqual(["s1", "s2"]);
    expect(seen.map((r) => r.path)).toEqual(["/team", "/team"]);
    expect(seen[0]?.headers.get("x-echo-support-token")).toBe("team-token");
    expect(seen[0]?.headers.get("x-webhook-signature")).toBeNull();
    expect(JSON.parse(seen[0]?.raw ?? "")).toMatchObject({ id: "s1", source: "dashboard" });
  });

  test("an overage notice rebuilt with a changed peak resends the first envelope", async () => {
    const q = new MemorySamQueue();
    const fwd = samInboxForwarder(q, overageInboxMessage);
    const notice = (peak: number) => ({
      id: "ep-1:opened",
      environment: "production",
      message: `Account X has ${peak} recordings, cap 3.`,
    });
    // A delivery whose 2xx was lost leaves the row unstamped; the next run rebuilds it.
    await fwd.post(notice(5));
    await fwd.post(notice(7));
    const sent = q.of<SamEnvelope>(deliverSamMessage.name);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.code).toBe("echo_billing_overage_v1");
    expect(JSON.parse(sent[0]?.body ?? "").json.message).toContain("has 5 recordings");
  });

  const booking = (mount: "app" | "site") =>
    ({
      id: `p-${mount}`,
      reference: "DEM-1",
      booking_uid: `bk-${mount}`,
      booking_status: "accepted",
      booking_notified_at: null,
      is_internal: false,
      email: "a@x.com",
      locale: null,
      workspace_id: null,
      org_id: null,
      mount,
      project_id: null,
      config: null,
      answers_raw: null,
    }) as unknown as PricingRow;

  const runBookings = async (forwarder: ReturnType<typeof team>, rows: PricingRow[]) => {
    const stamped: string[] = [];
    await runForwardBookings({
      store: {
        unforwardedBookings: async () => rows.filter((r) => !stamped.includes(r.id)),
        update: async (id: string) => {
          stamped.push(id);
          return null as never;
        },
      },
      forwarder,
      environment: "echo-next",
      logger,
    });
    return stamped;
  };

  test("pricing bookings go to the inbox by origin under their booking uid", async () => {
    const q = new MemorySamQueue();
    const rows = [booking("app"), booking("site")];
    expect(await runBookings(samInboxForwarder(q, bookingInboxMessage), rows)).toEqual([
      "p-app",
      "p-site",
    ]);
    expect(q.of<SamEnvelope>(deliverSamMessage.name).map((e) => [e.code, e.id])).toEqual([
      ["echo_pricing_booking_confirmed_v1", "bk-app"],
      ["website_pricing_booking_confirmed_v1", "bk-site"],
    ]);
  });

  test("pricing bookings with the inbox off: the team webhook, unchanged", async () => {
    seen.length = 0;
    expect(await runBookings(team(), [booking("app")])).toEqual(["p-app"]);
    expect(seen.map((r) => r.path)).toEqual(["/team"]);
    expect(seen[0]?.headers.get("x-echo-support-token")).toBe("team-token");
  });
});
