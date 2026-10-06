import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "@dembrane/db";
import postgres from "postgres";
import { popcornStore } from "../src/storage";
import { freshDatabase, ids } from "./fixtures/tick/seed";

// The waiting count against Postgres.
// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const conv = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;

run("the conversations the room waits on", () => {
  let raw: postgres.Sql;

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_waiting_test");
    await migrate(url, { appEnv: "test" });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await raw`insert into directus_users (id, email) values (${ids.user}, 'popcorn@example.com')`;
    await raw`insert into project (id, name, language, directus_user_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${ids.project}, 'Waiting', 'en', ${ids.user}, true, true, false, 'workspace')`;
    const rows: [number, boolean | null, boolean][] = [
      [1, false, false], // recording, nothing said yet
      [2, false, true], // recording, with words
      [3, true, true], // finished, with words to read
      [4, true, false], // finished with nothing to read
      [5, null, true], // neither
      [6, false, true], // deleted
    ];
    for (const [n, finished] of rows)
      await raw`insert into conversation (id, project_id, created_at, is_finished, deleted_at)
        values (${conv(n)}, ${ids.project}, now(), ${finished}, ${n === 6 ? raw`now()` : null})`;
    for (const [n, , words] of rows)
      if (words)
        await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
          values (${`d0000000-0000-4000-8000-00000000000${n}`}, ${conv(n)}, 'Hello there', now(), now())`;
    await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values ('d0000000-0000-4000-8000-000000000009', ${conv(4)}, '  ', now(), now())`;
  });
  afterAll(async () => {
    await raw?.end();
  });

  test("counts the unfinished as recording and lists the finished with words", async () => {
    expect(await popcornStore(raw).waitingConversations(ids.project)).toEqual({
      recording: 2,
      finished: [conv(3)],
    });
  });
});
