import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { DrizzleStaffAudit } from "@dembrane/access";
import { AI_SPEND_KEY, aiBudgetForProject, invalidateFreeLimits } from "@dembrane/allowance";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type postgres from "postgres";
import { staffRoutes } from "../src";

// Staff set a per-account AI budget and read AI costs for this and last month.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_ai_budget_${process.pid}`;
const NOW = new Date("2026-10-25T12:00:00Z");

const STAFF: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000001",
  directusUserId: "d0000000-0000-4000-8000-000000000001",
  isStaff: true,
};
const ALICE: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000002",
  directusUserId: "d0000000-0000-4000-8000-000000000002",
  isStaff: false,
};

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "warn" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

type Costs = {
  period_start: string;
  accounts: {
    billing_account_id: string;
    name: string;
    tier: string | null;
    cost_micro_eur: number;
    budget_micro_eur: number | null;
    percent_used: number | null;
    unlimited: boolean;
    override_until: string | null;
    by_feature: { operation: string; cost_micro_eur: number }[];
    by_model: { model: string; cost_micro_eur: number }[];
  }[];
  unattributed_micro_eur: number;
  by_provider: { provider: string; cost_micro_eur: number }[];
};

run("staff AI budget and costs", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const mailer = new MemoryMailer();
    const clock = () => NOW;
    const billing = createBilling({
      db: database.db,
      mollie: new FakeMollie(),
      mailer,
      logger,
      billingConfig: {
        webhookUrl: null,
        forceReconcileFailure: false,
        dashboardUrl: "https://dash.test",
      },
      clock,
    });
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = c.req.header("x-as");
      c.set("requestId", "req-1");
      c.set("principal", who === "staff" ? STAFF : who === "alice" ? ALICE : null);
      await next();
    });
    app.route(
      "/",
      staffRoutes({
        db: database.db,
        staffAudit: new DrizzleStaffAudit(database.db),
        billing,
        mailer,
        logger,
        config: { http: { dashboardUrl: "https://dash.test" } },
        clock,
      }),
    );
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const call = (as: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "x-as": as, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const audits = (action: string) =>
    database.db
      .select()
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.action, action))
      .orderBy(asc(schema.staff_audit_event.createdAt));

  async function seed(opts: {
    tier?: string;
    org?: string;
    label?: string | null;
    downgradedAt?: string | null;
  }) {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, ${opts.org ?? "o"})`;
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id, label, downgraded_at)
      values (${accountId}, ${opts.tier ?? "free"}, ${orgId}, ${opts.label ?? null},
        ${opts.downgradedAt ?? null})`;
    const ws = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${ws}, 'w', ${orgId}, ${accountId})`;
    const project = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id)
      values (${project}, true, ${ws})`;
    return { accountId, project };
  }

  async function modelCall(r: {
    at: string;
    account: string | null;
    payer?: string;
    operation: string | null;
    model: string;
    provider: string | null;
    cost: number | null;
  }) {
    await sql`insert into model_call (started_at, service, operation, model_group, model, kind,
        status, attempt, ms, provider, billing_account_id, payer, cost_micro_eur)
      values (${r.at}, 'api', ${r.operation}, 'g', ${r.model}, 'text', 'ok', 1, 10,
        ${r.provider}, ${r.account}, ${r.payer ?? (r.account ? "account" : "unattributed")},
        ${r.cost})`;
  }

  async function daily(r: {
    day: string;
    account: string | null;
    payer: string;
    operation: string;
    model: string;
    cost: number;
  }) {
    await sql`insert into ai_spend_daily (day, billing_account_id, payer, operation, model,
        calls, input_tokens, output_tokens, cost_micro_eur)
      values (${r.day}, ${r.account}, ${r.payer}, ${r.operation}, ${r.model}, 1, 0, 0, ${r.cost})`;
  }

  async function price(provider: string, model: string) {
    await sql`insert into ai_price (provider, model, currency, source, effective_from)
      values (${provider}, ${model}, 'USD', 'override', '2026-01-01T00:00:00Z')`;
  }

  async function spend(account: string, period: string, amount: number) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${account}, ${period}, ${AI_SPEND_KEY}, ${amount})`;
  }

  describe("per-account override", () => {
    test("set, read back by the budget check, and cleared; every call audited", async () => {
      const s = await seed({});
      const path = `/api/v2/admin/billing-accounts/${s.accountId}/ai-budget`;
      expect((await aiBudgetForProject(database.db, s.project, NOW))?.limitMicroEur).toBe(
        5_000_000,
      );

      const until = "2026-12-01T00:00:00.000Z";
      const set = await call("staff", "PUT", path, {
        amount_micro_eur: 20_000_000,
        unlimited: false,
        until,
      });
      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({
        status: "ok",
        billing_account_id: s.accountId,
        ai_budget_micro_eur: 20_000_000,
        ai_budget_unlimited: false,
        ai_budget_until: until,
      });
      expect((await aiBudgetForProject(database.db, s.project, NOW))?.limitMicroEur).toBe(
        20_000_000,
      );
      // The account modal reads the override from the billing rollup.
      const rollup = (await (
        await call("staff", "GET", "/api/v2/admin/billing-rollup")
      ).json()) as {
        accounts: { billing_account_id: string; ai_budget: unknown }[];
      };
      expect(rollup.accounts.find((a) => a.billing_account_id === s.accountId)?.ai_budget).toEqual({
        amount_micro_eur: 20_000_000,
        unlimited: false,
        until,
      });

      // Unlimited ignores the amount.
      const open = await call("staff", "PUT", path, {
        amount_micro_eur: 7,
        unlimited: true,
        until: null,
      });
      expect(open.status).toBe(200);
      expect(await open.json()).toMatchObject({
        ai_budget_micro_eur: null,
        ai_budget_unlimited: true,
        ai_budget_until: null,
      });
      expect((await aiBudgetForProject(database.db, s.project, NOW))?.limitMicroEur).toBeNull();

      const cleared = await call("staff", "DELETE", path);
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toEqual({
        status: "ok",
        billing_account_id: s.accountId,
        ai_budget_micro_eur: null,
        ai_budget_unlimited: false,
        ai_budget_until: null,
      });
      expect((await aiBudgetForProject(database.db, s.project, NOW))?.limitMicroEur).toBe(
        5_000_000,
      );

      const sets = await audits("billing_account.ai_budget.set");
      expect(
        sets
          .filter((a) => a.targetId === s.accountId)
          .map((a) => [a.permission, a.targetType, a.detail, a.requestId]),
      ).toEqual([
        [
          "staff:set_tier",
          "billing_account",
          { ai_budget_micro_eur: 20_000_000, ai_budget_unlimited: false, ai_budget_until: until },
          "req-1",
        ],
        // What took effect: unlimited stores no amount.
        [
          "staff:set_tier",
          "billing_account",
          { ai_budget_micro_eur: null, ai_budget_unlimited: true, ai_budget_until: null },
          "req-1",
        ],
      ]);
      const clears = await audits("billing_account.ai_budget.clear");
      expect(clears.filter((a) => a.targetId === s.accountId).map((a) => a.permission)).toEqual([
        "staff:set_tier",
      ]);
    });

    test("allows up to EUR 1,000 and rejects anything else", async () => {
      const s = await seed({});
      const path = `/api/v2/admin/billing-accounts/${s.accountId}/ai-budget`;
      const put = (body: unknown) => call("staff", "PUT", path, body);
      const ok = { amount_micro_eur: 1_000_000_000, unlimited: false, until: null };
      expect((await put(ok)).status).toBe(200);
      // The staff screen sends a UTC day.
      expect((await put({ ...ok, until: "2026-12-01" })).status).toBe(200);
      expect((await put({ ...ok, until: "2026-12-01T00:00:00+01:00" })).status).toBe(200);
      expect((await put({ ...ok, until: "2026-12-01T00:00:00.000Z" })).status).toBe(200);
      expect((await put({ ...ok, amount_micro_eur: 0 })).status).toBe(200);
      for (const bad of [
        { ...ok, amount_micro_eur: 1_000_000_001 },
        { ...ok, amount_micro_eur: -1 },
        { ...ok, amount_micro_eur: 1.5 },
        { ...ok, amount_micro_eur: "5000000" },
        { ...ok, amount_micro_eur: null },
        { ...ok, unlimited: "yes" },
        { ...ok, until: "not a date" },
        { ...ok, until: "2026-10-25T11:00:00Z" },
        { ...ok, until: 5 },
        // Date-parsable, but not ISO 8601.
        { ...ok, until: "December 1, 2026" },
        { ...ok, until: "2026/12/01" },
        { ...ok, until: "2026-12-01T00:00" },
      ])
        expect((await put(bad)).status).toBe(400);
      const missing = `/api/v2/admin/billing-accounts/${randomUUID()}/ai-budget`;
      expect((await call("staff", "PUT", missing, ok)).status).toBe(404);
      expect((await call("staff", "DELETE", missing)).status).toBe(404);
      const [row] = await database.db
        .select()
        .from(schema.billing_account)
        .where(eq(schema.billing_account.id, s.accountId));
      expect(row?.ai_budget_micro_eur).toBe(0);
    });

    test("a non-staff user gets 403 and nothing changes", async () => {
      const s = await seed({});
      const path = `/api/v2/admin/billing-accounts/${s.accountId}/ai-budget`;
      const body = { amount_micro_eur: 1, unlimited: false, until: null };
      expect((await call("alice", "PUT", path, body)).status).toBe(403);
      expect((await call("alice", "DELETE", path)).status).toBe(403);
      expect((await call("alice", "GET", "/api/v2/admin/ai-costs")).status).toBe(403);
      const [row] = await database.db
        .select()
        .from(schema.billing_account)
        .where(eq(schema.billing_account.id, s.accountId));
      expect(row?.ai_budget_micro_eur).toBeNull();
    });
  });

  describe("AI cost view", () => {
    let free: string;
    let paid: string;
    let down: string;
    let open: string;

    beforeAll(async () => {
      await sql`delete from model_call`;
      await sql`delete from ai_spend_daily`;
      free = (await seed({ org: "Free Org" })).accountId;
      // Onboarding labels every org account "Org billing": the org name wins.
      paid = (await seed({ tier: "changemaker", org: "Paid Org", label: "Org billing" })).accountId;
      down = (await seed({ org: "Down Org", downgradedAt: "2026-10-10T00:00:00Z" })).accountId;
      open = (await seed({ org: "Open Org" })).accountId;
      await sql`update billing_account set ai_budget_micro_eur = 1000000,
        ai_budget_until = '2026-12-01T00:00:00Z' where id = ${down}`;
      await sql`update billing_account set ai_budget_unlimited = true where id = ${open}`;
      await price("vertex", "gemini-flash");
      await price("anthropic", "claude");
      await price("vertex", "shared");
      await price("openai", "shared");

      // October (this month).
      const oct = (day: string) => `2026-10-${day}T09:00:00Z`;
      await modelCall({
        at: oct("03"),
        account: free,
        operation: "chat.reply",
        model: "gemini-flash",
        provider: "vertex",
        cost: 1_000_000,
      });
      await modelCall({
        at: oct("04"),
        account: free,
        operation: "report.generate",
        model: "claude",
        provider: "anthropic",
        cost: 500_000,
      });
      await modelCall({
        at: oct("05"),
        account: free,
        operation: "report.generate",
        model: "claude",
        provider: "anthropic",
        cost: null,
      });
      await modelCall({
        at: oct("06"),
        account: paid,
        operation: "chat.reply",
        model: "gemini-flash",
        provider: "vertex",
        cost: 2_000_000,
      });
      await modelCall({
        at: oct("05"),
        account: down,
        operation: "chat.reply",
        model: "gemini-flash",
        provider: "vertex",
        cost: 300_000,
      });
      await modelCall({
        at: oct("15"),
        account: down,
        operation: "chat.reply",
        model: "gemini-flash",
        provider: "vertex",
        cost: 200_000,
      });
      await modelCall({
        at: oct("16"),
        account: open,
        operation: null,
        model: "gemini-flash",
        provider: "vertex",
        cost: 100_000,
      });
      await modelCall({
        at: oct("17"),
        account: null,
        operation: "transcribe",
        model: "gemini-flash",
        provider: "vertex",
        cost: 70_000,
      });
      await modelCall({
        at: oct("18"),
        account: null,
        payer: "internal",
        operation: "price-sync",
        model: "gemini-flash",
        provider: "vertex",
        cost: 40_000,
      });
      await spend(free, "2026-10-01T00:00:00Z", 1_500_000);
      await spend(down, "2026-10-01T00:00:00Z", 300_000);
      await spend(down, "2026-10-10T00:00:00Z", 200_000);
      await spend(open, "2026-10-01T00:00:00Z", 100_000);
      // Rolled up October days are not read for this month.
      await daily({
        day: "2026-10-03",
        account: free,
        payer: "account",
        operation: "chat.reply",
        model: "gemini-flash",
        cost: 1_000_000,
      });

      // September (last month): one day rolled up, the last day not yet.
      await daily({
        day: "2026-09-10",
        account: free,
        payer: "account",
        operation: "chat.reply",
        model: "gemini-flash",
        cost: 800_000,
      });
      await daily({
        day: "2026-09-10",
        account: null,
        payer: "unattributed",
        operation: "",
        model: "shared",
        cost: 30_000,
      });
      await daily({
        day: "2026-08-31",
        account: free,
        payer: "account",
        operation: "chat.reply",
        model: "gemini-flash",
        cost: 9_999,
      });
      // Already in the rollup above, so not counted twice.
      await modelCall({
        at: "2026-09-10T09:00:00Z",
        account: free,
        operation: "chat.reply",
        model: "gemini-flash",
        provider: "vertex",
        cost: 800_000,
      });
      await modelCall({
        at: "2026-09-30T23:00:00Z",
        account: free,
        operation: "map.generate",
        model: "claude",
        provider: "anthropic",
        cost: 100_000,
      });
      await spend(free, "2026-09-01T00:00:00Z", 900_000);
    });

    const costs = async (offset: number) => {
      const res = await call("staff", "GET", `/api/v2/admin/ai-costs?month_offset=${offset}`);
      expect(res.status).toBe(200);
      return (await res.json()) as Costs;
    };

    test("this month: per account, feature, model, provider and unattributed", async () => {
      const view = await costs(0);
      expect(view.period_start).toBe("2026-10-01T00:00:00.000Z");
      expect(view.unattributed_micro_eur).toBe(70_000);
      expect(view.by_provider).toEqual([
        { provider: "vertex", cost_micro_eur: 3_710_000 },
        { provider: "anthropic", cost_micro_eur: 500_000 },
      ]);
      expect(view.accounts).toEqual([
        {
          billing_account_id: paid,
          name: "Paid Org",
          tier: "changemaker",
          cost_micro_eur: 2_000_000,
          budget_micro_eur: null,
          percent_used: null,
          unlimited: false,
          override_until: null,
          by_feature: [{ operation: "chat.reply", cost_micro_eur: 2_000_000 }],
          by_model: [{ model: "gemini-flash", cost_micro_eur: 2_000_000 }],
        },
        {
          billing_account_id: free,
          name: "Free Org",
          tier: "free",
          cost_micro_eur: 1_500_000,
          budget_micro_eur: 5_000_000,
          percent_used: 30,
          unlimited: false,
          override_until: null,
          by_feature: [
            { operation: "chat.reply", cost_micro_eur: 1_000_000 },
            { operation: "report.generate", cost_micro_eur: 500_000 },
          ],
          by_model: [
            { model: "gemini-flash", cost_micro_eur: 1_000_000 },
            { model: "claude", cost_micro_eur: 500_000 },
          ],
        },
        {
          // Cost adds both periods; the budget reads the free period only.
          billing_account_id: down,
          name: "Down Org",
          tier: "free",
          cost_micro_eur: 500_000,
          budget_micro_eur: 1_000_000,
          percent_used: 20,
          unlimited: false,
          override_until: "2026-12-01T00:00:00.000Z",
          by_feature: [{ operation: "chat.reply", cost_micro_eur: 500_000 }],
          by_model: [{ model: "gemini-flash", cost_micro_eur: 500_000 }],
        },
        {
          billing_account_id: open,
          name: "Open Org",
          tier: "free",
          cost_micro_eur: 100_000,
          budget_micro_eur: null,
          percent_used: null,
          unlimited: true,
          override_until: null,
          by_feature: [{ operation: "", cost_micro_eur: 100_000 }],
          by_model: [{ model: "gemini-flash", cost_micro_eur: 100_000 }],
        },
      ]);
      const trail = await audits("ai_costs.read");
      expect(trail.map((a) => [a.permission, a.staffUserId, a.detail])).toContainEqual([
        "staff:set_tier",
        STAFF.directusUserId,
        { month_offset: 0 },
      ]);
    });

    test("last month: rolled up days plus the days not yet rolled up", async () => {
      const view = await costs(1);
      expect(view.period_start).toBe("2026-09-01T00:00:00.000Z");
      expect(view.unattributed_micro_eur).toBe(30_000);
      // A rolled up model priced under two providers is reported as unknown.
      expect(view.by_provider).toEqual([
        { provider: "vertex", cost_micro_eur: 800_000 },
        { provider: "anthropic", cost_micro_eur: 100_000 },
        { provider: "unknown", cost_micro_eur: 30_000 },
      ]);
      expect(view.accounts).toEqual([
        {
          billing_account_id: free,
          name: "Free Org",
          tier: "free",
          cost_micro_eur: 900_000,
          budget_micro_eur: 5_000_000,
          percent_used: 18,
          unlimited: false,
          override_until: null,
          by_feature: [
            { operation: "chat.reply", cost_micro_eur: 800_000 },
            { operation: "map.generate", cost_micro_eur: 100_000 },
          ],
          by_model: [
            { model: "gemini-flash", cost_micro_eur: 800_000 },
            { model: "claude", cost_micro_eur: 100_000 },
          ],
        },
      ]);
      const trail = await audits("ai_costs.read");
      expect(trail.map((a) => a.detail)).toContainEqual({ month_offset: 1 });
    });

    test("only this month or last month", async () => {
      expect((await call("staff", "GET", "/api/v2/admin/ai-costs?month_offset=2")).status).toBe(
        422,
      );
      expect((await call("staff", "GET", "/api/v2/admin/ai-costs")).status).toBe(200);
    });
  });
});
