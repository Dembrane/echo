import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import postgres from "postgres";
import { searchStorage } from "../src/search/storage";
import { admin, freshDatabase } from "./pipeline-harness";

// Home search looks for a phrase only in chunks of projects the caller might reach, and
// the hits it returns there are the ones an unscoped scan finds.
const run = admin ? describe : describe.skip;

run("search transcript scope", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;

  const person = () => ({ appUserId: newId(), directusUserId: newId() });
  const [member, orgOwner, outsider, creator, former] = [
    person(),
    person(),
    person(),
    person(),
    person(),
  ];
  const [orgA, orgB] = [newId(), newId()];
  const [wsA, wsB, wsC] = [newId(), newId(), newId()];
  const [projA, projB, projC, projLegacy, projDeleted] = [
    newId(),
    newId(),
    newId(),
    newId(),
    newId(),
  ];
  const chunk: Record<string, string> = {};
  const chunkId = (key: string) => chunk[key] as string;

  async function addChunk(key: string, project: string, text: string, at: string) {
    const conv = newId();
    chunk[key] = newId();
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at)
      values (${conv}, ${project}, ${key}, now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, raw_transcript, timestamp)
      values (${chunk[key]}, ${conv}, ${text}, null, ${at})`;
  }

  beforeAll(async () => {
    const url = await freshDatabase("conv_search_scope_test");
    database = createDb({ url, poolMax: 2 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    for (const p of [member, orgOwner, outsider, creator, former]) {
      await sql`insert into directus_users (id) values (${p.directusUserId})`;
      await sql`insert into app_user (id, directus_user_id) values (${p.appUserId}, ${p.directusUserId})`;
    }
    for (const [org, ws] of [
      [orgA, wsA],
      [orgB, wsB],
      [orgA, wsC],
    ] as const) {
      const billing = newId();
      if (ws !== wsC) {
        await sql`insert into org (id, name) values (${org}, 'Org')`;
      }
      await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
      await sql`insert into workspace (id, name, org_id, billing_account_id, visibility)
        values (${ws}, 'W', ${org}, ${billing}, 'open_to_organisation')`;
    }
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values
      (${newId()}, ${wsA}, ${member.appUserId}, 'member')`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role, deleted_at) values
      (${newId()}, ${wsB}, ${former.appUserId}, 'member', now())`;
    await sql`insert into org_membership (id, org_id, user_id, role) values
      (${newId()}, ${orgA}, ${orgOwner.appUserId}, 'owner')`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values
      (${projA}, 'A', ${wsA}, true), (${projB}, 'B', ${wsB}, true), (${projC}, 'C', ${wsC}, true)`;
    await sql`insert into project (id, name, is_conversation_allowed, directus_user_id)
      values (${projLegacy}, 'Legacy', true, ${creator.directusUserId})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, deleted_at)
      values (${projDeleted}, 'Gone', ${wsA}, true, now())`;

    await addChunk("a", projA, "we talked about the harbour plan", "2026-10-01T10:00:00Z");
    await addChunk("a2", projA, "the Harbour plan again", "2026-10-02T10:00:00Z");
    await addChunk("b", projB, "harbour plan in the other org", "2026-10-03T10:00:00Z");
    await addChunk("c", projC, "harbour plan in a second workspace", "2026-10-04T10:00:00Z");
    await addChunk(
      "legacy",
      projLegacy,
      "a harbour plan from before workspaces",
      "2026-10-05T10:00:00Z",
    );
    await addChunk(
      "gone",
      projDeleted,
      "harbour plan in a deleted project",
      "2026-10-06T10:00:00Z",
    );
    await addChunk("other", projA, "nothing relevant here", "2026-10-07T10:00:00Z");
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  const hits = async (who: { appUserId: string; directusUserId: string }) =>
    (await searchStorage(database.db).chunks("harbour plan", 50, who)).map((r) => r.id);

  test("a workspace member finds the phrase only in their workspace", async () => {
    expect(await hits(member)).toEqual([chunkId("a2"), chunkId("a")]);
  });

  test("an org owner reaches every workspace of the org, not other orgs", async () => {
    expect(await hits(orgOwner)).toEqual([chunkId("c"), chunkId("a2"), chunkId("a")]);
  });

  test("a legacy project's creator finds its transcripts", async () => {
    expect(await hits(creator)).toEqual([chunkId("legacy")]);
  });

  test("someone with no project, or a removed membership, finds nothing", async () => {
    expect(await hits(outsider)).toEqual([]);
    expect(await hits(former)).toEqual([]);
  });

  test("the scan never returns a chunk the access rules refuse, and misses none they allow", async () => {
    const access = new Access(new DrizzleAccessStore(database.db));
    const everywhere = await sql<{ id: string; project_id: string }[]>`
      select ch.id, c.project_id from conversation_chunk ch
      join conversation c on c.id = ch.conversation_id
      where lower(ch.transcript) like '%harbour plan%'
      order by ch.timestamp desc, ch.id`;
    for (const who of [member, orgOwner, outsider, creator, former]) {
      const allowed: string[] = [];
      for (const row of everywhere) {
        const ok = await access.project(who, row.project_id, "project:read").then(
          () => true,
          () => false,
        );
        if (ok) allowed.push(row.id);
      }
      // The scoped scan is a superset of what access allows, in the same newest-first order.
      const found = await hits(who);
      expect(found.filter((id) => allowed.includes(id))).toEqual(allowed);
      expect(found.every((id) => everywhere.some((r) => r.id === id))).toBe(true);
    }
  });
});
