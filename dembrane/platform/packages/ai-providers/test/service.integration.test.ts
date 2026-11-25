import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { type Job, routingPolicyOf } from "@dembrane/llm";
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
      models: { scaleway: ["whisper-large-v3", "glm-5.3"] },
      now: () => new Date("2026-12-03T10:00:00Z"),
      unitCostTtlMs: 0,
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

  /** Google enabled for both jobs, Scaleway the default of each; a test changes what it needs. */
  const BOTH = {
    enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway", "google"] },
    defaults: { transcription: "scaleway", analysis: "scaleway" },
  } as const;
  const SCALEWAY_ONLY = {
    enabled: { transcription: ["scaleway"], analysis: ["scaleway"] },
    defaults: { transcription: "scaleway", analysis: "scaleway" },
  } as const;
  const column = (job: Job) =>
    job === "transcription" ? "ai_transcription_provider" : "ai_analysis_provider";
  const choice = async (projectId: string, job: Job) =>
    (
      await sql`select ai_transcription_provider as t, ai_analysis_provider as a from project where id = ${projectId}`
    )[0]?.[job === "transcription" ? "t" : "a"];

  test("a project's choice waits for staff taking Google away, and is then refused", async () => {
    const w = await world();
    await setOrg(d, randomUUID(), w.orgId, { ...BOTH, requestTicketId: w.ticket });
    let result: Promise<unknown> = Promise.resolve();
    // Staff's change is written but not yet committed when the project admin chooses Google.
    await sql.begin(async (tx) => {
      await tx`update org set ai_analysis_providers = ${["scaleway"]}, ai_analysis_default = 'scaleway' where id = ${w.orgId}`;
      result = setProject(d, w.owner, w.projectId, "analysis", "google").then(
        () => "chose",
        (err: unknown) => err,
      );
      await Bun.sleep(500);
    });
    expect(await result).toMatchObject({
      message: expect.stringContaining("has not enabled google for analysis"),
    });
    expect(await choice(w.projectId, "analysis")).toBeNull();
  });

  test("an account nobody set offers only the deployment's default for each job, to owners and admins only", async () => {
    const w = await world();
    expect(await readOrg(d, w.owner, w.orgId)).toMatchObject({
      jobs: ["transcription", "analysis"],
      available: ["scaleway", "google"],
      serves: { scaleway: ["transcription", "analysis"], google: ["transcription", "analysis"] },
      enabled: { transcription: ["scaleway"], analysis: ["scaleway"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
      models: { scaleway: ["whisper-large-v3", "glm-5.3"] },
      history: [],
    });
    expect((await readOrg(d, w.orgAdmin, w.orgId)).enabled.analysis).toEqual(["scaleway"]);
    await expect(readOrg(d, w.billing, w.orgId)).rejects.toMatchObject({
      code: "organisation.admin_only",
    });
    await expect(readOrg(d, w.member, w.orgId)).rejects.toMatchObject({ status: 404 });
    await expect(readOrg(d, w.outsider, w.orgId)).rejects.toMatchObject({ status: 404 });
  });

  test("staff enable Google for analysis only, at a customer's written request: the change, the event and the history line", async () => {
    const w = await world();
    const staff = randomUUID();
    await setOrg(d, staff, w.orgId, {
      enabled: { transcription: ["scaleway"], analysis: ["scaleway", "google"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
      requestTicketId: w.ticket,
    });
    expect(await readOrg(d, w.owner, w.orgId)).toMatchObject({
      enabled: { transcription: ["scaleway"], analysis: ["scaleway", "google"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
      history: [
        {
          kind: "enabled",
          provider: "google",
          job: "analysis",
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
        before: SCALEWAY_ONLY,
        after: {
          enabled: { transcription: ["scaleway"], analysis: ["scaleway", "google"] },
          defaults: { transcription: "scaleway", analysis: "scaleway" },
        },
        request_ticket_id: w.ticket,
      },
    });
    const forStaff = await readOrgForStaff(d, w.orgId);
    expect(forStaff.tickets.map((t) => t.id)).toEqual([w.ticket]);
    expect(forStaff.models).toEqual({ scaleway: ["whisper-large-v3", "glm-5.3"] });
  });

  test("the history has one line per job and change, and a default change reads as one", async () => {
    const w = await world();
    const staff = randomUUID();
    let minute = 0;
    const ticking = { ...d, now: () => new Date(Date.UTC(2026, 11, 3, 10, minute++)) };
    await setOrg(ticking, staff, w.orgId, { ...BOTH, requestTicketId: w.ticket });
    await setOrg(ticking, staff, w.orgId, {
      ...BOTH,
      defaults: { transcription: "scaleway", analysis: "google" },
      requestTicketId: w.ticket,
    });
    await setOrg(ticking, staff, w.orgId, {
      enabled: { transcription: ["scaleway"], analysis: ["scaleway", "google"] },
      defaults: { transcription: "scaleway", analysis: "google" },
      requestTicketId: w.ticket,
    });
    const lines = (await readOrg(d, w.owner, w.orgId)).history.map((h) => [
      h.kind,
      h.provider,
      h.job,
    ]);
    // Newest first, and within one change transcription before analysis.
    expect(lines).toEqual([
      ["disabled", "google", "transcription"],
      ["default", "google", "analysis"],
      ["enabled", "google", "transcription"],
      ["enabled", "google", "analysis"],
    ]);
  });

  test("staff read who made a change by display name, never by email", async () => {
    const w = await world();
    const staff = randomUUID();
    await sql`insert into auth_user (id, name, email) values (${staff}, 'sam.staff', ${`${staff}@example.com`})`;
    await sql`insert into app_user (id, directus_user_id, display_name) values (${randomUUID()}, ${staff}, 'Sam Example')`;
    await setOrg(d, staff, w.orgId, { ...BOTH, requestTicketId: w.ticket });
    const { history } = await readOrgForStaff(d, w.orgId);
    expect(history).toMatchObject([
      { kind: "enabled", provider: "google", job: "transcription", by: "Sam Example" },
      { kind: "enabled", provider: "google", job: "analysis", by: "Sam Example" },
    ]);
    expect(JSON.stringify(history)).not.toContain("@example.com");
  });

  test("staff cannot grant what the deployment lacks, name no request, or cite another account's ticket", async () => {
    const w = await world();
    const other = await world();
    const staff = randomUUID();
    const only = { ...d, policy: routingPolicyOf({ provider: "openai-compatible" }) };
    await expect(
      setOrg(only, staff, w.orgId, { ...BOTH, requestTicketId: w.ticket }),
    ).rejects.toThrow(/no provider google/);
    await expect(
      setOrg(d, staff, w.orgId, {
        enabled: { transcription: ["google"], analysis: ["scaleway"] },
        defaults: { transcription: "scaleway", analysis: "scaleway" },
        requestTicketId: w.ticket,
      }),
    ).rejects.toThrow(/transcription default must be one of/);
    await expect(
      setOrg(d, staff, w.orgId, { ...SCALEWAY_ONLY, requestTicketId: "" }),
    ).rejects.toThrow(/request ticket/);
    await expect(
      setOrg(d, staff, w.orgId, { ...SCALEWAY_ONLY, requestTicketId: other.ticket }),
    ).rejects.toThrow(/not one of this account/);
    await expect(
      setOrg(d, staff, w.orgId, {
        enabled: { transcription: ["orai"], analysis: ["orai"] },
        defaults: { transcription: "orai", analysis: "orai" },
        requestTicketId: w.ticket,
      }),
    ).rejects.toThrow(/Not an AI provider/);
    expect((await events(w.orgId)).length).toBe(0);
  });

  test("a job can only be set to a provider that serves it", async () => {
    // A provider that hears audio and reads no text, as Orai will for Basque.
    const { PROVIDERS } = await import("@dembrane/llm");
    const google = PROVIDERS.google as { jobs: readonly Job[] };
    const original = google.jobs;
    google.jobs = ["transcription"];
    try {
      const w = await world();
      await expect(
        setOrg(d, randomUUID(), w.orgId, {
          enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway", "google"] },
          defaults: { transcription: "google", analysis: "scaleway" },
          requestTicketId: w.ticket,
        }),
      ).rejects.toThrow(/google does not serve analysis/);
      await setOrg(d, randomUUID(), w.orgId, {
        enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway"] },
        defaults: { transcription: "google", analysis: "scaleway" },
        requestTicketId: w.ticket,
      });
      const view = await readProject(d, w.owner, w.projectId);
      expect(view.jobs.analysis.options).toEqual(["scaleway"]);
      expect(view.jobs.transcription.options).toEqual(["scaleway", "google"]);
      await expect(setProject(d, w.owner, w.projectId, "analysis", "google")).rejects.toThrow(
        /has not enabled google for analysis/,
      );
      // A stored setting that names it anyway still never offers it for the job.
      await sql`update org set ai_analysis_providers = array['scaleway','google'] where id = ${w.orgId}`;
      expect((await readOrg(d, w.owner, w.orgId)).enabled.analysis).toEqual(["scaleway"]);
    } finally {
      google.jobs = original;
    }
  });

  test("a project admin chooses per job among what the account enabled; a member sees the field but cannot change it", async () => {
    const w = await world();
    // One provider: the field has one option and the choice is refused.
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      jobs: {
        transcription: { options: ["scaleway"], effective: "scaleway" },
        analysis: { options: ["scaleway"], effective: "scaleway" },
      },
      can_change: true,
      models: { scaleway: ["whisper-large-v3", "glm-5.3"] },
    });
    await expect(setProject(d, w.owner, w.projectId, "analysis", "google")).rejects.toThrow(
      /has not enabled google for analysis/,
    );
    await setOrg(d, randomUUID(), w.orgId, { ...BOTH, requestTicketId: w.ticket });
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      jobs: {
        transcription: {
          options: ["scaleway", "google"],
          account_default: "scaleway",
          current: null,
        },
        analysis: { options: ["scaleway", "google"], account_default: "scaleway", current: null },
      },
    });
    expect(await readProject(d, w.member, w.projectId)).toMatchObject({ can_change: false });
    await expect(setProject(d, w.member, w.projectId, "analysis", "google")).rejects.toMatchObject({
      status: 403,
    });
    await expect(setProject(d, w.owner, w.projectId, "nothing", "google")).rejects.toThrow(
      /Not a job/,
    );
    // Transcription on Google with analysis left alone, then analysis too, then back.
    const view = await setProject(d, w.owner, w.projectId, "transcription", "google");
    expect(view.jobs.transcription).toMatchObject({ current: "google", effective: "google" });
    expect(view.jobs.analysis).toMatchObject({ current: null, effective: "scaleway" });
    expect(await choice(w.projectId, "transcription")).toBe("google");
    expect(await choice(w.projectId, "analysis")).toBeNull();
    await setProject(d, w.owner, w.projectId, "analysis", "google");
    await setProject(d, w.owner, w.projectId, "transcription", "scaleway");
    expect([
      await choice(w.projectId, "transcription"),
      await choice(w.projectId, "analysis"),
    ]).toEqual(["scaleway", "google"]);
    const changes = (await events(w.orgId)).filter((e) => e.type === "project.ai_provider.changed");
    expect(changes.map((e) => e.detail)).toEqual([
      { job: "transcription", before: null, after: "google" },
      { job: "analysis", before: null, after: "google" },
      { job: "transcription", before: "google", after: "scaleway" },
    ]);
    // The same answer again is no change and writes nothing.
    await setProject(d, w.owner, w.projectId, "transcription", "scaleway");
    expect(
      (await events(w.orgId)).filter((e) => e.type === "project.ai_provider.changed"),
    ).toHaveLength(3);
    expect(column("analysis")).toBe("ai_analysis_provider");
  });

  test("taking Google away from a job clears that job's choices only, so giving it back does not send projects there again", async () => {
    const w = await world();
    const staff = randomUUID();
    await setOrg(d, staff, w.orgId, {
      ...BOTH,
      defaults: { transcription: "scaleway", analysis: "google" },
      requestTicketId: w.ticket,
    });
    await setProject(d, w.owner, w.projectId, "analysis", "google");
    await setProject(d, w.owner, w.projectId, "transcription", "google");
    // Google leaves analysis; transcription keeps it.
    await setOrg(d, staff, w.orgId, {
      enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
      requestTicketId: w.ticket,
    });
    expect(await choice(w.projectId, "analysis")).toBeNull();
    expect(await choice(w.projectId, "transcription")).toBe("google");
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      jobs: {
        analysis: { options: ["scaleway"], effective: "scaleway" },
        transcription: { effective: "google" },
      },
    });
    const last = (await events(w.orgId)).at(-1);
    expect(last?.detail).toMatchObject({ projects_reset: 1 });
    const history = (await readOrg(d, w.owner, w.orgId)).history.map((h) => [
      h.kind,
      h.provider,
      h.job,
    ]);
    expect(history).toContainEqual(["disabled", "google", "analysis"]);
    await setOrg(d, staff, w.orgId, { ...BOTH, requestTicketId: w.ticket });
    expect(await readProject(d, w.owner, w.projectId)).toMatchObject({
      jobs: { analysis: { current: null, effective: "scaleway" } },
    });
  });

  test("the account page carries the cost of each provider for each job, and this month's spend", async () => {
    const w = await world();
    const staff = randomUUID();
    await setOrg(d, staff, w.orgId, { ...BOTH, requestTicketId: w.ticket });
    // No use yet: the lines are the cost of an hour of audio and of 100 analysis calls.
    const fresh = await readOrg(d, w.owner, w.orgId);
    expect(fresh.cost.transcription.scaleway).toMatchObject({
      billing: "included",
      monthly_eur: null,
    });
    expect(fresh.cost.analysis.google).toMatchObject({ billing: "on_top", monthly_eur: null });
    expect(fresh.month.spent).toEqual({ scaleway: 0, google: 0 });
    // A month of use seeded in the call log.
    const call = (
      provider: "scaleway" | "google",
      job: Job,
      at: string,
      micro: number,
      extra: string,
    ) =>
      sql`insert into model_call (started_at, service, model_group, model, kind, status, attempt, ms, provider, routed_provider, routing_job, organisation_id, project_id, payer, audio_seconds, input_tokens, output_tokens, cost_micro_eur)
        values (${at}::timestamptz, 's', 'g', 'm', ${job === "transcription" ? "speech" : "generate"}, 'ok', 1, 1,
          ${provider === "google" ? "vertex" : "openai-compatible"}, ${provider}, ${job}, ${w.orgId}, ${w.projectId}, 'account',
          ${extra === "audio" ? 3600 : null}, ${extra === "audio" ? null : 900}, ${extra === "audio" ? null : 100}, ${micro})`;
    await call("scaleway", "transcription", "2026-12-01T09:00:00Z", 180_000, "audio");
    await call("google", "transcription", "2026-12-02T09:00:00Z", 900_000, "audio");
    await call("google", "analysis", "2026-12-02T10:00:00Z", 40_000, "text");
    const used = await readOrg(d, w.owner, w.orgId);
    // Two hours of audio in 30 days; Google's average is EUR 0.90 an hour across the log.
    expect(used.cost.transcription.google).toMatchObject({ monthly_eur: 1.8, per_hour_eur: null });
    expect(used.cost.analysis.google?.monthly_eur).toBe(0.04);
    expect(used.month).toMatchObject({
      from: "2026-12-01T00:00:00.000Z",
      spent: { scaleway: 0.18, google: 0.94 },
    });
    // A project sees its own use only.
    const other = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id) values (${other}, true, ${w.workspaceId})`;
    const mine = await readProject(d, w.owner, other);
    expect(mine.cost.transcription.google).toMatchObject({ monthly_eur: null });
    expect(
      (await readProject(d, w.owner, w.projectId)).cost.transcription.google?.monthly_eur,
    ).toBe(1.8);
    // Staff read the same lines.
    expect((await readOrgForStaff(d, w.orgId)).month.spent.google).toBe(0.94);
  });
});
