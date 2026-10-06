import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import type { Access, Policy } from "@dembrane/access";
import { ForbiddenError } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { type PopcornDeps, popcornDeps, publicRoutes } from "@dembrane/popcorn";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { freshDatabase } from "../../popcorn/test/fixtures/tick/seed";
import type { MapStore } from "../src/map";
import { presentRoutes, publicAudienceMap } from "../src/routes";
import { ensureDefault } from "../src/service";

// The host's draft against Postgres: what "Show them" publishes, and what the draft says
// afterwards. Needs a scratch Postgres: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const USER = "d2000000-0000-4000-8000-000000000001";
const APP_USER = "a2000000-0000-4000-8000-000000000001";
const project = (n: number) => `f2000000-0000-4000-8000-00000000000${n}`;

type Draft = {
  revision: number;
  has_changes: boolean;
  presentation: { settings: Record<string, unknown> };
};

run("the presentation draft after Show them", () => {
  let database: ReturnType<typeof createDb>;
  let d: PopcornDeps;
  const ticks: string[] = [];
  // The workspace's plan per project: a free one may not share a public link.
  const tiers = new Map<string, string>();

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "present_draft_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    const sql = database.client;
    await sql`insert into directus_users (id, email) values (${USER}, 'present@example.com')`;
    await sql`insert into app_user (id, directus_user_id) values (${APP_USER}, ${USER})`;
    const logger = createLogger(
      { service: "t", release: "r", env: "test", level: "error" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    );
    d = popcornDeps({
      db: database.db,
      deck: {
        deckObjects: async () => ({}),
        excludedObjectIds: async () => new Set<string>(),
        currentDeck: async () => null,
        assembleDeck: async () => null,
        owns: async () => true,
      } as unknown as PopcornDeps["deck"],
      flags: { present: true, canvas: false },
      participantBaseUrl: "http://portal.test",
      adminBaseUrl: "http://dashboard.test",
      showFlow: false,
      dispatchTick: async (_tx, request) => {
        ticks.push(request.tickKind);
      },
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger,
    });
  });
  afterAll(async () => {
    await database?.close();
  });

  const app = () => {
    const access = {
      project: async (_who: unknown, projectId: string, policy: Policy) => {
        const tier = tiers.get(projectId) ?? "innovator";
        if (policy === "project:share" && tier === "free")
          throw new ForbiddenError("billing.tier_required", {
            params: { required: "innovator", tier },
          });
        return { tier, role: "owner", source: "workspace", extra: [], project: {} };
      },
    } as unknown as Access;
    const a = new Hono();
    a.use(async (c, next) => {
      c.set(
        "principal" as never,
        {
          appUserId: APP_USER,
          directusUserId: USER,
          isStaff: false,
        } as never,
      );
      await next();
    });
    a.onError((err, c) =>
      c.json(
        { code: (err as { code?: string }).code },
        ((err as { status?: number }).status ?? 500) as 403,
      ),
    );
    a.route(
      "/",
      presentRoutes({
        ...d,
        access,
        hub: async () => ({}) as never,
        map: { currentSnapshot: async () => null } as unknown as MapStore,
      }),
    );
    return a;
  };

  const presentation = async (n: number, opts: { language?: string; tier?: string } = {}) => {
    const id = project(n);
    await database.client`insert into project (id, name, language, directus_user_id,
      is_conversation_allowed, is_canvas_enabled, anonymize_transcripts, visibility)
      values (${id}, ${`Room ${n}`}, ${opts.language ?? "en"}, ${USER}, true, false, false, 'workspace')`;
    tiers.set(id, opts.tier ?? "innovator");
    const report = await ensureDefault(
      d,
      { id, name: `Room ${n}`, language: opts.language ?? "en" },
      USER,
    );
    return String(report.id);
  };

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app().request(`/api/v2/bff/present/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Draft & { code?: string } };
  };
  const draft = async (id: string) => (await call("GET", `${id}/draft`)).body;
  const save = (id: string, revision: number, patch: unknown) =>
    call("PATCH", `${id}/draft`, { expected_revision: revision, patch });
  const publish = (id: string, revision: number) =>
    call("POST", `${id}/publish`, { expected_revision: revision });

  test("a saved change waits, and after publishing nothing does", async () => {
    const id = await presentation(1);
    expect((await draft(id)).has_changes).toBe(false);
    const saved = await save(id, 0, { title: "Our street", intro: { subtitle: "Tonight" } });
    expect(saved.status).toBe(200);
    expect(saved.body.has_changes).toBe(true);
    const shown = await publish(id, saved.body.revision);
    expect(shown.status).toBe(200);
    expect(shown.body.has_changes).toBe(false);
    const after = await draft(id);
    expect(after.has_changes).toBe(false);
    expect(after.presentation.settings.title).toBe("Our street");
  });

  test("a new translation language publishes, asks for a translation and leaves nothing waiting", async () => {
    const id = await presentation(2, { language: "nl" });
    const saved = await save(id, 0, { language: { translate_to: "en" } });
    expect(saved.body.has_changes).toBe(true);
    ticks.length = 0;
    expect((await publish(id, saved.body.revision)).status).toBe(200);
    expect(ticks).toEqual(["translation"]);
    expect((await draft(id)).has_changes).toBe(false);
  });

  test("going public on a plan that may share publishes, and nothing waits", async () => {
    const id = await presentation(3, { tier: "innovator" });
    const saved = await save(id, 0, { public: true, title: "Open room" });
    expect(saved.status).toBe(200);
    expect((await publish(id, saved.body.revision)).status).toBe(200);
    const after = await draft(id);
    expect(after.has_changes).toBe(false);
    expect(after.presentation.settings.public).toBe(true);
  });

  test("going public on a plan that may not share is refused at the save, so the draft never holds it", async () => {
    const id = await presentation(4, { tier: "free" });
    const saved = await save(id, 0, { title: "Closed room" });
    const refused = await save(id, saved.body.revision, { public: true });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("billing.tier_required");
    const held = await draft(id);
    expect(held.presentation.settings.public).toBe(false);
    expect(held.revision).toBe(saved.body.revision);
    // The change that was waiting can still be shown.
    expect((await publish(id, held.revision)).status).toBe(200);
    expect((await draft(id)).has_changes).toBe(false);
  });

  test("the public map route carries the project's groups, never who made them", async () => {
    const id = await presentation(5, { tier: "innovator" });
    const saved = await save(id, 0, {
      public: true,
      presentation: { blocks: ["popcorn", "map"], hidden_items: ["o4"] },
    });
    expect(saved.status).toBe(200);
    expect((await publish(id, saved.body.revision)).status).toBe(200);
    const report = await d.store.report(id);
    const token = String(report?.public_token ?? "");
    expect(token.length).toBeGreaterThan(15);

    const member = (i: number) => ({ revisionId: `r${i}`, objectId: `o${i}`, type: "argument" });
    const group = (gid: string, status: string, members: number[]) => ({
      id: gid,
      project_id: project(5),
      snapshot_id: "s1",
      members: members.map(member),
      status,
      title: status === "ready" ? "Shared housing costs" : null,
      error: status === "failed" ? "Interrupted" : null,
      requested_by: USER,
      created_at: "2026-10-06 10:00:00+00",
    });
    const map = {
      ceilings: { nodeLimit: null, edgeLimit: null },
      snapshot: async () => null,
      currentSnapshot: async () => ({ id: "s1", projectId: project(5), createdAt: null }),
      legacyResults: async () => [],
      graph: async () => ({
        payload: {
          version: 2,
          snapshot: { id: "s1", createdAt: null },
          nodes: [1, 2, 3, 4].map((i) => ({
            objectId: `o${i}`,
            revisionId: `r${i}`,
            type: "argument",
            label: `Argument ${i}`,
            embedding: [i, 0],
            detail: {},
          })),
        },
        factChecks: {},
      }),
      legacyGraph: async () => null,
      requestGeneration: async () => {},
      groups: async () => [
        group("g1", "ready", [1, 2, 3]),
        group("g2", "pending", [1, 2]),
        group("g3", "failed", [2, 3]),
        group("g4", "ready", [2, 3, 4]),
      ],
    } as unknown as MapStore;
    const pub = new Hono();
    pub.onError((err, c) =>
      c.json(
        { code: (err as { code?: string }).code },
        ((err as { status?: number }).status ?? 500) as 403,
      ),
    );
    pub.route(
      "/",
      publicRoutes({
        ...d,
        hub: async () => ({}) as never,
        audienceMap: publicAudienceMap({ ...d, map }),
      }),
    );
    const res = await pub.request(`/api/v2/popcorn/public/${token}/map`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Record<string, unknown>[] };
    // g4 is over the argument the presenter hid.
    expect(body.groups.map((g) => [g.id, g.status, g.title])).toEqual([
      ["g1", "ready", "Shared housing costs"],
      ["g2", "pending", null],
      ["g3", "failed", null],
    ]);
    for (const g of body.groups) {
      expect(g).not.toHaveProperty("requested_by");
      expect(g).not.toHaveProperty("requestedBy");
      expect(g.error).toBeNull();
    }
    expect(JSON.stringify(body.groups)).not.toContain(USER);
  });
});
