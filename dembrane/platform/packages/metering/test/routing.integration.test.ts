import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { decide, type ModelCall, routed, routingPolicyOf } from "@dembrane/llm";
import type { Payer, PayerRefKind } from "@dembrane/observability";
import type postgres from "postgres";
import {
  dbRoutingStore,
  modelCallRecorder,
  modelCallTable,
  providerResolver,
  runProviderCheck,
} from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_routing_${process.pid}`;
const policy = routingPolicyOf({
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
});
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

run("the routing policy against the database", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;

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
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  /** An organisation with a billing account, a workspace and a project; `payingOrg` pays for the workspace. */
  async function setup(o: {
    allowed?: string[] | null;
    accountDefault?: string | null;
    project?: string | null;
    paidBy?: { allowed: string[] | null };
  }) {
    const orgId = randomUUID();
    await sql`insert into org (id, name, ai_providers, ai_default_provider)
      values (${orgId}, 'client', ${o.allowed ?? null}, ${o.accountDefault ?? null})`;
    let accountOrg = orgId;
    if (o.paidBy) {
      accountOrg = randomUUID();
      await sql`insert into org (id, name, ai_providers, is_partner)
        values (${accountOrg}, 'partner', ${o.paidBy.allowed}, true)`;
    }
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${accountOrg})`;
    const workspaceId = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    const projectId = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, ai_provider)
      values (${projectId}, true, ${workspaceId}, ${o.project ?? null})`;
    return { orgId, accountOrg, accountId, workspaceId, projectId };
  }

  const fresh = () => providerResolver(dbRoutingStore(db), policy, { ttlMs: 0 });
  const ask = (who: Payer | undefined) => decide(fresh(), policy, who);

  test("a project on Google, and the account's own default, as the database holds them", async () => {
    const a = await setup({
      allowed: ["scaleway", "google"],
      accountDefault: "scaleway",
      project: "google",
    });
    expect(await ask({ ref: "project", id: a.projectId })).toMatchObject({
      provider: "google",
      reason: "project",
      organisationId: a.orgId,
    });
    const b = await setup({ allowed: ["scaleway", "google"], accountDefault: "google" });
    expect(await ask({ ref: "project", id: b.projectId })).toMatchObject({
      provider: "google",
      reason: "account-default",
    });
    const c = await setup({});
    expect(await ask({ ref: "project", id: c.projectId })).toMatchObject({
      provider: "scaleway",
      reason: "environment-default",
    });
  });

  test("the workspace's organisation decides, never the account that pays: a partner paying for a client", async () => {
    // The client allows Google; the partner that pays does not.
    const a = await setup({
      allowed: ["scaleway", "google"],
      accountDefault: "scaleway",
      project: "google",
      paidBy: { allowed: ["scaleway"] },
    });
    expect(a.accountOrg).not.toBe(a.orgId);
    expect(await ask({ ref: "project", id: a.projectId })).toMatchObject({
      provider: "google",
      organisationId: a.orgId,
    });
    // The partner allows Google; the client does not.
    const b = await setup({
      allowed: ["scaleway"],
      accountDefault: "scaleway",
      project: "google",
      paidBy: { allowed: ["scaleway", "google"] },
    });
    expect(await ask({ ref: "project", id: b.projectId })).toMatchObject({ provider: "scaleway" });
  });

  test("every kind of payer leads to its project's provider; unknown and deleted ones are the default", async () => {
    const a = await setup({ allowed: ["scaleway", "google"], project: "google" });
    const conversation = randomUUID();
    await sql`insert into conversation (id, project_id, ai_provider) values (${conversation}, ${a.projectId}, 'google')`;
    const chat = randomUUID();
    await sql`insert into project_chat (id, project_id) values (${chat}, ${a.projectId})`;
    const agent = randomUUID();
    await sql`insert into project_agentic_run (id, project_id) values (${agent}, ${a.projectId})`;
    const [report] = await sql<
      { id: string }[]
    >`insert into project_report (project_id) values (${a.projectId}) returning id::text as id`;
    const loop = randomUUID();
    await sql`insert into agent_loop (id, project_id, expires_at) values (${loop}, ${a.projectId}, now() + interval '1 day')`;
    const artifact = randomUUID();
    await sql`insert into conversation_artifact (id, conversation_id) values (${artifact}, ${conversation})`;
    const scope = randomUUID();
    const run = randomUUID();
    await sql`insert into analysis_scope (id, project_id, kind, scope_key, recipe_id)
      values (${scope}, ${a.projectId}, 'producer', 'k', 'r')`;
    await sql`insert into analysis_run (id, project_id, scope_id, recipe_id, definition, request_order, idempotency_key, mode, recipe_version, request_fingerprint, status, attempt, epoch, hash_version, writer_fence)
      values (${run}, ${a.projectId}, ${scope}, 'r', '{}'::json, 1, 'k', 'refresh', '1', 'fp', 'queued', 0, 0, 'c14n-v1', 0)`;
    const kinds: [PayerRefKind, string][] = [
      ["project", a.projectId],
      ["conversation", conversation],
      ["chat", chat],
      ["agent_run", agent],
      ["report", report?.id as string],
      ["canvas", loop],
      ["popcorn_loop", loop],
      ["verify_artifact", artifact],
      ["analysis_run", run],
      ["workspace", a.workspaceId],
    ];
    for (const [ref, id] of kinds) {
      const d = await ask({ ref, id });
      // A workspace has no project of its own: it follows the account default.
      expect([ref, d.provider]).toEqual([ref, ref === "workspace" ? "scaleway" : "google"]);
      expect(d.organisationId).toBe(a.orgId);
    }
    expect(await ask({ ref: "project", id: randomUUID() })).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:unknown-project",
    });
    expect(await ask({ ref: "project", id: "not-a-uuid" })).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:unknown-project",
    });
    await sql`update project set deleted_at = now() where id = ${a.projectId}`;
    expect(await ask({ ref: "project", id: a.projectId })).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:unknown-project",
    });
    expect(await ask({ ref: "conversation", id: conversation })).toMatchObject({
      provider: "scaleway",
    });
    await sql`update project set deleted_at = null where id = ${a.projectId}`;
    await sql`update org set deleted_at = now() where id = ${a.orgId}`;
    expect(await ask({ ref: "project", id: a.projectId })).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:unknown-project",
    });
  });

  test("a conversation that began on Scaleway stays there after its project moves to Google, and back applies at once", async () => {
    const a = await setup({
      allowed: ["scaleway", "google"],
      accountDefault: "scaleway",
      project: null,
    });
    const early = randomUUID();
    await sql`insert into conversation (id, project_id, ai_provider) values (${early}, ${a.projectId}, 'scaleway')`;
    await sql`update project set ai_provider = 'google' where id = ${a.projectId}`;
    const late = randomUUID();
    await sql`insert into conversation (id, project_id, ai_provider) values (${late}, ${a.projectId}, 'google')`;
    // The decision names the conversation, so the call log can say whose provider it followed.
    expect(await ask({ ref: "conversation", id: early })).toMatchObject({ conversationId: early });
    expect(await ask({ ref: "project", id: a.projectId })).not.toHaveProperty("conversationId");
    expect((await ask({ ref: "conversation", id: early })).provider).toBe("scaleway");
    expect((await ask({ ref: "conversation", id: late })).provider).toBe("google");
    expect((await ask({ ref: "project", id: a.projectId })).provider).toBe("google");
    await sql`update project set ai_provider = 'scaleway' where id = ${a.projectId}`;
    expect((await ask({ ref: "conversation", id: late })).provider).toBe("scaleway");
    // The account losing Google moves the project back as well.
    await sql`update project set ai_provider = 'google' where id = ${a.projectId}`;
    await sql`update org set ai_providers = array['scaleway'] where id = ${a.orgId}`;
    expect((await ask({ ref: "conversation", id: late })).provider).toBe("scaleway");
  });

  test("rows carry the organisation, the provider the policy chose and why; the daily check finds a planted bad row", async () => {
    const a = await setup({ allowed: ["scaleway", "google"], project: "google" });
    const b = await setup({ allowed: ["scaleway"], project: null });
    const alerts: string[] = [];
    const recorder = modelCallRecorder({
      sink: modelCallTable(db),
      logger: quiet,
      service: "echo-worker",
      prices: {
        current: () => ({
          prices: new Map(
            ["vertex", "openai-compatible"].map((p) => [
              `${p}/m`,
              {
                id: 1,
                provider: p,
                model: "m",
                source: "override" as const,
                effectiveFrom: new Date("2026-01-01T00:00:00Z"),
                currency: "EUR" as const,
                inputPerM: 1,
                cachedInputPerM: null,
                audioInputPerM: null,
                outputPerM: 1,
                longContext: null,
                perAudioSecond: null,
                perSearchQuery: null,
              },
            ]),
          ),
          usdToEur: 1,
        }),
      },
      flushMs: 60_000,
    });
    const call = (provider: string, routing: ModelCall["routing"]): ModelCall => ({
      group: "text_fast",
      provider,
      model: "m",
      kind: "generate",
      startedAt: new Date(),
      ms: 1,
      inputTokens: 1,
      cachedInputTokens: null,
      audioInputTokens: null,
      outputTokens: 1,
      reasoningTokens: null,
      audioSeconds: null,
      searchQueries: null,
      usageEstimated: false,
      finishReason: "stop",
      status: "ok",
      error: null,
      attempt: 1,
      fallback: false,
      routing,
    });
    const decision = await ask({ ref: "project", id: a.projectId });
    // A call the policy sent to Google for a Google project, and one with no routing note at all.
    const { withPayer } = await import("@dembrane/observability");
    withPayer({ ref: "project", id: a.projectId }, () =>
      routed(decision, () => recorder.observe(call("vertex", decision))),
    );
    withPayer({ ref: "project", id: b.projectId }, () =>
      recorder.observe(call("openai-compatible", null)),
    );
    await recorder.flush();
    const rows = await sql<
      {
        organisation_id: string | null;
        routed_provider: string | null;
        routing_reason: string | null;
        project_id: string;
      }[]
    >`
      select organisation_id::text, routed_provider, routing_reason, project_id::text from model_call order by id`;
    expect(rows[0]).toMatchObject({
      organisation_id: a.orgId,
      routed_provider: "google",
      routing_reason: "project",
    });
    // No routing note: the organisation is still the one owning the project's workspace.
    expect(rows[1]).toMatchObject({ organisation_id: b.orgId, routed_provider: null });
  });

  describe("the daily provider check", () => {
    const events = (orgId: string) => ({
      org: (before: object | null, after: object, at: string) =>
        sql`insert into account_event (id, org_id, actor_kind, type, subject_type, subject_id, detail, created_at)
          values (${randomUUID()}, ${orgId}, 'staff', 'ai_providers.changed', 'org', ${orgId},
            ${sql.json({ before, after } as never)}, ${at}::timestamptz)`,
      project: (projectId: string, before: string | null, after: string | null, at: string) =>
        sql`insert into account_event (id, org_id, actor_kind, type, subject_type, subject_id, detail, created_at)
          values (${randomUUID()}, ${orgId}, 'customer', 'project.ai_provider.changed', 'project', ${projectId},
            ${sql.json({ before, after } as never)}, ${at}::timestamptz)`,
    });
    const vertexCall = (
      o: { orgId: string; projectId: string; conversationId?: string },
      at: string,
      routed = "google",
    ) =>
      sql`insert into model_call (started_at, service, model_group, model, kind, status, attempt, ms, provider, routed_provider, routing_reason, routing_allowed, organisation_id, project_id, routing_conversation_id)
        values (${at}::timestamptz, 'echo-worker', 'text_fast', 'gemini', 'generate', 'ok', 1, 1, 'vertex', ${routed}, 'project', array['scaleway','google'], ${o.orgId}, ${o.projectId}, ${o.conversationId ?? null})`;
    const checkAt = (
      at: string,
      alerts: string[],
      defaultProvider: "scaleway" | "google" = "scaleway",
    ) =>
      runProviderCheck({
        db,
        logger: quiet,
        alerts: (async (m: { json: { text: string } }) => void alerts.push(m.json.text)) as never,
        now: () => new Date(at),
        lagMs: 0,
        defaultProvider,
      });
    const reset = async () => {
      await sql`delete from model_call`;
      await sql`delete from ai_provider_check`;
    };
    const BOTH = { allowed: ["scaleway", "google"], default: "scaleway" };
    const ONLY_SCALEWAY = { allowed: ["scaleway"], default: "scaleway" };

    test("a call is fine while the history allowed Google and the project chose it, and not when either did not", async () => {
      await reset();
      const a = await setup({});
      const ev = events(a.orgId);
      await ev.org(ONLY_SCALEWAY, BOTH, "2026-11-01T10:00:00Z");
      await ev.project(a.projectId, null, "google", "2026-11-01T11:00:00Z");
      // Google removed from the account at 12:00: the project's choice goes with it.
      await ev.org(BOTH, ONLY_SCALEWAY, "2026-11-01T12:00:00Z");
      // Given back at 13:00, but the project has not chosen it again.
      await ev.org(ONLY_SCALEWAY, BOTH, "2026-11-01T13:00:00Z");
      await vertexCall(a, "2026-11-01T11:30:00Z"); // allowed, chosen: fine
      const alerts: string[] = [];
      expect(await checkAt("2026-11-02T04:00:00Z", alerts)).toEqual({ leaks: 0 });
      await vertexCall(a, "2026-11-01T09:00:00Z"); // before Google was ever allowed
      await vertexCall(a, "2026-11-01T12:30:00Z"); // after the removal
      await vertexCall(a, "2026-11-01T13:30:00Z"); // allowed again, project not chosen
      // The three are older than the watermark the first run left: a rerun from there ignores them.
      expect(await checkAt("2026-11-02T05:00:00Z", alerts)).toEqual({ leaks: 0 });
      await sql`delete from ai_provider_check`;
      expect(await checkAt("2026-11-02T06:00:00Z", alerts)).toEqual({ leaks: 3 });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain(a.orgId);
    });

    test("it recomputes instead of trusting what the call recorded about itself", async () => {
      await reset();
      const a = await setup({});
      // The call says Google was allowed; the account's history says it never was.
      await vertexCall(a, "2026-11-01T10:00:00Z");
      expect(await checkAt("2026-11-02T04:00:00Z", [])).toEqual({ leaks: 1 });
    });

    test("a conversation that began on Scaleway may not reach Google, whatever the project chose", async () => {
      await reset();
      const a = await setup({});
      const ev = events(a.orgId);
      await ev.org(ONLY_SCALEWAY, BOTH, "2026-11-01T10:00:00Z");
      await ev.project(a.projectId, null, "google", "2026-11-01T10:30:00Z");
      const onGoogle = randomUUID();
      const onScaleway = randomUUID();
      await sql`insert into conversation (id, project_id, ai_provider) values (${onGoogle}, ${a.projectId}, 'google'), (${onScaleway}, ${a.projectId}, 'scaleway')`;
      await vertexCall({ ...a, conversationId: onGoogle }, "2026-11-01T11:00:00Z");
      await vertexCall({ ...a, conversationId: onScaleway }, "2026-11-01T11:05:00Z");
      expect(await checkAt("2026-11-02T04:00:00Z", [])).toEqual({ leaks: 1 });
    });

    test("a missed day is still covered: the next run reads from where the last stopped", async () => {
      await reset();
      const a = await setup({});
      expect(await checkAt("2026-11-02T04:00:00Z", [])).toEqual({ leaks: 0 });
      // Three days pass with no run; a leak on the second of them.
      await vertexCall(a, "2026-11-03T10:00:00Z");
      expect(await checkAt("2026-11-05T04:00:00Z", [])).toEqual({ leaks: 1 });
      expect(await checkAt("2026-11-06T04:00:00Z", [])).toEqual({ leaks: 0 });
    });

    test("where Google is the deployment's default, only a call the policy sent elsewhere counts", async () => {
      await reset();
      const a = await setup({});
      await vertexCall(a, "2026-11-01T10:00:00Z");
      await vertexCall(a, "2026-11-01T10:05:00Z", "scaleway");
      expect(await checkAt("2026-11-02T04:00:00Z", [], "google")).toEqual({ leaks: 1 });
    });
  });
});
