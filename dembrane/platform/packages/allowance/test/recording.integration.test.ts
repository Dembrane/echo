import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { NotFoundError } from "@dembrane/core";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { sql as dsql } from "drizzle-orm";
import type postgres from "postgres";
import { type AllowanceAccount, allowanceForWorkspace } from "../src/account";
import { claimOnce, usedThisPeriod, withAllowanceLock } from "../src/ledger";
import { recordingProject, setRecordingProject } from "../src/recording";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_recording_${process.pid}`;
const NOW = new Date("2026-10-25T00:00:00Z");

run("recording project", () => {
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
    const made = createDb({ url, poolMax: 12 });
    db = made.db;
    close = made.close;
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function account(tier: string, orgId: string | null) {
    const id = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${id}, ${tier}, ${orgId})`;
    return id;
  }

  async function workspace(orgId: string, accountId: string) {
    const id = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${id}, 'w', ${orgId}, ${accountId})`;
    return id;
  }

  async function project(
    workspaceId: string,
    opts: { sample?: boolean; deleted?: boolean; createdAt?: string } = {},
  ) {
    const id = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, is_sample, deleted_at, created_at)
      values (${id}, true, ${workspaceId}, ${opts.sample ?? false},
        ${opts.deleted ? NOW.toISOString() : null}, ${opts.createdAt ?? NOW.toISOString()})`;
    return id;
  }

  async function conversation(projectId: string, createdAt: string) {
    await sql`insert into conversation (id, project_id, created_at)
      values (${randomUUID()}, ${projectId}, ${createdAt})`;
  }

  async function stored(accountId: string) {
    const [r] = await sql`select recording_project_id from billing_account where id = ${accountId}`;
    return (r?.recording_project_id as string | null) ?? null;
  }

  async function seed() {
    const o = randomUUID();
    await sql`insert into org (id, name) values (${o}, 'o')`;
    const pool = await account("free", o);
    const internal = await workspace(o, pool);
    const freeClient = await workspace(o, await account("free", null));
    const a = await allowanceForWorkspace(db, internal, NOW);
    if (!a) throw new Error("expected a free account");
    return { a, internal, freeClient, pool, orgId: o };
  }

  async function caught(p: Promise<unknown>) {
    return p.then(
      () => null,
      (e) => e as Error,
    );
  }

  test("the migration adds both columns", async () => {
    await sql`select recording_project_id from billing_account limit 0`;
    await sql`select audio_seconds from conversation_chunk limit 0`;
  });

  test("no project: null and nothing stored", async () => {
    const s = await seed();
    expect(await recordingProject(db, s.a)).toBeNull();
    expect(await stored(s.pool)).toBeNull();
  });

  test("a brand new account's first project becomes it", async () => {
    const s = await seed();
    const p = await project(s.internal);
    expect(await recordingProject(db, s.a)).toBe(p);
    expect(await stored(s.a.accountId)).toBe(p);
    expect(s.a.accountId).toBe(s.pool);
  });

  test("the project with the most recent conversation wins", async () => {
    const s = await seed();
    const b = await project(s.internal, { createdAt: "2026-10-01T00:00:00Z" });
    const a = await project(s.internal, { createdAt: "2026-10-10T00:00:00Z" });
    await conversation(a, "2026-10-11T00:00:00Z");
    await conversation(b, "2026-10-12T00:00:00Z");
    expect(await recordingProject(db, s.a)).toBe(b);
  });

  test("no conversations: the most recently created project", async () => {
    const s = await seed();
    await project(s.internal, { createdAt: "2026-10-01T00:00:00Z" });
    const a = await project(s.internal, { createdAt: "2026-10-10T00:00:00Z" });
    expect(await recordingProject(db, s.a)).toBe(a);
  });

  test("a stored, valid choice is kept", async () => {
    const s = await seed();
    const b = await project(s.internal, { createdAt: "2026-10-01T00:00:00Z" });
    const a = await project(s.internal, { createdAt: "2026-10-10T00:00:00Z" });
    await setRecordingProject(db, s.a, b);
    await conversation(a, "2026-10-20T00:00:00Z");
    expect(await recordingProject(db, s.a)).toBe(b);
  });

  test("a deleted recording project is replaced", async () => {
    const s = await seed();
    const b = await project(s.internal, { createdAt: "2026-10-01T00:00:00Z" });
    const a = await project(s.internal, { createdAt: "2026-10-10T00:00:00Z" });
    await setRecordingProject(db, s.a, b);
    await sql`update project set deleted_at = now() where id = ${b}`;
    expect(await recordingProject(db, s.a)).toBe(a);
    expect(await stored(s.pool)).toBe(a);
  });

  test("sample, deleted and other-account projects are never chosen", async () => {
    const s = await seed();
    const sample = await project(s.internal, { sample: true, createdAt: "2026-10-20T00:00:00Z" });
    const gone = await project(s.internal, { deleted: true, createdAt: "2026-10-21T00:00:00Z" });
    const other = await seed();
    const foreign = await project(other.internal, { createdAt: "2026-10-22T00:00:00Z" });
    await conversation(sample, "2026-10-23T00:00:00Z");
    await conversation(gone, "2026-10-23T00:00:00Z");
    await conversation(foreign, "2026-10-23T00:00:00Z");
    expect(await recordingProject(db, s.a)).toBeNull();
    const live = await project(s.internal, { createdAt: "2026-10-01T00:00:00Z" });
    expect(await recordingProject(db, s.a)).toBe(live);
  });

  test("a pooled client workspace's project is eligible", async () => {
    const s = await seed();
    const p = await project(s.freeClient);
    expect(await recordingProject(db, s.a)).toBe(p);
  });

  test("concurrent first calls store one choice", async () => {
    const s = await seed();
    await project(s.internal);
    await project(s.freeClient);
    const ids = await Promise.all(Array.from({ length: 10 }, () => recordingProject(db, s.a)));
    expect(new Set(ids).size).toBe(1);
    expect(await stored(s.pool)).toBe(ids[0] as string);
  });

  test("the auto-choice waits for the lock and keeps a choice stored meanwhile", async () => {
    const s = await seed();
    const picked = await project(s.internal, { createdAt: "2026-10-01T00:00:00Z" });
    await project(s.internal, { createdAt: "2026-10-10T00:00:00Z" });
    let auto: Promise<string | null> | undefined;
    await withAllowanceLock(db, s.a, async (tx) => {
      await tx.execute(
        dsql`update billing_account set recording_project_id = ${picked} where id = ${s.pool}`,
      );
      auto = recordingProject(db, s.a);
      // Wait until the auto-choice is blocked on a lock we hold.
      for (let i = 0; i < 200; i++) {
        const [w] = await sql`select count(*)::int as n from pg_locks l
          join pg_stat_activity x on x.pid = l.pid
          where not l.granted and x.datname = current_database()`;
        if (w?.n) break;
        await Bun.sleep(10);
      }
    });
    expect(await auto).toBe(picked);
    expect(await stored(s.pool)).toBe(picked);
  });

  test("setRecordingProject refuses a sample or a foreign project", async () => {
    const s = await seed();
    const sample = await project(s.internal, { sample: true });
    const other = await seed();
    const foreign = await project(other.internal);
    const e1 = await caught(setRecordingProject(db, s.a, sample));
    const e2 = await caught(setRecordingProject(db, s.a, foreign));
    const e3 = await caught(setRecordingProject(db, s.a, "not-a-uuid"));
    for (const e of [e1, e2, e3]) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as NotFoundError).code).toBe("project.not_found");
    }
    const live = await project(s.freeClient);
    expect(await caught(setRecordingProject(db, s.a, live))).toBeNull();
    expect(await stored(s.pool)).toBe(live);
  });

  test("claimOnce is once per period", async () => {
    const s = await seed();
    expect(await claimOnce(db, s.a, "notice:audio_out")).toBe(true);
    expect(await claimOnce(db, s.a, "notice:audio_out")).toBe(false);
    const next: AllowanceAccount = { ...s.a, periodStart: new Date("2026-11-01T00:00:00Z") };
    expect(await claimOnce(db, next, "notice:audio_out")).toBe(true);
    const used = await usedThisPeriod(db, s.a);
    expect(Object.keys(used).sort()).toEqual(
      ["audio_seconds", "chats", "maps", "popcorn_analyses", "reports"].sort(),
    );
    expect(Object.values(used).every((v) => v === 0)).toBe(true);
  });
});
