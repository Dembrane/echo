import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { generateTitle } from "@dembrane/chats";
import { buildSpeechKit, type SpeechRouter, withTranscriber } from "@dembrane/conversations";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import {
  completerIdentity,
  decide,
  type LlmSettings,
  type ProviderKit,
  profileForProvider,
  STUB_VERTEX_AUTH,
  wireStubs,
} from "@dembrane/llm";
import {
  aiRouting,
  modelCallRecorder,
  modelCallTable,
  type PriceRow,
  runProviderCheck,
} from "@dembrane/metering";
import { createLogger, type Payer, withPayer } from "@dembrane/observability";
import { generateText, streamText } from "ai";
import type postgres from "postgres";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `api_ai_routing_${process.pid}`;

const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
  baseUrl: "https://scaleway.e2e.test/v1",
  apiKey: "k",
  searchGrounding: true,
  textFast: ["gemini-a"],
  multiModalFast: ["gemini-a"],
  multiModalPro: ["gemini-a"],
  compatTextFast: ["glm-5.3"],
  compatMultiModalFast: ["glm-5.3"],
  compatMultiModalPro: ["glm-5.3"],
  vertexProject: "p",
  vertexLocation: "eu",
  embeddingModel: "text-embedding-004",
  compatEmbeddingModel: "qwen3-embedding-8b",
  embeddingLocation: "europe-west4",
  embeddingDimensions: 8,
};
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(2000).fill(1)]);

// What every model call of the fakes is priced at; the recorder holds rows until it has prices.
const price = (provider: string, model: string): [string, PriceRow] => [
  `${provider}/${model}`,
  {
    id: 1,
    provider,
    model,
    source: "override",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    currency: "EUR",
    inputPerM: 1,
    cachedInputPerM: null,
    audioInputPerM: null,
    outputPerM: 1,
    longContext: null,
    perAudioSecond: 1,
    perSearchQuery: 1,
  },
];
const prices = {
  current: () => ({
    prices: new Map([
      price("vertex", "gemini-a"),
      price("vertex", "text-embedding-004"),
      price("openai-compatible", "glm-5.3"),
      price("openai-compatible", "whisper-large-v3"),
      price("openai-compatible", "qwen3-embedding-8b"),
    ]),
    usdToEur: 1,
  }),
};

run("two projects in one process, one on each provider", () => {
  setDefaultTimeout(120_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let kit: ProviderKit;
  let speech: SpeechRouter;
  let recorder: ReturnType<typeof modelCallRecorder>;

  // Each project's work carries its own marker, so the stubs can tell whose request they see.
  const S = { marker: "marker-scaleway-project" } as {
    marker: string;
    project: string;
    org: string;
  };
  const G = { marker: "marker-google-project" } as { marker: string; project: string; org: string };
  const wire = wireStubs({
    text: '{"corrected_transcript":"heard","note":"","verdict":"x"}',
    speech: "heard",
    vertexGuard: (r) => {
      // The Vertex stub throws if it ever sees a request for the Scaleway project.
      if (r.body.includes(S.marker))
        throw new Error("a request for the Scaleway project reached Vertex");
    },
  });
  const ids: Record<string, Record<"s" | "g", string>> = {};

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 4 });
    db = made.db;
    close = made.close;

    // One organisation that allows both; project S stays on Scaleway, project G chose Google.
    const orgId = randomUUID();
    await sql`insert into org (id, name, ai_providers, ai_default_provider)
      values (${orgId}, 'both', array['scaleway','google'], 'scaleway')`;
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    S.org = G.org = orgId;
    for (const [who, choice, key] of [
      [S, null, "s"],
      [G, "google", "g"],
    ] as const) {
      const project = randomUUID();
      who.project = project;
      await sql`insert into project (id, is_conversation_allowed, workspace_id, ai_provider) values (${project}, true, ${workspaceId}, ${choice})`;
      const conversation = randomUUID();
      await sql`insert into conversation (id, project_id, ai_provider) values (${conversation}, ${project}, ${choice === "google" ? "google" : "scaleway"})`;
      const chat = randomUUID();
      await sql`insert into project_chat (id, project_id) values (${chat}, ${project})`;
      const agent = randomUUID();
      await sql`insert into project_agentic_run (id, project_id) values (${agent}, ${project})`;
      const [report] = await sql<
        { id: string }[]
      >`insert into project_report (project_id) values (${project}) returning id::text as id`;
      const loop = randomUUID();
      await sql`insert into agent_loop (id, project_id, expires_at) values (${loop}, ${project}, now() + interval '1 day')`;
      const artifact = randomUUID();
      await sql`insert into conversation_artifact (id, conversation_id) values (${artifact}, ${conversation})`;
      const scope = randomUUID();
      const analysisRun = randomUUID();
      await sql`insert into analysis_scope (id, project_id, kind, scope_key, recipe_id) values (${scope}, ${project}, 'producer', 'k', 'r')`;
      await sql`insert into analysis_run (id, project_id, scope_id, recipe_id, definition, request_order, idempotency_key, mode, recipe_version, request_fingerprint, status, attempt, epoch, hash_version, writer_fence)
        values (${analysisRun}, ${project}, ${scope}, 'r', '{}'::json, 1, 'k', 'refresh', '1', 'fp', 'queued', 0, 0, 'c14n-v1', 0)`;
      const set = (name: string, id: string) => {
        ids[name] = { ...(ids[name] ?? {}), [key]: id } as Record<"s" | "g", string>;
      };
      set("project", project);
      set("conversation", conversation);
      set("chat", chat);
      set("agent_run", agent);
      set("report", report?.id as string);
      set("canvas", loop);
      set("popcorn_loop", loop);
      set("verify_artifact", artifact);
      set("analysis_run", analysisRun);
      set("workspace", workspaceId);
    }

    recorder = modelCallRecorder({
      sink: modelCallTable(db),
      logger,
      service: "echo-worker",
      prices,
      flushMs: 60_000,
    });
    const hooks = {
      observe: recorder.observe,
      attemptsPerDeployment: 1,
      backoffMs: 0,
      sleep: async () => {},
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    };
    const ai = aiRouting({ settings: SETTINGS, db, hooks, resolverOptions: { ttlMs: 0 } });
    kit = ai.kit;
    speech = {
      default: ai.policy.default,
      kits: Object.fromEntries(
        ai.policy.providers.map((id) => [
          id,
          buildSpeechKit({
            settings: SETTINGS,
            profile: profileForProvider(SETTINGS, id),
            hooks,
            logger,
            withFinal: true,
          }),
        ]),
      ),
      decide: (who) => decide(ai.resolver, ai.policy, who),
    };
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  /** The model entry points of every feature, under the payer scope each one runs in. */
  const features: {
    name: string;
    payer: string;
    run: (m: string, kit: ProviderKit, who: Payer) => Promise<unknown>;
  }[] = [
    {
      name: "live transcription of each piece of audio",
      payer: "conversation",
      run: (m, _k, who) =>
        withTranscriber(speech, who, speech.kits.scaleway?.transcriber as never, (t) =>
          t.transcribe({ audio: mp3, language: "en", customGuidancePrompt: m }),
        ),
    },
    {
      name: "conversation summary, title and tags",
      payer: "conversation",
      run: (m, k) =>
        generateText({ model: k.models.model("multi_modal_pro"), prompt: `summary ${m}` }),
    },
    {
      name: "chat title",
      payer: "chat",
      run: (m, k) => generateTitle(k.models, `question ${m}`, "en"),
    },
    {
      name: "chat reply, streamed",
      payer: "chat",
      run: async (m, k) => {
        const s = streamText({ model: k.models.model("multi_modal_pro"), prompt: `reply ${m}` });
        for await (const _ of s.textStream) void _;
      },
    },
    {
      name: "agentic run turn",
      payer: "agent_run",
      run: async (m, k) => {
        const s = streamText({ model: k.models.model("text_fast"), prompt: `turn ${m}` });
        for await (const _ of s.textStream) void _;
      },
    },
    {
      name: "report summary",
      payer: "report",
      run: (m, k) => k.completer.complete({ group: "multi_modal_pro", user: `report ${m}` }),
    },
    {
      name: "map title",
      payer: "project",
      run: (m, k) =>
        k.completer.complete({ group: "multi_modal_fast", user: `title ${m}`, thinkingBudget: 0 }),
    },
    {
      name: "analysis recipe",
      payer: "analysis_run",
      run: (m, k) =>
        k.completer.complete({
          group: "multi_modal_fast",
          user: `recipe ${m}`,
          jsonSchema: { type: "object" },
        }),
    },
    {
      name: "embeddings of analysis objects",
      payer: "analysis_run",
      run: async (m, k) => {
        await k.embedder.embed(`argument ${m}`);
        await k.models.embedding().model.doEmbed({ values: [`argument ${m}`] });
        await k.embedder.identity?.();
      },
    },
    {
      name: "verify",
      payer: "verify_artifact",
      run: (m, k) =>
        generateText({ model: k.models.model("multi_modal_pro"), prompt: `verify ${m}` }),
    },
    {
      name: "canvas tick",
      payer: "canvas",
      run: (m, k) => k.completer.complete({ group: "multi_modal_fast", user: `canvas ${m}` }),
    },
    {
      name: "popcorn tick",
      payer: "popcorn_loop",
      run: (m, k) => k.completer.complete({ group: "multi_modal_fast", user: `popcorn ${m}` }),
    },
    {
      name: "model identity recorded with a run",
      payer: "project",
      run: (_m, k) => completerIdentity(k.completer, "multi_modal_fast"),
    },
  ];

  test("every feature's model path reaches only the provider of the project it is for", async () => {
    for (const f of features) {
      for (const who of [S, G] as const) {
        const key = who === S ? "s" : "g";
        const payer = { ref: f.payer, id: ids[f.payer]?.[key] } as Payer;
        await withPayer(payer, () => f.run(who.marker, kit, payer));
      }
    }
    await recorder.flush();

    // The wire: Google's endpoints saw only the Google project; Scaleway's only the other one.
    const text = (r: { body: string }) => r.body;
    expect(wire.seen.vertex.length).toBeGreaterThan(5);
    expect(wire.seen.vertex.map(text).some((b) => b.includes(S.marker))).toBe(false);
    expect(wire.seen.compat.filter((r) => r.body.includes(G.marker)).map((r) => r.url)).toEqual([]);
    expect(wire.seen.compat.length).toBeGreaterThan(5);

    // The database: no row for a project on Scaleway names Vertex; every Google row names the project's
    // organisation and says why; and the daily check finds nothing to alert on.
    const rows = await sql<
      {
        project_id: string;
        provider: string;
        routed_provider: string;
        routing_reason: string;
        organisation_id: string;
      }[]
    >`select project_id::text, provider, routed_provider, routing_reason, organisation_id::text from model_call`;
    const ofS = rows.filter((r) => r.project_id === S.project);
    const ofG = rows.filter((r) => r.project_id === G.project);
    expect(ofS.length).toBeGreaterThan(5);
    expect(ofG.length).toBeGreaterThan(5);
    expect(
      ofS.every((r) => r.provider === "openai-compatible" && r.routed_provider === "scaleway"),
    ).toBe(true);
    expect(ofG.every((r) => r.provider === "vertex" && r.routed_provider === "google")).toBe(true);
    expect(rows.every((r) => r.organisation_id === S.org)).toBe(true);
    expect(new Set(ofG.map((r) => r.routing_reason))).toEqual(new Set(["project"]));
    expect(
      await sql`select 1 from model_call where provider = 'vertex' and project_id = ${S.project}`,
    ).toHaveLength(0);
    expect(
      await runProviderCheck({
        db,
        logger,
        alerts: null,
        now: () => new Date(),
        defaultProvider: "scaleway",
      }),
    ).toEqual({ leaks: 0 });
  });

  test("project setup has no project yet: it follows the account's default, and its search lookup is off for a Scaleway default", async () => {
    const workspace = { ref: "workspace", id: ids.workspace?.s as string } as const;
    const before = wire.seen.vertex.length;
    await withPayer(workspace, () =>
      kit.completer.complete({ group: "multi_modal_fast", user: "setup marker-setup" }),
    );
    expect(wire.seen.vertex.length).toBe(before);
    expect(wire.seen.compat.at(-1)?.body).toContain("marker-setup");
    expect(await withPayer(workspace, () => kit.completer.grounds?.())).toBe(false);
  });

  test("search grounding exists for the project on Google and is refused for the other", async () => {
    const ground = (who: typeof S, key: "s" | "g") =>
      withPayer({ ref: "project", id: ids.project?.[key] as string }, () =>
        kit.completer.complete({
          group: "multi_modal_fast",
          user: `check ${who.marker}`,
          googleSearch: true,
        }),
      );
    const seen = wire.seen.vertex.length;
    await expect(ground(S, "s")).rejects.toThrow(/search grounding/);
    expect(wire.seen.vertex.length).toBe(seen);
    expect((await ground(G, "g")).text).toContain("heard");
    const groundsFor = (key: "s" | "g") =>
      withPayer({ ref: "project", id: ids.project?.[key] as string }, () =>
        kit.completer.grounds?.(),
      );
    expect(await groundsFor("s")).toBe(false);
    expect(await groundsFor("g")).toBe(true);
  });

  test("a call with no payer, or an internal one, goes to the default provider", async () => {
    const before = wire.seen.vertex.length;
    await kit.completer.complete({ group: "text_fast", user: "no payer marker-x" });
    await withPayer({ internal: "demo_build" }, () =>
      kit.completer.complete({ group: "text_fast", user: "internal marker-y" }),
    );
    expect(wire.seen.vertex.length).toBe(before);
  });

  test("the Google project moves back to Scaleway and its very next call goes there", async () => {
    const before = wire.seen.vertex.length;
    await sql`update project set ai_provider = 'scaleway' where id = ${G.project}`;
    await withPayer({ ref: "project", id: G.project }, () =>
      kit.completer.complete({ group: "text_fast", user: `after the switch ${G.marker}` }),
    );
    expect(wire.seen.vertex.length).toBe(before);
    expect(wire.seen.compat.at(-1)?.body).toContain("after the switch");
  });
});
