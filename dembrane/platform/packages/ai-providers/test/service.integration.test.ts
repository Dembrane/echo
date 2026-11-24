import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { routingPolicyOf } from "@dembrane/llm";
import type postgres from "postgres";
import {
  type AiProvidersDeps,
  readOrg,
  readOrgForStaff,
  readProject,
  setOrg,
  setProject,
} from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `ai_providers_${process.pid}`;
const policy = routingPolicyOf({
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
});

run("AI providers: the account's setting and the project's choice", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let d: AiProvidersDeps;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 2 });
    db = made.db;
    close = made.close;
    d = {
      db,
      access: new Access(new DrizzleAccessStore(db)),
      policy,
      now: () => new Date("2026-12-03T10:00:00Z"),
    };
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function person() {
    const id = randomUUID();
    await sql`insert into app_user (id) values (${id})`;
    return { appUserId: id, directusUserId: randomUUID() };
  }

  async function world() {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'Acme')`;
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    const projectId = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id) values (${projectId}, true, ${workspaceId})`;
    const owner = await person();
    const orgAdmin = await person();
    const billing = await person();
    const member = await person();
    const outsider = await person();
    await sql`insert into org_membership (id, org_id, user_id, role) values (${randomUUID()}, ${orgId}, ${owner.appUserId}, 'owner')`;
    await sql`insert into org_membership (id, org_id, user_id, role) values (${randomUUID()}, ${orgId}, ${orgAdmin.appUserId}, 'admin')`;
    await sql`insert into org_membership (id, org_id, user_id, role) values (${randomUUID()}, ${orgId}, ${billing.appUserId}, 'billing')`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${randomUUID()}, ${workspaceId}, ${member.appUserId}, 'member')`;
    const ticket = randomUUID();
    await sql`insert into account_ticket (id, org_id, subject, created_at) values (${ticket}, ${orgId}, 'Google Vertex AI', '2026-12-02T09:00:00Z')`;
    return { orgId, workspaceId, projectId, owner, orgAdmin, billing, member, outsider, ticket };
  }

  const events = (orgId: string) =>
    sql<{ actor_kind: string; type: string; detail: Record<string, unknown> }[]>`
      select actor_kind, type, detail from account_event where org_id = ${orgId} order by created_at, id`;

  test("an account nobody set offers only the deployment's default, to owners and admins only", async () => {
    const w = await world();
    expect(await readOrg(d, w.owner, w.orgId)).toMatchObject({
      available: ["scaleway", "google"],
      allowed: ["scaleway"],
      default: "scaleway",
      history: [],
    });
    expect((await readOrg(d, w.orgAdmin, w.orgId)).allowed).toEqual(["scaleway"]);
    await expect(readOrg(d, w.billing, w.orgId)).rejects.toMatchObject({
      code: "organisation.admin_only",
    });
    await expect(readOrg(d, w.member, w.orgId)).rejects.toMatchObject({ status: 404 });
    await expect(readOrg(d, w.outsider, w.orgId)).rejects.toMatchObject({ status: 404 });
  });

  test("staff add Google at a customer's written request: the change, the event and the history line", async () => {
    const w = await world();
    const staff = randomUUID();
    await setOrg(d, staff, w.orgId, {
      allowed: ["scaleway", "google"],
      default: "scaleway",
      requestTicketId: w.ticket,
    });
    expect(await readOrg(d, w.owner, w.orgId)).toMatchObject({
      allowed: ["scaleway", "google"],
      default: "scaleway",
      history: [
        {
          kind: "added",
          provider: "google",
          request_at: "2026-12-02T09:00:00.000Z",
          at: "2026-12-03T10:00:00.000Z",
        },
      ],
    });
    const [e] = await events(w.orgId);
    expect(e).toMatchObject({
      actor_kind: "staff",
      type: "ai_providers.changed",
      detail: {
        before: { allowed: ["scaleway"], default: "scaleway" },
        after: { allowed: ["scaleway", "google"], default: "scaleway" },
        request_ticket_id: w.ticket,
      },
    });
    const forStaff = await readOrgForStaff(d, w.orgId);
    expect(forStaff.tickets.map((t) => t.id)).toEqual([w.ticket]);
  });

  test("staff cannot grant what the deployment lacks, name no request, or cite another account's ticket", async () => {
    const w = await world();
    const other = await world();
    const staff = randomUUID();
    const only = { ...d, policy: routingPolicyOf({ provider: "openai-compatible" }) };
    await expect(
      setOrg(only, staff, w.orgId, {
        allowed: ["scaleway", "google"],
        default: "scaleway",
        requestTicketId: w.ticket,
      }),
    ).rejects.toThrow(/no provider google/);
    await expect(
      setOrg(d, staff, w.orgId, {
        allowed: ["google"],
        default: "scaleway",
        requestTicketId: w.ticket,
      }),
    ).rejects.toThrow(/default must be one of/);
    await expect(
      setOrg(d, staff, w.orgId, {
        allowed: ["scaleway"],
        default: "scaleway",
        requestTicketId: "",
      }),
    ).rejects.toThrow(/request ticket/);
    await expect(
      setOrg(d, staff, w.orgId, {
        allowed: ["scaleway"],
        default: "scaleway",
        requestTicketId: other.ticket,
      }),
    ).rejects.toThrow(/not one of this account/);
    await expect(
      setOrg(d, staff, w.orgId, { allowed: ["orai"], default: "orai", requestTicketId: w.ticket }),
    ).rejects.toThrow(/Not an AI provider/);
    expect((await events(w.orgId)).length).toBe(0);
  });

  test("a project admin chooses among what the account allows; a member sees the field but cannot change it", async () => {
    const w = await world();
    // One provider: the field has one option and the choice is refused.
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      options: ["scaleway"],
      effective: "scaleway",
      can_change: true,
    });
    await expect(setProject(d, w.owner, w.projectId, "google")).rejects.toThrow(
      /does not allow google/,
    );
    await setOrg(d, randomUUID(), w.orgId, {
      allowed: ["scaleway", "google"],
      default: "scaleway",
      requestTicketId: w.ticket,
    });
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      options: ["scaleway", "google"],
      account_default: "scaleway",
      current: null,
    });
    expect(await readProject(d, w.member, w.projectId)).toMatchObject({ can_change: false });
    await expect(setProject(d, w.member, w.projectId, "google")).rejects.toMatchObject({
      status: 403,
    });
    expect(await setProject(d, w.owner, w.projectId, "google")).toMatchObject({
      current: "google",
      effective: "google",
    });
    expect(
      (await sql`select ai_provider from project where id = ${w.projectId}`)[0]?.ai_provider,
    ).toBe("google");
    await setProject(d, w.owner, w.projectId, "scaleway");
    const changes = (await events(w.orgId)).filter((e) => e.type === "project.ai_provider.changed");
    expect(changes.map((e) => e.detail)).toEqual([
      { before: null, after: "google" },
      { before: "google", after: "scaleway" },
    ]);
    // The same answer again is no change and writes nothing.
    await setProject(d, w.owner, w.projectId, "scaleway");
    expect(
      (await events(w.orgId)).filter((e) => e.type === "project.ai_provider.changed"),
    ).toHaveLength(2);
  });

  test("taking Google away moves the account's projects back and clears their choice, so giving it back does not send them there again", async () => {
    const w = await world();
    const staff = randomUUID();
    await setOrg(d, staff, w.orgId, {
      allowed: ["scaleway", "google"],
      default: "google",
      requestTicketId: w.ticket,
    });
    await setProject(d, w.owner, w.projectId, "google");
    await setOrg(d, staff, w.orgId, {
      allowed: ["scaleway"],
      default: "scaleway",
      requestTicketId: w.ticket,
    });
    expect(
      (await sql`select ai_provider from project where id = ${w.projectId}`)[0]?.ai_provider,
    ).toBeNull();
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      options: ["scaleway"],
      effective: "scaleway",
    });
    const last = (await events(w.orgId)).at(-1);
    expect(last?.detail).toMatchObject({
      projects_reset: 1,
      after: { allowed: ["scaleway"], default: "scaleway" },
    });
    const history = (await readOrg(d, w.owner, w.orgId)).history.map((h) => [h.kind, h.provider]);
    expect(history).toContainEqual(["removed", "google"]);
    await setOrg(d, staff, w.orgId, {
      allowed: ["scaleway", "google"],
      default: "scaleway",
      requestTicketId: w.ticket,
    });
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      current: null,
      effective: "scaleway",
    });
  });
});
