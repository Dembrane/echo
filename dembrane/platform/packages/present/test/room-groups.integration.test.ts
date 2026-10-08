import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import type { AnalysisRuntime, ObjectRevision, Snapshot } from "@dembrane/analysis";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { MapStore, runGroup } from "@dembrane/map";
import { createLogger } from "@dembrane/observability";
import { popcornProjectNudge, updateStream } from "@dembrane/popcorn";
import { Hub } from "@dembrane/realtime";
import { Hono } from "hono";
import { freshDatabase } from "../../popcorn/test/fixtures/tick/seed";
import { audienceGroups } from "../src/map";

// A group's title reaching the room: the map.group run that lands it wakes the room's own
// stream (the presentation's /events), and the room's reread then shows the title. Needs a
// scratch Postgres: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const USER = "d3000000-0000-4000-8000-000000000001";

run("a group landing on the room's map", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let hub: Hub;
  const project = newId();
  let reportId = "";
  const logger = createLogger(
    { service: "t", release: "r", env: "test", level: "error" },
    new Writable({ write: (_c, _e, cb) => cb() }),
  );

  const snapshot = {
    id: newId(),
    projectId: project,
    manifest: {
      objects: [1, 2, 3].map((i) => ({ revisionId: `r${i}` })),
      relations: [],
      assessments: [],
    },
  } as unknown as Snapshot;
  const revision = (i: number) =>
    ({
      id: `r${i}`,
      objectId: `o${i}`,
      projectId: project,
      type: "argument",
      payload: { statement: `Statement ${i}` },
      attributes: {},
    }) as unknown as ObjectRevision;
  const rt = {
    store: {
      getSnapshot: async (id: string) => (id === snapshot.id ? snapshot : null),
      getRevisions: async (_p: string, ids: readonly string[]) =>
        new Map(ids.map((id) => [id, revision(Number(id.slice(1)))])),
    },
    publishMap: async () => {},
  } as unknown as AnalysisRuntime;
  const completer = {
    complete: async () => ({
      text: "Ferry timetables",
      finishReason: "STOP",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      sources: [],
    }),
    modelIdentity: () => "fake/multi_modal_fast",
  } as unknown as Parameters<typeof runGroup>[0]["completer"];

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "present_room_groups_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    const sql = database.client;
    const org = newId();
    const billing = newId();
    const workspace = newId();
    await sql`insert into directus_users (id, email) values (${USER}, 'room@example.com')`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspace}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, context, workspace_id, is_conversation_allowed) values (${project}, 'Harbour', 'Ferry plans', ${workspace}, true)`;
    const [report] = await sql`insert into project_report
      (project_id, kind, status, user_instructions, content, public_token, user_created)
      values (${project}, 'popcorn', 'published', 'Harbour', '', ${newId()}, ${USER})
      returning id`;
    reportId = String(report?.id);
    hub = new Hub(sql, logger);
    await hub.start();
  });
  afterAll(async () => {
    await hub?.stop();
    await database?.close();
  });

  test("a finished map.group run sends the room an update, and its reread shows the title", async () => {
    const store = new MapStore(database.client);
    const [row] = await store.startGroup({
      projectId: project,
      snapshotId: snapshot.id,
      selectionKey: `room-${newId()}`,
      members: [1, 2, 3].map((i) => ({ revisionId: `r${i}`, objectId: `o${i}`, type: "argument" })),
      requestedBy: USER,
      staleSeconds: 900,
    });
    const groupId = String(row.id);
    const pending = audienceGroups(await store.listGroups(project), new Set());
    expect(pending).toMatchObject([{ id: groupId, status: "pending", title: null }]);

    // The room's own stream: the presentation's /events, on its popcorn session's channel.
    const app = new Hono().get("/events", (c) => updateStream(c, async () => hub, reportId));
    const reader = ((await app.request("/events")).body as ReadableStream<Uint8Array>).getReader();
    const text = new TextDecoder();
    expect(text.decode((await reader.read()).value)).toContain("event: connected");

    const outcome = await runGroup(
      { store, rt, completer, onGroupChanged: popcornProjectNudge(database.db, logger) },
      { groupId, attempt: Number(row.attempt) },
    );
    expect(outcome).toBe("ready");
    expect(text.decode((await reader.read()).value)).toBe(
      'event: update\ndata: {"type": "update"}\n\n',
    );
    await reader.cancel();

    // What the room reads on that update: the title, and still never who asked.
    const [landed] = audienceGroups(await store.listGroups(project), new Set());
    expect(landed).toMatchObject({ id: groupId, status: "ready", title: "Ferry timetables" });
    expect(landed).not.toHaveProperty("requested_by");
    expect(landed?.error).toBeNull();
  });
});
