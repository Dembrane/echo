import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "@dembrane/observability";
import {
  bookingInboxMessage,
  bookingPayload,
  environmentName,
  type Forwarder,
  httpForwarder,
  type PricingRow,
  runForwardBookings,
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
