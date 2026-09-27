import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { PlatformError } from "@echo/core";
import type { Db } from "@echo/db";
import type { Env } from "@echo/http";
import { createLogger } from "@echo/observability";
import { FilesystemStorage } from "@echo/storage";
import { Hono } from "hono";
import {
  buildAnswersSummary,
  configWithBooking,
  type PricingRow,
  type PricingStore,
  pricingRoutes,
  upsertConfiguration,
} from "../src";

const root = join(tmpdir(), `pricing-test-${process.pid}`);
afterAll(() => rm(root, { recursive: true, force: true }));
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

/** In-memory twin of pricingStorage for the upsert rules. */
function memStore() {
  const rows = new Map<string, PricingRow>();
  const store: PricingStore = {
    directusEmail: async () => "Someone@Example.com",
    bySession: async (s) => [...rows.values()].find((r) => r.config_session_id === s) ?? null,
    insert: async (r) => {
      const row = {
        booking_status: "none",
        booking_uid: null,
        voice_audio: null,
        booking_notified_at: null,
        updated_at: null,
        ...r,
      } as PricingRow;
      if ([...rows.values()].some((x) => x.reference === row.reference)) throw new Error("dup");
      rows.set(row.id, row);
      return row;
    },
    update: async (id, patch, now) => {
      const row = {
        ...(rows.get(id) as PricingRow),
        ...patch,
        updated_at: now.toISOString(),
      } as PricingRow;
      rows.set(id, row);
      return row;
    },
    unforwardedBookings: async () =>
      [...rows.values()].filter((r) => r.booking_uid && !r.booking_notified_at),
  };
  return { store, rows };
}

const base = {
  config_session_id: "s1",
  question_set_version: "",
  config_shape_version: null,
  mount: "app" as const,
  locale: "",
  wall_key: null,
  workspace_id: null,
  org_id: null,
  project_id: null,
  answers_raw: {},
  config: {},
  status: "in_progress" as const,
  booking_uid: null,
  booking_status: null,
  booking_start: null,
};
const id = { email: "a@x.com", userId: "u1", isInternal: false, prefix: "DEM-" };

test("one row per session, a stable reference, submitted never goes back", async () => {
  const { store, rows } = memStore();
  const d = { store, storage: new FilesystemStorage(root, "http://t"), logger };
  const first = await upsertConfiguration(d, { ...base, status: "submitted" }, [], id);
  expect(first.reference).toMatch(/^DEM-[2-9A-HJKMNP-Z]{4}$/);
  const second = await upsertConfiguration(d, base, [], id);
  expect(second.reference).toBe(first.reference);
  expect(rows.size).toBe(1);
  expect([...rows.values()][0]?.status).toBe("submitted");
});

test("another user's session is refused", async () => {
  const { store } = memStore();
  const d = { store, storage: new FilesystemStorage(root, "http://t"), logger };
  await upsertConfiguration(d, base, [], id);
  await expect(upsertConfiguration(d, base, [], { ...id, userId: "u2" })).rejects.toThrow(
    "This configuration belongs to another user",
  );
});

test("a booking is kept through later step writes and a rebook clears the forward stamp", async () => {
  const { store, rows } = memStore();
  const d = { store, storage: new FilesystemStorage(root, "http://t"), logger };
  await upsertConfiguration(
    d,
    { ...base, booking_uid: "b1", booking_status: "Accepted", booking_start: "2026-10-01" },
    [],
    id,
  );
  const row = () => [...rows.values()][0] as PricingRow;
  expect(row().booking_status).toBe("accepted");
  expect(row().status).toBe("submitted");
  await store.update(row().id, { booking_notified_at: "2026-09-01T00:00:00Z" }, new Date());
  await upsertConfiguration(d, { ...base, config: { answered: 2 } }, [], id);
  expect(row().config).toEqual({
    answered: 2,
    booking: { uid: "b1", status: "accepted", start: "2026-10-01" },
  });
  expect(row().booking_notified_at).toBe("2026-09-01T00:00:00Z");
  await upsertConfiguration(d, { ...base, booking_uid: "b2" }, [], id);
  expect(row().booking_uid).toBe("b2");
  expect(row().booking_notified_at).toBeNull();
  expect((row().config as { booking: unknown }).booking).toEqual({ uid: "b2" });
});

test("a site write without an email keeps the email the booking brought", async () => {
  const { store, rows } = memStore();
  const d = { store, storage: new FilesystemStorage(root, "http://t"), logger };
  const site = { ...id, userId: null, prefix: "WEB-" };
  await upsertConfiguration(d, { ...base, mount: "site" }, [], {
    ...site,
    email: "b@dembrane.com",
    isInternal: true,
  });
  await upsertConfiguration(d, { ...base, mount: "site" }, [], {
    ...site,
    email: null,
    isInternal: false,
  });
  const row = [...rows.values()][0] as PricingRow;
  expect(row.email).toBe("b@dembrane.com");
  expect(row.is_internal).toBe(true);
  expect(row.reference?.startsWith("WEB-")).toBe(true);
});

test("recordings go to object storage after the answers, and failures only warn", async () => {
  const { store, rows } = memStore();
  const storage = new FilesystemStorage(root, "http://t");
  const d = { store, storage, logger };
  const out = await upsertConfiguration(
    d,
    base,
    [
      {
        questionKey: "context",
        filename: "a b.webm",
        contentType: "audio/webm",
        durationMs: 1200,
        content: new Uint8Array([1, 2]),
      },
      {
        questionKey: "timing",
        filename: "t.webm",
        contentType: "audio/webm",
        durationMs: null,
        content: new Uint8Array(),
      },
    ],
    id,
  );
  expect(out.warnings).toEqual([
    "The recording for timing was empty or too large, so it was not stored.",
  ]);
  const audio = [...rows.values()][0]?.voice_audio as {
    question_key: string;
    stored: boolean;
    storage_key?: string;
  }[];
  expect(audio.map((a) => [a.question_key, a.stored])).toEqual([
    ["context", true],
    ["timing", false],
  ]);
  expect(await storage.exists(audio[0]?.storage_key as string)).toBe(true);
});

test("summary reads like the old one", () => {
  expect(
    buildAnswersSummary({
      use_case: "something_else",
      use_case_other: "a   town\nhall",
      volume: "under_50",
      concurrency: "more_than_40",
      concurrency_exact: "55",
      extras: ["event_help", "new_thing"],
      context: "x".repeat(200),
    }),
  ).toBe(
    `Use case: something else: a town hall | Volume: under 50 | At once: more than 40 (55) | Extras: event help, new_thing | Notes: ${"x".repeat(157)}...`,
  );
  expect(buildAnswersSummary([])).toBe("");
  expect(configWithBooking({ a: 1 }, { config: { booking: {} } }, null)).toEqual({ a: 1 });
});

function siteApp(token: string | null) {
  const { store, rows } = memStore();
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("principal", null);
    await next();
  });
  a.route(
    "/",
    pricingRoutes({
      db: {} as Db,
      storage: new FilesystemStorage(root, "http://t"),
      logger,
      siteToken: token,
      store,
    }),
  );
  a.onError((err, c) =>
    err instanceof PlatformError
      ? c.json({ detail: err.details ?? err.message }, err.status as 400)
      : c.json({}, 500),
  );
  return { a, rows };
}

test("the site route: closed without a token, 401 on a wrong one, a WEB- row on the right one", async () => {
  const post = (a: Hono<Env>, headers: Record<string, string>, body: unknown) =>
    a.request("/api/v2/pricing-configurations/site", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect((await post(siteApp(null).a, {}, base)).status).toBe(503);
  const { a, rows } = siteApp("tok");
  const wrong = await post(a, { "x-site-token": "nope" }, base);
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ detail: "Invalid site token" });
  const ok = await post(
    a,
    { "x-site-token": "tok" },
    { ...base, mount: "app", email: " Lead@Example.COM " },
  );
  expect(ok.status).toBe(200);
  const row = [...rows.values()][0] as PricingRow;
  expect(row.mount).toBe("site");
  expect(row.email).toBe("lead@example.com");
  expect(row.user_id).toBeNull();
  expect(row.reference?.startsWith("WEB-")).toBe(true);
  const invalid = await post(a, { "x-site-token": "tok" }, { email: 5 });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toEqual({
    detail: [
      { type: "missing", loc: ["config_session_id"], msg: "Field required", input: { email: 5 } },
      { type: "string_type", loc: ["email"], msg: "Input should be a valid string", input: 5 },
    ],
  });
});
