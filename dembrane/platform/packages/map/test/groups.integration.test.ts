import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type AnalysisRuntime,
  clientOf,
  type Json,
  type ObjectRevision,
  type Snapshot,
} from "@dembrane/analysis";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import { runGroup } from "../src/groups";
import * as service from "../src/service";
import { MapStore } from "../src/store";

/**
 * Groups against a migrated database: a committed selection is stored once and queued, the
 * run titles it for its attempt only, a failed one runs again as a new attempt, and what
 * could never be titled is refused before anything is stored. The snapshot and revisions
 * the analysis store would hold are stubbed.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "map_groups_test";

const project = newId();
const snapshot = {
  id: newId(),
  projectId: project,
  manifest: {
    objects: [1, 2, 3, 4].map((i) => ({ revisionId: `r${i}` })),
    relations: [{ from: "r1", to: "r2", type: "derived_from" }],
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

run("map groups", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let store: MapStore;
  const published: Json[] = [];
  const dispatched: service.GroupJob[] = [];
  const rt = {
    store: {
      getSnapshot: async (id: string) => (id === snapshot.id ? snapshot : null),
      getRevisions: async (_p: string, ids: readonly string[]) =>
        new Map(
          ids.filter((id) => /^r[1-4]$/.test(id)).map((id) => [id, revision(Number(id.slice(1)))]),
        ),
    },
    publishMap: async (_p: string, event: Json) => {
      published.push(event);
    },
  } as unknown as AnalysisRuntime;
  const target: service.SnapshotTarget = { kind: "snapshot", snapshot, resultId: null };

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    const sql = clientOf(database.db);
    const org = newId();
    const billing = newId();
    const workspace = newId();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspace}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, context, workspace_id, is_conversation_allowed) values (${project}, 'Harbour', 'Ferry plans', ${workspace}, true)`;
    store = new MapStore(sql);
  });
  afterAll(async () => {
    await database.close();
  });

  test("a dwell becomes one titled group; a failure runs again as a new attempt", async () => {
    const d: service.GroupDeps = {
      store,
      rt,
      dispatchGroup: async (job) => dispatched.push(job),
    };
    const first = await service.requestGroup(d, target, ["r3", "r1", "r2"], "host");
    expect(first).toMatchObject({ status: "pending", title: null, snapshotId: snapshot.id });
    expect(first.members).toEqual([
      { revisionId: "r3", objectId: "o3", type: "argument" },
      { revisionId: "r1", objectId: "o1", type: "argument" },
      { revisionId: "r2", objectId: "o2", type: "argument" },
    ]);
    expect(dispatched).toEqual([{ groupId: String(first.id), attempt: 1 }]);

    // The same selection, in any order, is the same group and queues nothing more.
    const again = await service.requestGroup(d, target, ["r1", "r2", "r3"], "host");
    expect(again.id).toBe(first.id);
    expect(dispatched).toHaveLength(1);

    // The model fails: the group is failed for this attempt, and the page is told.
    const broken = new FakeCompleter();
    expect(
      await runGroup({ store, rt, completer: broken }, dispatched[0] as service.GroupJob),
    ).toBe("failed");
    expect((await store.getGroup(String(first.id)))?.status).toBe("failed");
    expect(published.at(-1)).toEqual({ type: "group", group_id: first.id });

    // Committing it again starts attempt 2; attempt 1 arriving late changes nothing.
    await service.requestGroup(d, target, ["r3", "r1", "r2"], "host");
    expect(dispatched[1] as service.GroupJob).toEqual({ groupId: String(first.id), attempt: 2 });
    const completer = new FakeCompleter().on("Arguments in cluster", "  Ferry timetables  ");
    expect(await runGroup({ store, rt, completer }, dispatched[0] as service.GroupJob)).toBe(
      "stale",
    );
    expect(await runGroup({ store, rt, completer }, dispatched[1] as service.GroupJob)).toBe(
      "ready",
    );
    const user = String(completer.calls[0]?.user);
    expect(user).toContain("1. [argument] Statement 3");
    expect(user).toContain("2. [argument, is derived from 3] Statement 1");
    expect(user).toContain("Ferry plans");

    const [listed, ...rest] = (await store.listGroups(project)).map(service.groupDoc);
    expect(rest).toHaveLength(0);
    expect(listed).toMatchObject({ id: first.id, status: "ready", title: "Ferry timetables" });
    // Done is done: a run delivered twice writes nothing.
    expect(await runGroup({ store, rt, completer }, dispatched[1] as service.GroupJob)).toBe(
      "stale",
    );
  });

  test("what could never be titled is refused before anything is stored", async () => {
    const d: service.GroupDeps = { store, rt, dispatchGroup: async () => undefined };
    const before = (await store.listGroups(project)).length;
    await expect(service.requestGroup(d, target, ["r1", "r2"], "host")).rejects.toThrow(
      "a title needs at least 3 objects",
    );
    await expect(service.requestGroup(d, target, ["r1", "r2", "r9"], "host")).rejects.toThrow(
      service.UnknownArguments,
    );
    expect(await store.listGroups(project)).toHaveLength(before);
  });
});
