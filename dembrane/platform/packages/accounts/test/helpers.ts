import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { deflateSync } from "node:zlib";
import { Access, DrizzleAccessStore, DrizzleStaffAudit } from "@dembrane/access";
import { newId, PlatformError } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage } from "@dembrane/storage";
import { Hono } from "hono";
import postgres from "postgres";
import type { AccountsDeps } from "../src/deps";
import { ensureUser } from "../src/prospect";
import { MemoryJobs } from "../src/sink";

/** A scratch database per test file: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres */
export const admin = process.env.TEST_DATABASE_ADMIN_URL;

export async function freshDatabase(name: string): Promise<string> {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name}`);
  await a.end();
  const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
  await migrate(url, { appEnv: "test" });
  return url;
}

export async function dropDatabase(name: string) {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.end();
}

export const silent = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

export const fixtureHtml = (kind: "terms" | "sla" | "dpa") =>
  Bun.file(new URL(`./fixtures/legal-${kind}.html`, import.meta.url)).text();

/** Serves the captured legal pages; a test can swap a page or make fetching fail. */
export class FakeWeb {
  pages = new Map<string, string>();
  failing = false;
  calls = 0;
  async load() {
    for (const k of ["terms", "sla", "dpa"] as const)
      this.pages.set(`https://www.dembrane.com/legal/${k}`, await fixtureHtml(k));
  }
  fetch = async (url: string) => {
    this.calls++;
    if (this.failing) throw new Error("network unreachable");
    const page = this.pages.get(url);
    if (!page) throw new Error(`404 ${url}`);
    return page;
  };
}

/** A real PNG (w x h, grey), so pdf-lib embeds it. */
export function png(w = 40, h = 16): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x * 7 + y * 13) % 255;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export const pngB64 = () => Buffer.from(png()).toString("base64");

export interface World {
  url: string;
  db: ReturnType<typeof createDb>["db"];
  close: () => Promise<void>;
  deps: AccountsDeps;
  jobs: MemoryJobs;
  web: FakeWeb;
  files: FilesystemStorage;
  clock: { now: Date };
  people: Record<
    "admin" | "billing" | "member" | "outsider" | "staff" | "signer",
    Signed & { email: string }
  >;
  orgId: string;
  otherOrgId: string;
  app: Hono<Env>;
}

/**
 * One organisation with an admin, a billing member and a plain member, an outsider, a
 * staff member, and someone who will be named to sign; another organisation beside it.
 */
export async function world(name: string, routes: (d: AccountsDeps) => Hono<Env>): Promise<World> {
  const url = await freshDatabase(name);
  const database = createDb({ url, poolMax: 4 });
  const db = database.db;
  const clock = { now: new Date("2026-09-28T09:00:00.000Z") };
  const web = new FakeWeb();
  await web.load();
  const jobs = new MemoryJobs();
  const files = new FilesystemStorage(
    mkdtempSync(join(tmpdir(), "accounts-files-")),
    "http://localhost",
  );
  const deps: AccountsDeps = {
    db,
    access: new Access(new DrizzleAccessStore(db)),
    staffAudit: new DrizzleStaffAudit(db),
    jobs,
    files,
    logger: silent,
    now: () => clock.now,
    fetchText: web.fetch,
    settings: {
      dashboardUrl: "https://dash.test",
      company: {
        name: "dembrane B.V.",
        address: "Sint Janssingel 88, ‘s-Hertogenbosch, NL",
        vat: "NL864967433B01",
        kvk: "89391438",
        iban: "NL49 RABO 0318910535",
        bic: "RABONL2U",
        accountName: "Dembrane B.V.",
      },
      eventsEnabled: true,
      slackEnabled: true,
      reminderIntervalDays: 7,
      inviteSecret: "x".repeat(32),
      demo: {
        portalUrl: "https://portal.example.test",
        apiUrl: "https://api.example.test",
        ownUrls: ["https://api.example.test"],
        workspaceId: null,
        feedbackUrl: "https://portal.example.test/en-US/feedback-project/start",
      },
    },
  };
  const nowIso = clock.now.toISOString();
  const adminRole = newId();
  await db.insert(schema.directus_roles).values({ id: adminRole, name: "Administrator" });
  const people = {} as World["people"];
  for (const who of ["admin", "billing", "member", "outsider", "staff", "signer"] as const) {
    const email = `${who}@example.test`;
    const u = await db.transaction((tx) =>
      ensureUser(tx, {
        email,
        name: who,
        passwordHash: null,
        nowIso,
        ...(who === "staff" && { directusRoleId: adminRole }),
      }),
    );
    // A code sign-in verifies the address; these people are signed in.
    await db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where((await import("drizzle-orm")).eq(schema.auth_user.id, u.userId));
    people[who] = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: who === "staff",
      email,
    };
  }
  const orgId = newId();
  const otherOrgId = newId();
  for (const [id, n] of [
    [orgId, "Gemeente Testdorp"],
    [otherOrgId, "Elders BV"],
  ] as const)
    await db.insert(schema.org).values({ id, name: n, account_stage: "prospect" });
  for (const [who, role] of [
    ["admin", "admin"],
    ["billing", "billing"],
    ["member", "member"],
  ] as const)
    await db.insert(schema.org_membership).values({
      id: newId(),
      org_id: orgId,
      user_id: people[who].appUserId as string,
      role,
    });
  await db.insert(schema.org_membership).values({
    id: newId(),
    org_id: otherOrgId,
    user_id: people.outsider.appUserId as string,
    role: "admin",
  });
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    const as = c.req.header("x-as") as keyof World["people"] | undefined;
    c.set("requestId", "req-test");
    c.set("principal", as ? people[as] : null);
    await next();
  });
  app.route("/", routes(deps));
  // The API's handler, as apps/api/src/middleware/errors.ts has it.
  app.onError((err, c) =>
    err instanceof PlatformError
      ? c.json({ detail: err.details ?? err.message }, err.status as 400)
      : c.json({ detail: String(err) }, 500),
  );
  return {
    url,
    db,
    close: database.close,
    deps,
    jobs,
    web,
    files,
    clock,
    people,
    orgId,
    otherOrgId,
    app,
  };
}

/** A JSON request as someone. */
export async function call(
  w: World,
  method: string,
  path: string,
  as: keyof World["people"] | null,
  body?: unknown,
) {
  const res = await w.app.request(path, {
    method,
    headers: {
      ...(as && { "x-as": as }),
      ...(body !== undefined && { "content-type": "application/json" }),
      "user-agent": "accounts-test",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data: data as unknown };
}
