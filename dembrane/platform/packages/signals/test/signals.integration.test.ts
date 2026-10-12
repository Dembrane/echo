import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import postgres from "postgres";
import { recordSignal, trainableSignals } from "../src";

/**
 * Signals and the training export against a migrated database: only
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

  test("deleting a conversation deletes its signals", async () => {
    await sql`delete from conversation where id = ${consented}`;
    const [row] =
      await sql`select count(*) as n from ai_signal where conversation_id = ${consented}`;
    expect(Number(row?.n)).toBe(0);
  });
});
