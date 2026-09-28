import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrizzleAccessStore } from "@dembrane/access";
import { createDb } from "@dembrane/db";
import { FilesystemStorage } from "@dembrane/storage";
import postgres from "postgres";
import { workspaceContext } from "../src/context";
import { MemoryJobSink } from "../src/jobs";
import { expireOverdueSupportMemberships, runDueScheduledTasks } from "../src/scheduled";
import { settingsService } from "../src/service/settings";

// Runs the jobs parity cannot reach (they have no HTTP route) against a copy of the parity
// platform template: TEST_PARITY_ADMIN_URL=postgres://dembrane:dembrane@localhost:5440/postgres
const admin = process.env.TEST_PARITY_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "tenancy_it";
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${DB}` : "";

const WS = "c0000000-0000-4000-8000-000000000001";
const ALICE = "a0000000-0000-4000-8000-000000000002";
const STAFF = "a0000000-0000-4000-8000-000000000001";
const SUPPORT_ROW = "9c000000-0000-4000-8000-000000000001";

run("tenancy jobs on a parity copy", () => {
  const database = admin ? createDb({ url, poolMax: 4 }) : (undefined as never);
  let sql: postgres.Sql;
  const jobs = new MemoryJobSink();
  const deps = () => ({ db: database.db, jobs, dashboardUrl: "http://dash.test" });

  beforeAll(async () => {
    const root = postgres(admin as string, { max: 1, onnotice: () => {} });
    await root.unsafe(`drop database if exists ${DB} with (force)`);
    await root.unsafe(
      `create database ${DB} template ${process.env.PARITY_TEMPLATE ?? "parity_template_platform"}`,
    );
    await root.end();
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const root = postgres(admin as string, { max: 1, onnotice: () => {} });
    await root.unsafe(`drop database if exists ${DB} with (force)`);
    await root.end();
  });

  test("the revoke timer ends the last support session and turns consent off", async () => {
    await sql`update workspace set allow_support_access = true where id = ${WS}`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at)
      values (${SUPPORT_ROW}, ${WS}, ${STAFF}, 'admin', 'staff_support', now() - interval '1 minute')`;
    await sql`insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts)
      values ('9d000000-0000-4000-8000-000000000001', 'revoke_staff_support',
        ${sql.json({ workspace_id: WS, membership_id: SUPPORT_ROW, org_id: null })}, now() - interval '1 minute', 'scheduled', 0)`;
    jobs.jobs.length = 0;
    expect(await runDueScheduledTasks(deps())).toBe(1);
    const [m] = await sql`select deleted_at from workspace_membership where id = ${SUPPORT_ROW}`;
    expect(m?.deleted_at).not.toBeNull();
    const [w] = await sql`select allow_support_access from workspace where id = ${WS}`;
    expect(w?.allow_support_access).toBe(false);
    const events =
      await sql`select event_code from support_access_event where workspace_id = ${WS} order by created_at, event_code`;
    expect(events.map((e) => e.event_code).sort()).toEqual([
      "staff_auto_revoked",
      "toggle_auto_disabled",
    ]);
    const notices =
      await sql`select event_code, audience_user_id from notification where event_code = 'SUPPORT_ACCESS_ENDED'`;
    expect(notices.map((n) => n.audience_user_id).sort()).toEqual([
      ALICE,
      "a0000000-0000-4000-8000-000000000004",
    ]);
    expect(jobs.jobs.map((j) => j.name)).toEqual(["tenancy.email"]);
    const [task] =
      await sql`select status, attempts from scheduled_task where id = '9d000000-0000-4000-8000-000000000001'`;
    expect(task).toMatchObject({ status: "completed", attempts: 1 });
  });

  test("the weekly reminder nudges while consent is on and re-arms itself", async () => {
    await sql`update workspace set allow_support_access = true where id = ${WS}`;
    await sql`insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts)
      values ('9d000000-0000-4000-8000-000000000002', 'support_toggle_reminder', ${sql.json({ workspace_id: WS })}, now() - interval '1 minute', 'scheduled', 0)`;
    expect(await runDueScheduledTasks(deps())).toBe(1);
    const next =
      await sql`select scheduled_at from scheduled_task where task_type = 'support_toggle_reminder' and status = 'scheduled'`;
    expect(next).toHaveLength(1);
    expect(new Date(next[0]?.scheduled_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const [e] =
      await sql`select count(*)::int as n from support_access_event where event_code = 'reminder_sent'`;
    expect(e?.n).toBe(1);
  });

  test("an expired request timer expires the request and tells the requester", async () => {
    await sql`insert into support_access_request (id, workspace_id, requested_by, status, created_at, expires_at)
      values ('9e000000-0000-4000-8000-000000000001', ${WS}, ${STAFF}, 'pending', now() - interval '8 days', now() - interval '1 day')`;
    await sql`insert into scheduled_task (id, task_type, payload, scheduled_at, status, attempts)
      values ('9d000000-0000-4000-8000-000000000003', 'expire_support_access_request', ${sql.json({ request_id: "9e000000-0000-4000-8000-000000000001" })}, now() - interval '1 minute', 'scheduled', 0)`;
    expect(await runDueScheduledTasks(deps())).toBe(1);
    const [r] =
      await sql`select status from support_access_request where id = '9e000000-0000-4000-8000-000000000001'`;
    expect(r?.status).toBe("expired");
    const [n] =
      await sql`select count(*)::int as n from notification where event_code = 'SUPPORT_REQUEST_EXPIRED' and audience_user_id = ${STAFF}`;
    expect(n?.n).toBe(1);
  });

  test("the 15 minute sweep ends overdue support rows whose timer was lost", async () => {
    await sql`insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at)
      values ('9c000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', ${STAFF}, 'admin', 'staff_support', now() - interval '2 hours')`;
    expect(await expireOverdueSupportMemberships(deps())).toBe(1);
    expect(await expireOverdueSupportMemberships(deps())).toBe(0);
  });

  test("a logo upload stores the object and a Directus file row, then replaces the old one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "logos-"));
    const objects = new FilesystemStorage(dir, "http://api.test/files");
    const svc = settingsService({
      ...deps(),
      accessStore: new DrizzleAccessStore(database.db),
      inviteSecret: "x".repeat(32),
      logos: { objects, location: "local" },
    });
    const who = {
      appUserId: ALICE,
      directusUserId: "d0000000-0000-4000-8000-000000000002",
      isStaff: false,
    };
    const ctx = await workspaceContext(new DrizzleAccessStore(database.db), who, WS, new Date());
    const png = new File([new Uint8Array([137, 80, 78, 71])], "brand-mark.png", {
      type: "image/png",
    });
    const first = await svc.uploadLogo(ctx, png);
    const [row] =
      await sql`select filename_disk, title, type, filesize from directus_files where id = ${first.file_id}`;
    expect(row).toMatchObject({ title: "Brand Mark", type: "image/png", filesize: "4" });
    expect(await objects.exists(row?.filename_disk)).toBe(true);
    const second = await svc.uploadLogo(ctx, png);
    const gone = await sql`select id from directus_files where id = ${first.file_id}`;
    expect(gone).toHaveLength(0);
    const [w] = await sql`select logo_url from workspace where id = ${WS}`;
    expect(w?.logo_url).toBe(second.file_id);
    await expect(
      svc.uploadLogo(ctx, new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })),
    ).rejects.toThrow("Logo must be PNG, JPEG, or WebP");
  });
});
