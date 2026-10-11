import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import postgres from "postgres";
import { generationLog, recordSignal, trainableSignals } from "../src";

/**
 * The generation log, signals and the training export against a migrated database: only
 * signals on conversations whose client opted in and whose participant consented leave,
 * and erasing a conversation erases its signals.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "signals_test";
const quiet = createLogger({ level: "silent" } as never);

run("signals", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const optedIn = newId();
  const optedOut = newId();
  const consented = newId();
  const notConsented = newId();
  const elsewhere = newId();

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, is_conversation_allowed, ai_training) values
      (${optedIn}, true, 'opt-in'), (${optedOut}, true, null)`;
    await sql`insert into conversation (id, project_id, training_consent_at, training_consent_version) values
      (${consented}, ${optedIn}, now(), 'portal-1'),
      (${notConsented}, ${optedIn}, null, null),
      (${elsewhere}, ${optedOut}, now(), 'portal-1')`;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  test("a call is logged with its trace", async () => {
    generationLog(
      database.db,
      quiet,
    )({
      group: "multi_modal_pro",
      deployment: "multi_modal_pro[0]:gemini",
      trace: { step: "verify.generate", conversationId: consented, projectId: "not-a-uuid" },
      status: "ok",
      streamed: false,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 12.4,
    });
    await Bun.sleep(200);
    const rows = await database.db.select().from(schema.ai_generation);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step: "verify.generate",
      conversation_id: consented,
      project_id: null,
      latency_ms: 12,
    });
  });

  test("only consented signals with an opted-in client are exported", async () => {
    for (const conversationId of [consented, notConsented, elsewhere])
      await recordSignal(database.db, quiet, {
        step: "verify",
        kind: "edit",
        targetType: "conversation_artifact",
        targetId: newId(),
        conversationId,
        actorKind: "participant",
        payload: { before: "a", after: "b" },
      });
    const { rows, skipped } = await trainableSignals(database.db);
    expect(rows.map((r) => [r.conversation_id, r.consent_version, r.payload])).toEqual([
      [consented, "portal-1", { before: "a", after: "b" }],
    ]);
    expect(skipped).toEqual({ participant_not_consented: 1, client_not_opted_in: 1 });
  });

  test("a failed write is logged, not thrown", async () => {
    await recordSignal(database.db, quiet, {
      step: "verify",
      kind: "accept",
      targetType: "conversation_artifact",
      targetId: "x",
      conversationId: newId(),
      actorKind: "participant",
    });
  });

  test("deleting a conversation deletes its signals and generations", async () => {
    await sql`delete from conversation where id = ${consented}`;
    const [row] = await sql`select
      (select count(*) from ai_signal where conversation_id = ${consented}) +
      (select count(*) from ai_generation where conversation_id = ${consented}) as n`;
    expect(Number(row?.n)).toBe(0);
  });
});
