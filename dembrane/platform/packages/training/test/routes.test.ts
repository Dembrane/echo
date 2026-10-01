import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { MemoryStaffAudit } from "@dembrane/access";
import type { Billing } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { Hono } from "hono";
import { trainingRoutes } from "../src";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

function app(principal: Signed | null, audit: MemoryStaffAudit) {
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("principal", principal);
    c.set("requestId", "req-1");
    await next();
  });
  a.route(
    "/",
    trainingRoutes({
      db: {} as Db,
      staffAudit: audit,
      billing: { notifier: {} } as unknown as Billing,
      mailer: new MemoryMailer(),
      logger,
      config: { http: { dashboardUrl: "http://d" } },
    }),
  );
  a.onError((err, c) =>
    err instanceof PlatformError
      ? c.json({ detail: err.details ?? err.message }, err.status as 400)
      : c.json({ detail: String(err) }, 500),
  );
  return a;
}

const staff: Signed = { appUserId: "a1", directusUserId: "d1", isStaff: true };
const user: Signed = { appUserId: "a2", directusUserId: "d2", isStaff: false };

test("staff routes record the permission use before acting", async () => {
  const audit = new MemoryStaffAudit();
  const res = await app(staff, audit).request("/api/v2/admin/licenses/not-a-uuid/revoke", {
    method: "POST",
  });
  expect(res.status).toBe(404);
  expect(audit.entries).toEqual([
    {
      permission: "staff:training",
      action: "training_license.revoke",
      targetType: "training_license",
      targetId: "not-a-uuid",
      requestId: "req-1",
      staffUserId: "d1",
    },
  ]);
});

test("non-staff get Staff-only and leave no audit row", async () => {
  const audit = new MemoryStaffAudit();
  const res = await app(user, audit).request("/api/v2/admin/licenses/x/revoke", { method: "POST" });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ detail: "Staff-only" });
  expect(audit.entries).toEqual([]);
});

test("validation runs before the staff check, as FastAPI did", async () => {
  const res = await app(user, new MemoryStaffAudit()).request(
    "/api/v2/admin/trainings/x/complete",
    {
      method: "POST",
      body: JSON.stringify({ app_user_ids: [] }),
    },
  );
  expect(res.status).toBe(422);
  expect(((await res.json()) as { detail: { type: string }[] }).detail[0]?.type).toBe("too_short");
});
