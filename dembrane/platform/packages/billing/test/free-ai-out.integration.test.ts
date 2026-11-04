import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { countingDb } from "@dembrane/db/testing";
import { MemoryMailer } from "@dembrane/mail";
import type postgres from "postgres";
import {
  type Billing,
  billingStorage,
  freeAiOutEmail,
  Notifier,
  noLiveRecordings,
  runFreeAiOut,
} from "../src";
import { logger, logLines } from "./helpers";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `billing_free_ai_out_${process.pid}`;
const OCT = new Date("2026-10-25T10:00:00Z");
const NOV = new Date("2026-11-10T10:00:00Z");
const BUDGET = 5_000_000;

run("the AI budget used-up notice", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 3 });
    db = made.db;
    close = made.close;
  });

  beforeEach(() => invalidateFreeLimits());

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  function deps(now: Date, customerJobs = true, on: Db = db) {
    const store = billingStorage(on);
    const mailer = new MemoryMailer();
    const billing = {
      service: {} as never,
      store,
      notifier: new Notifier(store, logger),
      mollie: {} as never,
    } satisfies Billing;
    return {
      mailer,
      d: {
        billing,
        mailer,
        logger,
        customerJobs,
        dashboardUrl: "https://dash.test",
        overage: { db: on, live: noLiveRecordings, forwarder: null, environment: "test" },
        clock: () => now,
      },
    };
  }

  async function user(orgId: string, role: string, email: string) {
    const id = randomUUID();
    await sql`insert into app_user (id, email) values (${id}, ${email})`;
    await sql`insert into org_membership (id, org_id, user_id, role) values (${randomUUID()}, ${orgId}, ${id}, ${role})`;
    return id;
  }

  // An org on an org-scoped account with one workspace, an owner, an admin and a member.
  async function seed(tier = "free") {
    const tag = randomUUID().slice(0, 8);
    const org = randomUUID();
    const acc = randomUUID();
    const ws = randomUUID();
    await sql`insert into org (id, name) values (${org}, ${`Acme ${tag}`})`;
    await sql`insert into billing_account (id, tier, org_id) values (${acc}, ${tier}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'Main', ${org}, ${acc})`;
    await user(org, "owner", `owner-${tag}@acme.test`);
    await user(org, "admin", `admin-${tag}@acme.test`);
    await user(org, "member", `member-${tag}@acme.test`);
    return { acc, ws, tag, name: `Acme ${tag}` };
  }

  async function spent(acc: string, periodStart: string, amount: number, at: Date) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount, updated_at)
      values (${acc}, ${periodStart}, 'ai_spend_micro_eur', ${amount}, ${at.toISOString()})`;
  }

  // Tests share one database, so mail is checked per seeded account.
  const mailsOf = (mailer: MemoryMailer, tag: string) =>
    mailer.sent.filter((m) => m.to.includes(`-${tag}@`));

  async function notices(acc: string) {
    return sql`select n.* from notification n
      join org_membership m on m.user_id = n.audience_user_id
      join billing_account b on b.org_id = m.org_id
      where b.id = ${acc} and n.event_code = 'FREE_AI_OUT'`;
  }

  test("owners and admins of an exhausted free account hear once a period", async () => {
    const s = await seed();
    await spent(s.acc, "2026-10-01T00:00:00Z", BUDGET, OCT);
    const first = deps(OCT);
    await runFreeAiOut(first.d);
    const n = await notices(s.acc);
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({
      severity: "action_required",
      action: "NAVIGATE_WORKSPACE_SETTINGS",
      ref_workspace_id: s.ws,
      title: `${s.name}: this month's AI budget is used`,
      message: "AI features and new recordings are paused until 1 November 2026.",
    });
    expect(first.mailer.sent.map((m) => m.to).sort()).toEqual([
      `admin-${s.tag}@acme.test`,
      `owner-${s.tag}@acme.test`,
    ]);
    expect(first.mailer.sent[0]?.subject).toBe(`${s.name} has used this month's AI budget`);
    expect(first.mailer.sent[0]?.tags).toEqual(["free_ai_out"]);

    const again = deps(OCT);
    await runFreeAiOut(again.d);
    expect(again.mailer.sent).toHaveLength(0);
    expect(await notices(s.acc)).toHaveLength(2);
    const markers = await sql`select period_start from free_usage
      where billing_account_id = ${s.acc} and key = 'notice:ai_out'`;
    expect(markers.map((r) => new Date(r.period_start).toISOString())).toEqual([
      "2026-10-01T00:00:00.000Z",
    ]);
  });

  test("a new period notifies again", async () => {
    const s = await seed();
    await spent(s.acc, "2026-10-01T00:00:00Z", BUDGET, OCT);
    await runFreeAiOut(deps(OCT).d);
    await spent(s.acc, "2026-11-01T00:00:00Z", BUDGET + 20_000, NOV);
    const nov = deps(NOV);
    await runFreeAiOut(nov.d);
    expect(nov.mailer.sent).toHaveLength(2);
    expect(nov.mailer.sent[0]?.text).toContain("1 December 2026");
    expect(await notices(s.acc)).toHaveLength(4);
  });

  test("at 4,000,000, paid, or an old period: nothing", async () => {
    const below = await seed();
    await spent(below.acc, "2026-10-01T00:00:00Z", 4_000_000, OCT);
    const paid = await seed("innovator");
    await spent(paid.acc, "2026-10-01T00:00:00Z", BUDGET, OCT);
    const old = await seed();
    await spent(old.acc, "2026-09-01T00:00:00Z", BUDGET, OCT);
    const x = deps(OCT);
    await runFreeAiOut(x.d);
    expect(x.mailer.sent).toHaveLength(0);
    for (const s of [below, paid, old]) expect(await notices(s.acc)).toHaveLength(0);
  });

  // An earlier month, so the runs in other tests never see these rows.
  const AUG = new Date("2026-08-20T10:00:00Z");
  const candidates = async (now = AUG) =>
    (
      await billingStorage(db).freeAiCandidates(new Date(now.getTime() - 60_000), {
        now,
        defaultLimit: BUDGET,
      })
    ).map((c) => c.accountId);

  test("only live free accounts are candidates; paid and deleted spend rows are not read", async () => {
    const free = await seed();
    const paid = await seed("innovator");
    const gone = await seed();
    await sql`update billing_account set deleted_at = now() where id = ${gone.acc}`;
    for (const s of [free, paid, gone]) await spent(s.acc, "2026-08-01T00:00:00Z", BUDGET, AUG);
    const ids = await candidates();
    expect(ids).toContain(free.acc);
    expect(ids).not.toContain(paid.acc);
    expect(ids).not.toContain(gone.acc);
  });

  test("only accounts at their limit are candidates, by the same rule as the budget", async () => {
    const below = await seed();
    const at = await seed();
    const lower = await seed();
    const lowerExpired = await seed();
    const unlimited = await seed();
    const unlimitedExpired = await seed();
    const past = "2026-08-01T00:00:00Z";
    await sql`update billing_account set ai_budget_micro_eur = 1000000 where id in (${lower.acc}, ${lowerExpired.acc})`;
    await sql`update billing_account set ai_budget_unlimited = true where id in (${unlimited.acc}, ${unlimitedExpired.acc})`;
    await sql`update billing_account set ai_budget_until = ${past} where id in (${lowerExpired.acc}, ${unlimitedExpired.acc})`;
    await spent(below.acc, past, BUDGET - 1, AUG);
    await spent(at.acc, past, BUDGET, AUG);
    for (const s of [lower, lowerExpired]) await spent(s.acc, past, 1_000_000, AUG);
    for (const s of [unlimited, unlimitedExpired]) await spent(s.acc, past, BUDGET, AUG);
    const higher = await seed();
    await sql`update billing_account set ai_budget_micro_eur = 10000000 where id = ${higher.acc}`;
    await spent(higher.acc, past, BUDGET, AUG);
    const ids = await candidates();
    for (const s of [at, lower, unlimitedExpired]) expect(ids).toContain(s.acc);
    for (const s of [below, lowerExpired, unlimited, higher]) expect(ids).not.toContain(s.acc);
  });

  test("a no-limit override hears nothing; a lower override is used up at its own amount", async () => {
    const unlimited = await seed();
    await sql`update billing_account set ai_budget_unlimited = true where id = ${unlimited.acc}`;
    await spent(unlimited.acc, "2026-10-01T00:00:00Z", 50_000_000, OCT);
    const lower = await seed();
    await sql`update billing_account set ai_budget_micro_eur = 1000000 where id = ${lower.acc}`;
    await spent(lower.acc, "2026-10-01T00:00:00Z", 1_000_000, OCT);
    const x = deps(OCT);
    await runFreeAiOut(x.d);
    expect(await notices(unlimited.acc)).toHaveLength(0);
    expect(await notices(lower.acc)).toHaveLength(2);
    expect(x.mailer.sent.map((m) => m.to).sort()).toEqual([
      `admin-${lower.tag}@acme.test`,
      `owner-${lower.tag}@acme.test`,
    ]);
  });

  test("with the check switched off nobody hears", async () => {
    const s = await seed();
    await spent(s.acc, "2026-10-01T00:00:00Z", BUDGET, OCT);
    await sql`update tier_limit set value = 0 where tier = 'free' and key = 'ai_budget_enforce'`;
    invalidateFreeLimits();
    try {
      const x = deps(OCT);
      await runFreeAiOut(x.d);
      expect(x.mailer.sent).toHaveLength(0);
      expect(await notices(s.acc)).toHaveLength(0);
    } finally {
      await sql`update tier_limit set value = 1 where tier = 'free' and key = 'ai_budget_enforce'`;
      await sql`delete from free_usage where billing_account_id = ${s.acc}`;
      invalidateFreeLimits();
    }
  });

  test("customer jobs off: nothing is read or sent", async () => {
    const s = await seed();
    await spent(s.acc, "2026-10-01T00:00:00Z", BUDGET, OCT);
    const off = deps(OCT, false);
    const store = off.d.billing.store;
    off.d.billing.store = new Proxy(store, {
      get(t, k) {
        if (k === "freeAiCandidates") throw new Error("read while off");
        return Reflect.get(t, k);
      },
    });
    const before = logLines.length;
    await runFreeAiOut(off.d);
    expect(off.mailer.sent).toHaveLength(0);
    expect(await notices(s.acc)).toHaveLength(0);
    expect(
      logLines
        .slice(before)
        .some((l) => l.signal === "billing.customer_jobs_off" && l.job === "billing.free-ai-out"),
    ).toBe(true);
    // Back on, the same account hears.
    const on = deps(OCT);
    await runFreeAiOut(on.d);
    expect(mailsOf(on.mailer, s.tag)).toHaveLength(2);
  });

  test("the email has no em dash, no euro amount, and names the reset date", async () => {
    const s = await seed();
    await spent(s.acc, "2026-10-01T00:00:00Z", BUDGET, OCT);
    const x = deps(OCT);
    await runFreeAiOut(x.d);
    const mail = mailsOf(x.mailer, s.tag)[0];
    expect(mail?.text).toContain("1 November 2026");
    expect(mail?.text).toContain(`https://dash.test/w/${s.ws}/settings/billing`);
    for (const part of [mail?.subject, mail?.html, mail?.text]) {
      expect(part).not.toContain("—");
      expect(part).not.toContain("€");
    }

    const direct = freeAiOutEmail({
      name: "Acme",
      resetDate: "1 November 2026",
      workspaceUrl: "https://dash.test/w/x/settings/billing",
    });
    expect(direct.subject).toBe("Acme has used this month's AI budget");
    expect(direct.text).toContain(
      "The free plan includes a monthly AI budget, and Acme has used it. AI features and new recordings are paused until 1 November 2026, when the budget resets. Everything made so far stays available.",
    );
    expect(direct.html).toContain("Upgrade to keep using AI");
    for (const part of [direct.subject, direct.html, direct.text]) {
      expect(part).not.toContain("—");
      expect(part).not.toContain("€");
    }
  });

  test("accounts below their limit cost no per-account reads", async () => {
    // A later month, so earlier tests' rows fall outside the window; deleted after, as `since` has no upper bound.
    const now = new Date("2027-03-15T10:00:00Z");
    const below = [];
    for (let i = 0; i < 5; i++) {
      const s = await seed();
      await spent(s.acc, "2027-03-01T00:00:00Z", 1_000_000, now);
      below.push(s);
    }
    const out = await seed();
    await spent(out.acc, "2027-03-01T00:00:00Z", BUDGET, now);
    const c = countingDb(url);
    try {
      const x = deps(now, true, c.db);
      await runFreeAiOut(x.d);
      expect(mailsOf(x.mailer, out.tag)).toHaveLength(2);
      const ids = new Set<string>(below.map((s) => s.acc));
      const perAccount = c.log.filter((l) => l.params.some((p) => ids.has(String(p))));
      // Before, each below-limit account cost three reads (account, override, usage).
      expect(perAccount).toHaveLength(0);
    } finally {
      await c.close();
      await sql`delete from free_usage where period_start = '2027-03-01T00:00:00Z'`;
    }
  });
});
