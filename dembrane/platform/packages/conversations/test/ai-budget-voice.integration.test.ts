import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import {
  AI_SPEND_KEY,
  add,
  allowanceForWorkspace,
  invalidateFreeLimits,
  usedThisPeriod,
} from "@dembrane/allowance";
import type { Media } from "@dembrane/audio";
import { errorBody, newId, PlatformError, RateLimitedError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { type Payer, payer } from "@dembrane/observability";
import { type Limit, MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { FakeTranscriber, type TranscribeInput } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import { AudioUrls } from "../src/audio-urls";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { statelessRoutes } from "../src/stateless/routes";
import { admin, freshDatabase, quiet } from "./pipeline-harness";

const run = admin ? describe : describe.skip;
const LIMIT = 5_000_000;

class PayerTranscriber extends FakeTranscriber {
  readonly payers: (Payer | undefined)[] = [];
  override transcribe(input: TranscribeInput) {
    this.payers.push(payer());
    return super.transcribe(input);
  }
}

run("AI budget: voice input", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;
  let d: ConversationsDeps;
  const transcriber = new PayerTranscriber();
  const people = new Map<string, Signed>();
  let limiter = new RateLimiter(new MemoryRateCounter());

  beforeAll(async () => {
    const url = await freshDatabase("conv_ai_budget_voice_test");
    database = createDb({ url, poolMax: 4 });
    sql = postgres(url, { max: 2, onnotice: () => {} });
    d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: new FilesystemStorage(
        mkdtempSync(join(tmpdir(), "ai-budget-voice-")),
        "http://t",
        "/a",
      ),
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      jobs: { enqueue: async () => null },
      models: {} as ConversationsDeps["models"],
      media: { probeUrl: async () => ({ format: { duration: "30" } }) } as unknown as Media,
      transcriber,
      hub: null,
      get limiter() {
        return limiter;
      },
      logger: quiet,
      tokens: new ParticipantTokens("s".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: false,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      now: () => new Date(),
    };
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", people.get(c.req.header("x-as") ?? "") ?? null);
      await next();
    });
    app.route("/", statelessRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json(errorBody(err), err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });
  beforeEach(() => invalidateFreeLimits());

  async function person(): Promise<string> {
    const who: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
    await sql`insert into app_user (id, directus_user_id) values (${who.appUserId}, ${who.directusUserId})`;
    const key = newId();
    people.set(key, who);
    return key;
  }

  async function account(role = "member") {
    const org = newId();
    const acc = newId();
    const ws = newId();
    const p = newId();
    await sql`insert into org (id, name) values (${org}, 'O')`;
    await sql`insert into billing_account (id, org_id, tier) values (${acc}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${acc})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, created_at)
      values (${p}, 'P', 'en', ${ws}, true, now())`;
    const as = await person();
    await sql`insert into workspace_membership (id, workspace_id, user_id, role)
      values (${newId()}, ${ws}, ${people.get(as)?.appUserId as string}, ${role})`;
    return { ws, p, as };
  }

  async function spend(ws: string) {
    const a = await allowanceForWorkspace(d.db, ws, new Date());
    if (!a) throw new Error("expected a free account");
    await add(d.db, a, AI_SPEND_KEY, LIMIT);
  }

  async function audioUsed(ws: string) {
    const a = await allowanceForWorkspace(d.db, ws, new Date());
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(d.db, a)).audio_seconds;
  }

  async function voice(as: string, form: Record<string, string>) {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" }));
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    const before = transcriber.calls.length;
    const res = await app.request("/api/stateless/transcribe", {
      method: "POST",
      headers: { "x-as": as },
      body: fd,
    });
    const body = (await res.json()) as {
      code?: string;
      detail?: { code?: string; limit?: string };
    };
    return {
      status: res.status,
      limit: body.detail?.limit,
      code: body.detail?.code ?? body.code,
      transcribed: transcriber.calls.length - before,
      payer: transcriber.calls.length > before ? transcriber.payers.at(-1) : undefined,
    };
  }

  test("a free project below the limit transcribes, spending no audio hours", async () => {
    const { ws, p, as } = await account();
    const r = await voice(as, { project_id: p });
    expect({ ...r, used: await audioUsed(ws) }).toMatchObject({
      status: 200,
      transcribed: 1,
      payer: { ref: "project", id: p },
      used: 0,
    });
  });

  test("a free project at zero is refused with ai_budget", async () => {
    const { ws, p, as } = await account();
    await spend(ws);
    expect(await voice(as, { project_id: p })).toMatchObject({
      status: 402,
      limit: "ai_budget",
      transcribed: 0,
    });
  });

  test("an issue report in a free project at zero transcribes and the project pays", async () => {
    const { ws, p, as } = await account();
    await spend(ws);
    const r = await voice(as, { project_id: p, purpose: "issue_report" });
    expect({ ...r, used: await audioUsed(ws) }).toMatchObject({
      status: 200,
      transcribed: 1,
      payer: { ref: "project", id: p },
      used: 0,
    });
  });

  test("an issue report with a project is rate limited per person, as without one", async () => {
    const { p, as } = await account();
    const checked: string[] = [];
    const real = limiter;
    limiter = {
      async check(limit: Limit, identifier: string) {
        checked.push(`${limit.name}:${identifier}`);
        throw new RateLimitedError("rate_limit.exceeded");
      },
    } as unknown as RateLimiter;
    try {
      const refused = await voice(as, { project_id: p, purpose: "issue_report" });
      const plain = await voice(as, { project_id: p });
      expect({ refused, plain: plain.status, checked }).toMatchObject({
        refused: { status: 429, transcribed: 0 },
        plain: 200,
        checked: [`issue_report_transcription:${people.get(as)?.directusUserId}`],
      });
    } finally {
      limiter = real;
    }
  });

  test("an issue report with a workspace at zero transcribes and the workspace pays", async () => {
    const { ws, as } = await account();
    await spend(ws);
    expect(await voice(as, { purpose: "issue_report", workspace_id: ws })).toMatchObject({
      status: 200,
      transcribed: 1,
      payer: { ref: "workspace", id: ws },
    });
  });

  test("the pricing form with a workspace at zero is refused with ai_budget", async () => {
    const { ws, as } = await account();
    await spend(ws);
    expect(await voice(as, { purpose: "pricing_intake", workspace_id: ws })).toMatchObject({
      status: 402,
      limit: "ai_budget",
      transcribed: 0,
    });
  });

  test("the pricing form below the limit bills the workspace", async () => {
    const { ws, as } = await account();
    expect(await voice(as, { purpose: "pricing_intake", workspace_id: ws })).toMatchObject({
      status: 200,
      payer: { ref: "workspace", id: ws },
    });
  });

  test("a billing-only member is still in the workspace it pays for", async () => {
    const { ws, as } = await account("billing");
    expect(await voice(as, { purpose: "issue_report", workspace_id: ws })).toMatchObject({
      status: 200,
      payer: { ref: "workspace", id: ws },
    });
  });

  test("without a workspace an issue report stays internal", async () => {
    const { as } = await account();
    expect(await voice(as, { purpose: "issue_report" })).toMatchObject({
      status: 200,
      payer: { internal: "voice_without_project" },
    });
  });

  test("the pricing form without a workspace bills the caller's own workspace", async () => {
    const { ws, as } = await account();
    expect(await voice(as, { purpose: "pricing_intake" })).toMatchObject({
      status: 200,
      transcribed: 1,
      payer: { ref: "workspace", id: ws },
    });
  });

  test("the pricing form without a workspace at zero is refused with ai_budget", async () => {
    const { ws, as } = await account();
    await spend(ws);
    expect(await voice(as, { purpose: "pricing_intake" })).toMatchObject({
      status: 402,
      limit: "ai_budget",
      transcribed: 0,
    });
  });

  test("the pricing form picks the caller's default workspace over another", async () => {
    const { ws: other, as } = await account();
    const own = await account();
    const me = people.get(as)?.appUserId as string;
    await sql`update workspace set is_default = true where id = ${own.ws}`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role)
      values (${newId()}, ${own.ws}, ${me}, 'owner')`;
    await spend(other);
    expect(await voice(as, { purpose: "pricing_intake" })).toMatchObject({
      status: 200,
      payer: { ref: "workspace", id: own.ws },
    });
  });

  test("the pricing form from someone with no workspace is refused", async () => {
    const nobody = await person();
    expect(await voice(nobody, { purpose: "pricing_intake" })).toMatchObject({
      status: 403,
      code: "access.not_onboarded",
      transcribed: 0,
    });
  });

  test("a workspace the caller can't view is refused with 403", async () => {
    const { ws } = await account();
    const stranger = await person();
    for (const workspace_id of [ws, "not-a-uuid"])
      expect(await voice(stranger, { purpose: "issue_report", workspace_id })).toMatchObject({
        status: 403,
        transcribed: 0,
      });
  });
});
