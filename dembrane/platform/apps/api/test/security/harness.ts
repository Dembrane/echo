import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore, DrizzleStaffAudit } from "@dembrane/access";
import { codeSignInGate } from "@dembrane/accounts";
import { LocalMedia } from "@dembrane/audio";
import { createAuth, identityAccount } from "@dembrane/auth";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { loadConfig, publicValues } from "@dembrane/config";
import { newId } from "@dembrane/core";
import { createDb, schema } from "@dembrane/db";
import type { Models } from "@dembrane/llm";
import { MemoryMailer } from "@dembrane/mail";
import { Notifier } from "@dembrane/notifications";
import { createLogger, initTracing } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { FakeTranscriber } from "@dembrane/transcription";
import postgres from "postgres";
import { buildApp } from "../../src/app";
import type { Deps } from "../../src/deps";
import { principalLookup } from "../../src/principals";

/**
 * The whole API, as main.ts wires it, on a copy of the parity template: real Better Auth
 * (bearer sessions minted per fixture user), the real access resolver and every route.
 * The security suite fires each known hole's exploit at it. Runs when
 * TEST_PARITY_ADMIN_URL points at the parity Postgres (legacy/parity/README.md).
 */
export const adminUrl = process.env.TEST_PARITY_ADMIN_URL;

const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

/** Mirrors legacy/parity/fixtures.ts. */
export const U = {
  admin: { directus: id("d0", 1), app: id("a0", 1), email: "parity-admin@example.com" },
  alice: { directus: id("d0", 2), app: id("a0", 2), email: "alice.parity@example.com" },
  bob: { directus: id("d0", 3), app: id("a0", 3), email: "bob.parity@example.com" },
  erin: { directus: id("d0", 4), app: id("a0", 4), email: "erin.parity@example.com" },
  rita: { directus: id("d0", 5), app: id("a0", 5), email: "rita.parity@example.com" },
  dave: { directus: id("d0", 6), app: null, email: "dave.parity@example.com" },
} as const;
export type Who = keyof typeof U | "anonymous";

export const ORG = { a: id("b0", 1), b: id("b0", 2) } as const;
export const ACCOUNT = { a: id("ba", 1), b: id("ba", 2) } as const;
export const WS = { aDefault: id("c0", 1), aResearch: id("c0", 2), bDefault: id("c0", 3) };
/** p1 in org A Default, p2 in org A Research (bob external, rita observer), p3 in org B. */
export const P = { p1: id("f0", 1), p2: id("f0", 2), p3: id("f0", 3), legacy: id("f0", 4) };
/** c1, c2 in p1; c3 in p3. */
export const C = { c1: id("c1", 1), c2: id("c1", 2), c3: id("c1", 3) };
export const CHAT_P1 = id("c3", 1);
export const WEBHOOK_P1 = id("f1", 1);
export const TAG = { p1Energy: id("f2", 1), p1Mobility: id("f2", 2) };
/** The seeded published report on p1. */
export const REPORT_P1 = 1;

const silent = new Writable({ write: (_c, _e, cb) => cb() });

export interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly sql: postgres.Sql;
  readonly deps: Deps;
  readonly mailer: MemoryMailer;
  /** Raw request as a fixture user (bearer session) or anonymous. */
  req(
    who: Who,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** Bearer token of a fixture user. */
  token(who: Exclude<Who, "anonymous">): string;
  close(): Promise<void>;
}

export async function startHarness(
  name: string,
  env: Record<string, string> = {},
): Promise<Harness> {
  const admin = adminUrl as string;
  const dbName = `${name}_${process.pid}`;
  const url = `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}`;
  const a = postgres(admin, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${dbName} with (force)`);
  for (let i = 0; ; i++) {
    try {
      await a.unsafe(
        `create database ${dbName} template ${process.env.PARITY_TEMPLATE ?? "parity_template_platform"}`,
      );
      break;
    } catch (e) {
      // The parity runner may be copying the same template this instant.
      if (i > 20) throw e;
      await Bun.sleep(500);
    }
  }
  await a.end();

  const loaded = loadConfig({
    APP_ENV: "test",
    DATABASE_URL: url,
    AUTH_SECRET: "s".repeat(48),
    INVITE_HASH_SECRET: "i".repeat(32),
    ...env,
  });
  const config = loaded.values;
  const database = createDb({ url, poolMax: 6 });
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  const logger = createLogger({ service: "t", release: "r", env: "test", level: "error" }, silent);
  const mailer = new MemoryMailer();
  const auth = createAuth({
    db: database.db,
    secret: config.auth.secret,
    baseURL: config.http.publicUrl,
    trustedOrigins: [config.http.dashboardUrl, config.http.portalUrl],
    secureCookies: false,
    codeSignInAllowed: codeSignInGate({ db: database.db, now: () => new Date() }),
    sendCode: async (email, code) => {
      await mailer.send({ to: email, subject: "code", text: code, html: code, tags: [] });
    },
    defaultDirectusRoleId: null,
  });
  const root = mkdtempSync(join(tmpdir(), "echo-security-"));
  const files = new FilesystemStorage(join(root, "files"), config.http.publicUrl);
  const audio = new FilesystemStorage(join(root, "audio"), config.http.publicUrl, "/_local-audio");
  const noModel = new Proxy(
    {},
    {
      get() {
        throw new Error("no model calls in the security suite");
      },
    },
  );
  const deps: Deps = {
    config,
    publicConfig: publicValues(loaded),
    logger,
    tracer: initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 }).tracer,
    pingDb: database.ping,
    workerFreshness: async () => ({ ageS: 1, jobAgeS: 1 }),
    auth,
    principalFor: principalLookup(database.db),
    access: new Access(new DrizzleAccessStore(database.db)),
    db: database.db,
    models: noModel as Models,
    queue: { enqueue: async () => null } as unknown as Deps["queue"],
    deliverWebhook: async () => ({ status: 200, text: "" }),
    identity: identityAccount(auth, database.db),
    notifier: new Notifier(database.db, logger),
    limiter: new RateLimiter(new MemoryRateCounter()),
    jobs: { enqueue: async () => null } as unknown as Deps["jobs"],
    files,
    staffAudit: new DrizzleStaffAudit(database.db),
    mailer,
    billing: createBilling({
      db: database.db,
      mollie: new FakeMollie(),
      mailer,
      logger,
      billingConfig: {
        webhookUrl: null,
        forceReconcileFailure: false,
        dashboardUrl: "http://dashboard.test",
      },
    }),
    siteToken: null,
    audio,
    media: new LocalMedia(),
    transcriber: new FakeTranscriber(),
    hub: null,
    fetchText: async () => "",
  };
  const app = buildApp(deps);

  const tokens = new Map<string, string>();
  const now = new Date();
  for (const [key, u] of Object.entries(U)) {
    const token = `sec-${key}-${newId()}`;
    await database.db.insert(schema.auth_session).values({
      id: newId(),
      userId: u.directus,
      token,
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
    });
    tokens.set(key, token);
  }

  return {
    app,
    sql,
    deps,
    mailer,
    token: (who) => tokens.get(who) as string,
    req(who, method, path, body, headers = {}) {
      const h: Record<string, string> = { ...headers };
      if (who !== "anonymous") h.authorization = `Bearer ${tokens.get(who)}`;
      if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
      return Promise.resolve(
        app.request(path, {
          method,
          headers: h,
          ...(body !== undefined && {
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
        }),
      );
    },
    async close() {
      await sql.end();
      await database.close();
    },
  };
}
