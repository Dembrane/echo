import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "@dembrane/observability";
import {
  bookingInboxMessage,
  bookingPayload,
  ENQUIRY_GRACE_MS,
  enquiryInboxMessage,
  enquiryPayload,
  environmentName,
  type Forwarder,
  httpForwarder,
  type PricingRow,
  runForwardBookings,
  runForwardEnquiries,
} from "../src";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const row = (id: string, extra: Partial<PricingRow> = {}): PricingRow =>
  ({
    id,
    reference: `DEM-${id}`,
    booking_uid: `bk-${id}`,
    booking_status: "accepted",
    booking_notified_at: null,
    is_internal: false,
    email: "a@x.com",
    locale: null,
    workspace_id: null,
    org_id: null,
    mount: "app",
    project_id: null,
    config: { booking: { start: "2026-10-01T09:00:00Z" } },
    answers_raw: { volume: "under_50" },
    ...extra,
  }) as PricingRow;

function harness(rows: PricingRow[], statuses: (number | Error)[]) {
  const sent: Record<string, unknown>[] = [];
  const stamped: string[] = [];
  const forwarder: Forwarder = {
    async post(p) {
      sent.push(p);
      const s = statuses.shift() ?? 200;
      if (s instanceof Error) throw s;
      return { status: s, text: "" };
    },
  };
  const store = {
    unforwardedBookings: async () => rows.filter((r) => !stamped.includes(r.id)),
    unforwardedEnquiries: async () => [],
    update: async (id: string) => {
      stamped.push(id);
      return null;
    },
  };
  return { sent, stamped, d: { store, forwarder, environment: "echo-next", logger } };
}

test("delivered rows are stamped, 4xx rows are skipped and left, 5xx stops the batch", async () => {
  const { sent, stamped, d } = harness([row("1"), row("2"), row("3"), row("4")], [200, 422, 503]);
  expect(await runForwardBookings(d)).toBe(1);
  expect(sent.length).toBe(3);
  expect(stamped).toEqual(["1"]);
  // The next run retries exactly the unstamped rows.
  const again = await runForwardBookings(d);
  expect(again).toBe(3);
  expect(stamped).toEqual(["1", "2", "3", "4"]);
  expect(await runForwardBookings(d)).toBe(0);
});

test("a network failure stops the batch; forwarding off does nothing", async () => {
  const { stamped, d } = harness([row("1"), row("2")], [new Error("down")]);
  expect(await runForwardBookings(d)).toBe(0);
  expect(stamped).toEqual([]);
  expect(await runForwardBookings({ ...d, forwarder: null })).toBe(0);
});

test("payload shape: kind, always is_internal, absent fields omitted", () => {
  expect(bookingPayload(row("1", { email: null }), "production")).toEqual({
    kind: "pricing_booking",
    environment: "production",
    booking_uid: "bk-1",
    is_internal: false,
    reference: "DEM-1",
    booking_status: "accepted",
    mount: "app",
    booking_start: "2026-10-01T09:00:00Z",
    summary: "Volume: under 50",
  });
  expect(environmentName("https://dashboard.dembrane.com")).toBe("production");
  expect(environmentName("https://dashboard.staging.dembrane.com/")).toBe("echo-next");
  expect(environmentName("http://localhost:5173")).toBe("localhost");
});

test("httpForwarder posts JSON with the shared token header", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok", { status: 202 });
  }) as unknown as typeof fetch;
  const res = await httpForwarder("https://sam.example/hook", "tok", fetchStub).post({ id: "1" });
  expect(res).toEqual({ status: 202, text: "ok" });
  expect(calls[0]?.url).toBe("https://sam.example/hook");
  expect(calls[0]?.init.headers).toMatchObject({ "x-echo-support-token": "tok" });
  expect(calls[0]?.init.body).toBe('{"id":"1"}');
});

test("an app booking goes to sam's inbox as echo_pricing_booking_confirmed_v1 under its booking uid", () => {
  const payload = bookingPayload(row("1"), "production");
  expect(bookingInboxMessage(payload)).toEqual({
    code: "echo_pricing_booking_confirmed_v1",
    json: payload,
    id: "bk-1",
  });
  expect(bookingInboxMessage({ ...payload, kind: "something_else" })).toBeNull();
  expect(bookingInboxMessage({ ...payload, booking_uid: "" })).toBeNull();
});

test("a booking configured on the website's needs form is website_pricing_booking_confirmed_v1, same payload", () => {
  const payload = bookingPayload(row("2", { mount: "site" }), "production");
  const app = bookingPayload(row("2"), "production");
  expect(bookingInboxMessage(payload)).toEqual({
    code: "website_pricing_booking_confirmed_v1",
    json: payload,
    id: "bk-2",
  });
  // Only the origin differs between the two payloads.
  expect({ ...payload, mount: "app" } as Record<string, unknown>).toEqual(app);
});

const enquiry = (id: string, extra: Partial<PricingRow> = {}): PricingRow =>
  row(id, {
    reference: `WEB-${id}`,
    mount: "site",
    status: "submitted",
    booking_uid: null,
    booking_status: "none",
    submitted_at: "2026-11-04T09:00:00.000Z",
    enquiry_notified_at: null,
    config: {},
    ...extra,
  });

test("enquiries wait out the grace, go once, and are stamped only on a 2xx", async () => {
  const sent: Record<string, unknown>[] = [];
  const stamped: Record<string, unknown>[] = [];
  let asked = null as Date | null;
  const rows = [enquiry("1"), enquiry("2")];
  const now = new Date("2026-11-04T10:00:00.000Z");
  const d = {
    store: {
      unforwardedBookings: async () => [],
      unforwardedEnquiries: async (before: Date) => {
        asked = before;
        return rows.filter((r) => !stamped.some((p) => p.id === r.id));
      },
      update: async (id: string, patch: Record<string, unknown>) => {
        stamped.push({ id, ...patch });
        return null;
      },
    },
    forwarder: null,
    enquiryForwarder: {
      async post(p: Record<string, unknown>) {
        sent.push(p);
        return { status: sent.length === 2 ? 422 : 202, text: "" };
      },
    },
    environment: "production",
    logger,
    clock: () => now,
  };
  expect(await runForwardEnquiries(d)).toBe(1);
  expect(asked).toEqual(new Date(now.getTime() - ENQUIRY_GRACE_MS));
  expect(stamped).toEqual([{ id: "1", enquiry_notified_at: now.toISOString() }]);
  // The rejected one stays for the next run; nothing is sent without an enquiry forwarder.
  expect(await runForwardEnquiries({ ...d, enquiryForwarder: null })).toBe(0);
  expect(ENQUIRY_GRACE_MS).toBe(30 * 60_000);
});

test("enquiry payload and its inbox message match sam's enquiry handlers", () => {
  const payload = enquiryPayload(
    enquiry("1", { email: "lead@example.org", locale: "nl-NL", org_id: "o1", workspace_id: "w1" }),
    "production",
  );
  expect(payload).toEqual({
    kind: "pricing_enquiry",
    environment: "production",
    is_internal: false,
    reference: "WEB-1",
    email: "lead@example.org",
    submitted_at: "2026-11-04T09:00:00.000Z",
    locale: "nl-NL",
    workspace_id: "w1",
    org_id: "o1",
    mount: "site",
    summary: "Volume: under 50",
  });
  expect(enquiryInboxMessage(payload)).toEqual({
    code: "website_pricing_enquiry_submitted_v1",
    id: "WEB-1",
    json: {
      is_internal: false,
      reference: "WEB-1",
      email: "lead@example.org",
      submitted_at: "2026-11-04T09:00:00.000Z",
      locale: "nl-NL",
      workspace_id: "w1",
      org_id: "o1",
      summary: "Volume: under 50",
    },
  });
  expect(enquiryInboxMessage({ ...payload, mount: "app" })?.code).toBe(
    "echo_pricing_enquiry_submitted_v1",
  );
  // No email, nothing to send: an anonymous website visit never reaches the team.
  expect(enquiryInboxMessage({ ...payload, email: undefined })).toBeNull();
  expect(enquiryInboxMessage({ ...payload, kind: "pricing_booking" })).toBeNull();
});
