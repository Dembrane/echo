import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { canvasStorage } from "../src/canvas/storage";

// A free popcorn read holds a 'running' run row; the canvas reads never show it.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `agentic_canvas_storage_${process.pid}`;

run("canvas run reads", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    sql = connect(url, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("latestLoopRun and historyRuns skip a running row", async () => {
    const loopId = newId();
    await sql`insert into agent_loop (id, name, status, expires_at, cadence_minutes, failure_count, created_at)
      values (${loopId}, 'P', 'active', now() + interval '1 hour', 5, 0, now())`;
    const done = newId();
    await sql`insert into agent_loop_run (id, loop_id, status, started_at)
      values (${done}, ${loopId}, 'ok', now() - interval '1 minute'),
             (${newId()}, ${loopId}, 'running', now())`;
    const store = canvasStorage(database.db);
    expect((await store.latestLoopRun(loopId))?.id).toBe(done);
    expect((await store.historyRuns(loopId, 10)).map((r) => r.id)).toEqual([done]);
  });
});
