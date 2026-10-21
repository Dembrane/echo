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
import { MemoryMailer } from "@dembrane/mail";
import type postgres from "postgres";
import {
  type Billing,
  billingStorage,
  freeAudioOutEmail,
  Notifier,
  noLiveRecordings,
  runFreeAudioOut,
} from "../src";
import { logger, logLines } from "./helpers";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `billing_free_audio_out_${process.pid}`;
const OCT = new Date("2026-10-25T10:00:00Z");
const NOV = new Date("2026-11-10T10:00:00Z");

run("the hours-run-out notice", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
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

  function deps(now: Date, customerJobs = true) {
    const store = billingStorage(db);
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
        overage: { db, live: noLiveRecordings, forwarder: null, environment: "test" },
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
  async function seed(tier = "free", downgradedAt: string | null = null) {
    const tag = randomUUID().slice(0, 8);
    const org = randomUUID();
    const acc = randomUUID();
    const ws = randomUUID();
    await sql`insert into org (id, name) values (${org}, ${`Acme ${tag}`})`;
    await sql`insert into billing_account (id, tier, org_id, downgraded_at)
      values (${acc}, ${tier}, ${org}, ${downgradedAt})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'Main', ${org}, ${acc})`;
    await user(org, "owner", `owner-${tag}@acme.test`);
    await user(org, "admin", `admin-${tag}@acme.test`);
    await user(org, "member", `member-${tag}@acme.test`);
    return { acc, ws, tag, name: `Acme ${tag}` };
  }

  async function used(acc: string, periodStart: string, amount: number, at: Date) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount, updated_at)
      values (${acc}, ${periodStart}, 'audio_seconds', ${amount}, ${at.toISOString()})`;
  }

  async function notices(acc: string) {
    return sql`select n.* from notification n
      join org_membership m on m.user_id = n.audience_user_id
      join billing_account b on b.org_id = m.org_id
      where b.id = ${acc} and n.event_code = 'FREE_AUDIO_OUT'`;
  }

  test("owners and admins of an exhausted free account hear once", async () => {
    const s = await seed();
    await used(s.acc, "2026-10-01T00:00:00Z", 18000, OCT);
    const first = deps(OCT);
    await runFreeAudioOut(first.d);
    const n = await notices(s.acc);
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({
      severity: "action_required",
      action: "NAVIGATE_WORKSPACE_SETTINGS",
      ref_workspace_id: s.ws,
      title: `${s.name}: this month's recording hours are used`,
    });
    expect(first.mailer.sent.map((m) => m.to).sort()).toEqual([
      `admin-${s.tag}@acme.test`,
      `owner-${s.tag}@acme.test`,
    ]);
    expect(first.mailer.sent[0]?.subject).toBe(`${s.name} has used this month's recording hours`);

    const again = deps(OCT);
    await runFreeAudioOut(again.d);
    expect(again.mailer.sent).toHaveLength(0);
    expect(await notices(s.acc)).toHaveLength(2);
  });

  test("a new period notifies again", async () => {
    const s = await seed();
    await used(s.acc, "2026-10-01T00:00:00Z", 18000, OCT);
    await runFreeAudioOut(deps(OCT).d);
    await used(s.acc, "2026-11-01T00:00:00Z", 18000, NOV);
    const nov = deps(NOV);
    await runFreeAudioOut(nov.d);
    expect(nov.mailer.sent).toHaveLength(2);
    expect(await notices(s.acc)).toHaveLength(4);
  });

  test("below the limit, paid, or an old period: nothing", async () => {
    const below = await seed();
    await used(below.acc, "2026-10-01T00:00:00Z", 17940, OCT);
    const paid = await seed("innovator");
    await used(paid.acc, "2026-10-01T00:00:00Z", 18000, OCT);
    const old = await seed();
    await used(old.acc, "2026-09-01T00:00:00Z", 18000, OCT);
    const x = deps(OCT);
    await runFreeAudioOut(x.d);
    expect(x.mailer.sent).toHaveLength(0);
    for (const s of [below, paid, old]) expect(await notices(s.acc)).toHaveLength(0);
  });

  test("a month left under a minute short is used up", async () => {
    // Refused uploads and rounding leave the ledger a few seconds below the limit.
    const s = await seed();
    await used(s.acc, "2026-10-01T00:00:00Z", 17941, OCT);
    const x = deps(OCT);
    await runFreeAudioOut(x.d);
    expect(x.mailer.sent).toHaveLength(2);
    expect(await notices(s.acc)).toHaveLength(2);
  });

  test("a downgraded account counts from its downgrade", async () => {
    const s = await seed("free", "2026-10-20T12:00:00Z");
    await used(s.acc, "2026-10-01T00:00:00Z", 18000, OCT);
    const before = deps(OCT);
    await runFreeAudioOut(before.d);
    expect(before.mailer.sent).toHaveLength(0);

    await used(s.acc, "2026-10-20T12:00:00Z", 18000, OCT);
    const after = deps(OCT);
    await runFreeAudioOut(after.d);
    expect(after.mailer.sent).toHaveLength(2);
    const markers = await sql`select period_start from free_usage
      where billing_account_id = ${s.acc} and key = 'notice:audio_out'`;
    expect(markers.map((r) => new Date(r.period_start).toISOString())).toEqual([
      "2026-10-20T12:00:00.000Z",
    ]);
  });

  test("customer jobs off: nothing is read or sent", async () => {
    const s = await seed();
    await used(s.acc, "2026-10-01T00:00:00Z", 18000, OCT);
    const off = deps(OCT, false);
    const store = off.d.billing.store;
    off.d.billing.store = new Proxy(store, {
      get(t, k) {
        if (k === "freeAudioCandidates") throw new Error("read while off");
        return Reflect.get(t, k);
      },
    });
    const before = logLines.length;
    await runFreeAudioOut(off.d);
    expect(off.mailer.sent).toHaveLength(0);
    expect(await notices(s.acc)).toHaveLength(0);
    expect(
      logLines
        .slice(before)
        .some(
          (l) => l.signal === "billing.customer_jobs_off" && l.job === "billing.free-audio-out",
        ),
    ).toBe(true);
    // Back on, the same account hears.
    const on = deps(OCT);
    await runFreeAudioOut(on.d);
    expect(on.mailer.sent).toHaveLength(2);
  });

  test("no admins keeps the marker; an admin added later hears once", async () => {
    const org = randomUUID();
    const acc = randomUUID();
    await sql`insert into org (id, name) values (${org}, 'Lonely')`;
    await sql`insert into billing_account (id, tier, org_id) values (${acc}, 'free', ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${randomUUID()}, 'Main', ${org}, ${acc})`;
    await user(org, "member", `member-${acc}@acme.test`);
    await used(acc, "2026-10-01T00:00:00Z", 18000, OCT);
    const first = deps(OCT);
    await runFreeAudioOut(first.d);
    expect(first.mailer.sent).toHaveLength(0);
    const markers = () => sql`select 1 from free_usage
      where billing_account_id = ${acc} and key = 'notice:audio_out'`;
    expect(await markers()).toHaveLength(0);

    await user(org, "admin", `admin-${acc}@acme.test`);
    const later = deps(OCT);
    await runFreeAudioOut(later.d);
    expect(later.mailer.sent.map((m) => m.to)).toEqual([`admin-${acc}@acme.test`]);
    const again = deps(OCT);
    await runFreeAudioOut(again.d);
    expect(again.mailer.sent).toHaveLength(0);
    expect(await markers()).toHaveLength(1);
  });

  test("the link prefers the account's own workspace over a pooled client", async () => {
    const org = randomUUID();
    const pool = randomUUID();
    const clientAcc = randomUUID();
    // The client sorts first by heap, id and creation time, so only the own-account preference picks internal.
    const client = `00000000${randomUUID().slice(8)}`;
    const internal = `ffffffff${randomUUID().slice(8)}`;
    await sql`insert into org (id, name) values (${org}, 'Pool')`;
    await sql`insert into billing_account (id, tier, org_id) values (${pool}, 'free', ${org})`;
    await sql`insert into billing_account (id, tier) values (${clientAcc}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id, created_at)
      values (${client}, 'Client', ${org}, ${clientAcc}, '2026-01-01T00:00:00Z')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id, created_at)
      values (${internal}, 'Internal', ${org}, ${pool}, '2026-06-01T00:00:00Z')`;
    await user(org, "owner", `owner-${pool}@acme.test`);
    await used(pool, "2026-10-01T00:00:00Z", 18000, OCT);
    const x = deps(OCT);
    await runFreeAudioOut(x.d);
    expect(x.mailer.sent).toHaveLength(1);
    expect(x.mailer.sent[0]?.text).toContain(`https://dash.test/w/${internal}/settings/billing`);
    const [n] = await sql`select ref_workspace_id from notification
      where event_code = 'FREE_AUDIO_OUT' and title like 'Pool:%'`;
    expect(n?.ref_workspace_id).toBe(internal);
  });

  test("the email has no em dash and names the reset date", async () => {
    const s = await seed();
    await used(s.acc, "2026-10-01T00:00:00Z", 18000, OCT);
    const x = deps(OCT);
    await runFreeAudioOut(x.d);
    const mail = x.mailer.sent[0];
    expect(mail?.text).toContain("1 November 2026");
    expect(mail?.text).toContain("5 hours");
    expect(mail?.text).toContain(`https://dash.test/w/${s.ws}/settings/billing`);
    for (const part of [mail?.subject, mail?.html, mail?.text]) expect(part).not.toContain("—");

    const direct = freeAudioOutEmail({
      name: "Acme",
      hours: "5 hours",
      resetDate: "1 November 2026",
      workspaceUrl: "https://dash.test/w/x/settings/billing",
    });
    expect(direct.subject).toBe("Acme has used this month's recording hours");
    expect(direct.text).toContain(
      "The free plan includes 5 hours of recording a month, and Acme has used them. New recordings and uploads are paused until 1 November 2026. Everything recorded so far stays available.",
    );
    expect(direct.html).toContain("Upgrade to keep recording");
    for (const part of [direct.subject, direct.html, direct.text]) expect(part).not.toContain("—");
  });
});
