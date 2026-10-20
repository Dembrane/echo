import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import type { Access } from "@dembrane/access";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { type PopcornDeps, popcornAllowance, popcornDeps } from "@dembrane/popcorn";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { updateSettings } from "../../popcorn/src/service";
import { freshDatabase } from "../../popcorn/test/fixtures/tick/seed";
import type { MapStore } from "../src/map";
import { presentRoutes } from "../src/routes";
import { ensureDefault } from "../src/service";

// The host sees the free analyses run out; the presented screen never does.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const USER = "d2000000-0000-4000-8000-0000000000f1";
const APP_USER = "a2000000-0000-4000-8000-0000000000f1";

run("free popcorn on the presented screen", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let d: PopcornDeps;
  const ticks: string[] = [];

  beforeAll(async () => {
    invalidateFreeLimits();
    const url = await freshDatabase(admin as string, "present_free_audience_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
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
    invalidateFreeLimits();
    await database?.close();
  });

  const app = () => {
    const access = {
      project: async () => ({
        tier: "free",
        role: "owner",
        source: "workspace",
        extra: [],
        project: {},
      }),
    } as unknown as Access;
    const a = new Hono();
    a.use(async (c, next) => {
      c.set(
        "principal" as never,
        { appUserId: APP_USER, directusUserId: USER, isStaff: false } as never,
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

  const get = async (path: string, method = "GET") => {
    const res = await app().request(`/api/v2/bff/present/${path}`, { method });
    return { status: res.status, text: await res.text() };
  };

  test("the audience sees nothing of the free limit", async () => {
    const sql = database.client;
    const [org, billing, ws, projectId] = [newId(), newId(), newId(), newId()];
    await sql`insert into directus_users (id, email) values (${USER}, 'free@example.com')`;
    await sql`insert into app_user (id, directus_user_id) values (${APP_USER}, ${USER})`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${projectId}, 'Room', 'en', ${ws}, true, false, false, 'workspace')`;
    const report = await ensureDefault(d, { id: projectId, name: "Room", language: "en" }, USER);
    await updateSettings(d, report, {
      presentation: { blocks: ["popcorn", "tensions", "stakeholders"] },
    });
    const pop = popcornAllowance(database.db);
    for (let i = 0; i < 12; i++) await pop.admit(projectId, new Date());

    const host = await get(`projects/${projectId}`);
    expect(host.status).toBe(200);
    const presentation = (JSON.parse(host.text) as { presentation: Record<string, unknown> })
      .presentation;
    expect((presentation.free_popcorn as { exhausted: boolean }).exhausted).toBe(true);

    const id = String(report.id);
    for (const path of [`${id}/audience`, `${id}/deck/data/bundle.json`, `${id}/deck/`]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      for (const word of ["free_popcorn", "FREE_TIER", "upgrade", "exhausted"])
        expect({ path, found: res.text.includes(word) }).toEqual({ path, found: false });
    }

    const prepared = await get(`${id}/prepare/tensions`, "POST");
    expect(prepared.status).toBe(200);
    expect(JSON.parse(prepared.text)).toEqual({ status: "queued" });
  });
});
