import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import postgres from "postgres";
import { classifyOperation, FEATURE_RULES, meteringRegistration, syncFeatureRules } from "../src";
import operations from "./fixtures/operations.json";

setDefaultTimeout(60_000);

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const base = admin?.slice(0, admin.lastIndexOf("/"));
const run = admin ? describe : describe.skip;
const NAME = "metering_feature_rules";
// Roles are cluster wide, so the role is this run's own and never the production name.
const ROLE = `grafana_obs_f${process.pid}`;

run("obs.ai_feature", () => {
  const sql = admin ? postgres(admin, { max: 1, onnotice: () => {} }) : (undefined as never);
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    await sql.unsafe(`drop database if exists ${NAME}`);
    await sql.unsafe(`create database ${NAME}`);
    await migrate(`${base}/${NAME}`, { appEnv: "test" });
    db = createDb({ url: `${base}/${NAME}`, poolMax: 2 });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    const cleanup = postgres(`${base}/${NAME}`, { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`drop owned by ${ROLE}; drop role ${ROLE}`).catch(() => undefined);
    await cleanup.end();
    await sql.end();
  });

  test("the table holds the backend list, in order, and a second sync changes nothing", async () => {
    expect(await syncFeatureRules(db.db)).toBe(FEATURE_RULES.length);
    await syncFeatureRules(db.db);
    const rows = await db.client.unsafe(
      "select pattern, feature_group, feature from ai_feature_rule order by position",
    );
    expect([...rows].map((r) => ({ ...r }) as object)).toEqual(
      FEATURE_RULES.map((r) => ({ pattern: r.pattern, feature_group: r.group, feature: r.label })),
    );
  });

  test("Postgres names every known operation exactly as the backend does", async () => {
    for (const op of [...operations, "", "something.new"]) {
      const [row] = await db.client.unsafe("select * from obs.ai_feature($1)", [op]);
      const js = classifyOperation(op);
      expect({ op, ...row } as object).toEqual({
        op,
        feature_group: js.group,
        group_label: js.group_label,
        feature: js.label,
      });
    }
  });

  test("workers starting together all sync and leave one copy of the list", async () => {
    const pools = Array.from({ length: 6 }, () => createDb({ url: `${base}/${NAME}`, poolMax: 1 }));
    try {
      const counts = await Promise.all(pools.map((p) => syncFeatureRules(p.db)));
      expect(counts).toEqual(pools.map(() => FEATURE_RULES.length));
      const [row] = await db.client.unsafe("select count(*)::int as n from ai_feature_rule");
      expect({ ...row }).toEqual({ n: FEATURE_RULES.length });
    } finally {
      await Promise.all(pools.map((p) => p.close()));
    }
  });

  test("register still registers both jobs when the sync fails", async () => {
    const errors: unknown[] = [];
    const worked: string[] = [];
    const broken = {
      transaction: async () => {
        throw new Error("db down");
      },
    };
    const reg = meteringRegistration({
      db: broken as never,
      logger: { info() {}, warn() {}, error: (o: unknown) => errors.push(o), debug() {} } as never,
      alerts: null,
      modelsDevUrl: "",
      ecbUrl: "",
    });
    const queue = {
      work: async (job: { name: string }) => void worked.push(job.name),
      schedule: async () => undefined,
    };
    await reg.register(queue as never);
    expect(errors).toHaveLength(1);
    expect(worked).toEqual(["metering.price-sync", "metering.spend-rollup"]);
  });

  test("the dashboard role can call the function and cannot read the table", async () => {
    const owner = postgres(`${base}/${NAME}`, { max: 1, onnotice: () => {} });
    await owner.unsafe(`create role ${ROLE} login password 'x'`);
    await owner.unsafe(`grant usage on schema obs to ${ROLE}`);
    await owner.end();
    const url = new URL(`${base}/${NAME}`);
    url.username = ROLE;
    url.password = "x";
    const viewer = postgres(url.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
    // A postgres.js query is a lazy thenable, so the refusal is awaited by hand.
    try {
      const [row] = await viewer.unsafe("select * from obs.ai_feature('conversations.chunk')");
      expect({ ...row }).toEqual({
        feature_group: "recording",
        group_label: "Recording",
        feature: "Transcription",
      });
      let message = "allowed";
      try {
        await viewer.unsafe("select * from public.ai_feature_rule");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/permission denied/);
    } finally {
      await viewer.end();
    }
  });

  test("with no rules yet, everything is Other under its raw operation", async () => {
    await db.client.unsafe("delete from ai_feature_rule");
    const [row] = await db.client.unsafe("select * from obs.ai_feature('conversations.chunk')");
    expect({ ...row }).toEqual({
      feature_group: "other",
      group_label: "Other",
      feature: "conversations.chunk",
    });
  });
});
