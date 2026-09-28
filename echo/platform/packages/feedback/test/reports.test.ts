import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, MemoryAccessStore, MemoryStaffAudit } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { Hono } from "hono";
import { buildReportMessage, buildReportPageContext, reportRoutes, safeFilename } from "../src";

const root = join(tmpdir(), `feedback-test-${process.pid}`);
afterAll(() => rm(root, { recursive: true, force: true }));

const alice: Signed = { appUserId: "a1", directusUserId: "d1", isStaff: false };
const staff: Signed = { appUserId: "a9", directusUserId: "d9", isStaff: true };

function app(who: Signed | null) {
  const inserted: Record<string, unknown>[] = [];
  const audit = new MemoryStaffAudit();
  const storage = new FilesystemStorage(root, "http://api.test");
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("principal", who);
    c.set("requestId", "req-1");
    await next();
  });
  a.route(
    "/",
    reportRoutes({
      db: {} as Db,
      access: new Access(new MemoryAccessStore()),
      staffAudit: audit,
      limiter: new RateLimiter(new MemoryRateCounter()),
      storage,
      apiBaseUrl: "https://api.example.com/api/",
      store: {
        directusProfile: async () => ({ email: "alice@example.com", first: "Alice", last: "O" }),
        insertSupportRequest: async (row) => {
          inserted.push(row as Record<string, unknown>);
        },
      },
    }),
  );
  a.onError((err, c) =>
    err instanceof PlatformError
      ? c.json({ detail: err.details ?? err.message }, err.status as 400)
      : c.json({ detail: String(err) }, 500),
  );
  return { app: a, inserted, audit, storage };
}

function form(fields: Record<string, string>, files: File[] = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const file of files) f.append("attachments", file);
  return { method: "POST", body: f };
}

const png = (name = "shot.png") =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

test("a report with an image stores it and files one support request", async () => {
  const { app: a, inserted, storage } = app(alice);
  const res = await a.request(
    "/api/v2/feedback/reports",
    form(
      {
        message: "  it broke  ",
        page_url: "https://dashboard.dembrane.com/w/1",
        locale: "nl-NL",
        session_replay_url: "https://evil.example.com/x",
      },
      [png("my screen..shot?.png")],
    ),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    report_id: string;
    support_request_id: string;
    attachment_count: number;
  };
  expect(body.attachment_count).toBe(1);
  const row = inserted[0] as Record<string, string>;
  expect(row.id).toBe(body.support_request_id);
  expect(row.source).toBe("dashboard");
  expect(row.status).toBe("new");
  expect(row.directus_user_id).toBe("d1");
  expect(row.page_context).toBe("Page: https://dashboard.dembrane.com/w/1 | Locale: nl-NL");
  expect(row.message).toContain("Reporter: Alice O (alice@example.com)");
  expect(row.message).toContain(
    `staff link, no expiry: https://api.example.com/api/v2/feedback/attachments/${body.report_id}/0-my_screen.shot_.png`,
  );
  expect(row.message).not.toContain("Session replay");
  expect(row.message?.endsWith("Message:\nit broke")).toBe(true);
  expect(await storage.exists(`feedback/${body.report_id}/0-my_screen.shot_.png`)).toBe(true);
});

test("validation answers the old 400s before spending the rate limit", async () => {
  const { app: a } = app(alice);
  const cases: [Record<string, string>, File[], string][] = [
    [{ message: "   " }, [], "Message is required."],
    [{ message: "x".repeat(5001) }, [], "Message is too long."],
    [{ message: "x" }, [png(), png(), png(), png(), png()], "At most 4 attachments."],
    [
      { message: "x" },
      [new File(["a"], "a.txt", { type: "text/plain" })],
      "Only image attachments.",
    ],
  ];
  for (const [fields, files, detail] of cases) {
    const res = await a.request("/api/v2/feedback/reports", form(fields, files));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail });
  }
});

test("five reports per ten minutes, then 429", async () => {
  const { app: a } = app(alice);
  for (let i = 0; i < 5; i++)
    expect((await a.request("/api/v2/feedback/reports", form({ message: "x" }))).status).toBe(201);
  expect((await a.request("/api/v2/feedback/reports", form({ message: "x" }))).status).toBe(429);
});

test("staff read attachments through a short-lived redirect, audited", async () => {
  const { app: a, audit, storage } = app(staff);
  await storage.put("feedback/r1/0-a.png", "x");
  const res = await a.request("/api/v2/feedback/attachments/r1/0-a.png");
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toContain("feedback/r1/0-a.png");
  expect(audit.entries[0]).toMatchObject({
    permission: "staff:feedback",
    targetId: "r1",
    staffUserId: "d9",
  });
  expect((await a.request("/api/v2/feedback/attachments/r1/missing.png")).status).toBe(404);
  expect((await a.request("/api/v2/feedback/attachments/r1/a..png")).status).toBe(400);
});

test("customers cannot read attachments", async () => {
  const { app: a } = app(alice);
  const res = await a.request("/api/v2/feedback/attachments/r1/0-a.png");
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ detail: "Staff only." });
});

test("message helpers keep the old text", () => {
  expect(safeFilename("../../etc passwd")).toBe("_._etc_passwd");
  expect(safeFilename("")).toBe("image");
  expect(
    buildReportMessage({
      reporterName: "A",
      reporterEmail: "a@x",
      message: "m",
      sessionReplayUrl: "https://eu.posthog.com/r/1",
      attachmentLinks: [],
    }),
  ).toBe(
    "Issue report from the dashboard\n\nReporter: A (a@x)\nSession replay: https://eu.posthog.com/r/1\n\nMessage:\nm",
  );
  expect(
    buildReportPageContext({ pageUrl: "javascript:alert(1)", locale: null, userAgent: "UA" }),
  ).toBe("Browser: UA");
});
