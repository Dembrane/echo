import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  closeFinishedEpisodes,
  type Forwarder,
  filePendingNotifications,
  observeOverage,
} from "../src";
import { logger } from "./helpers";

// Runs on a copy of the parity template when TEST_PARITY_ADMIN_URL points at its server.
const admin = process.env.TEST_PARITY_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `overage_test_${process.pid}`;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}` : "";
const ACC = "ba000000-0000-4000-8000-000000000001";
const PROJECT = "f0000000-0000-4000-8000-000000000001";

run("recording overage episodes", () => {
  setDefaultTimeout(30_000);
  let database: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    for (let i = 0; ; i++) {
      try {
        await a.unsafe(
          `create database ${dbName} template ${process.env.PARITY_TEMPLATE ?? "parity_template_platform"}`,
        );
        break;
      } catch (e) {
        if (i > 20) throw e;
        await Bun.sleep(500);
      }
    }
    await a.end();
    database = createDb({ url, poolMax: 4 });
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const episodes = () => database.db.select().from(schema.recording_overage);
  const t = (m: number) => new Date(Date.UTC(2026, 8, 27, 10, m));

  test("opens once above the cap, raises the peak, closes after the quiet window, reopens within it", async () => {
    const db = database.db;
    await observeOverage(
      db,
      { accountId: ACC, cap: 3, count: 3, projectId: PROJECT },
      t(0),
      logger,
    );
    expect(await episodes()).toHaveLength(0);
    await Promise.all(
      [4, 5, 4].map((count) =>
        observeOverage(db, { accountId: ACC, cap: 3, count, projectId: PROJECT }, t(0), logger),
      ),
    );
    let [e] = await episodes();
    expect(await episodes()).toHaveLength(1);
    expect(e).toMatchObject({
      cap: 3,
      peak: 5,
      excess: 2,
      opened_by_project_id: PROJECT,
      ended_at: null,
    });

    let live = 2;
    const counter = { countActive: async () => live };
    const quiet = new Map<string, Date>();
    expect(await closeFinishedEpisodes(db, counter, quiet, t(1), logger)).toBe(0); // clock starts
    expect(await closeFinishedEpisodes(db, counter, quiet, t(4), logger)).toBe(0); // 3 minutes quiet
    live = 6;
    expect(await closeFinishedEpisodes(db, counter, quiet, t(5), logger)).toBe(0); // over again: clock void
    live = 1;
    await closeFinishedEpisodes(db, counter, quiet, t(6), logger);
    expect(await closeFinishedEpisodes(db, counter, quiet, t(11), logger)).toBe(1);
    [e] = await episodes();
    expect(e?.ended_at).not.toBeNull();

    // A ping inside the quiet window revives the same episode instead of a second row.
    await observeOverage(
      db,
      { accountId: ACC, cap: 3, count: 7, projectId: PROJECT },
      t(13),
      logger,
    );
    const rows = await episodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ended_at: null, peak: 7, excess: 4 });
  });

  test("notices go out once per opening and closing, stamped only on delivery", async () => {
    const db = database.db;
    const sent: Record<string, unknown>[] = [];
    let status = 503;
    const fwd: Forwarder = {
      post: async (p) => {
        sent.push(p);
        return { status, text: "" };
      },
    };
    const env = { environment: "echo-next", dashboardUrl: "https://dash.test/" };
    expect(await filePendingNotifications(db, null, env, t(20), logger)).toBe(0);
    expect(await filePendingNotifications(db, fwd, env, t(20), logger)).toBe(0); // receiver down
    status = 200;
    expect(await filePendingNotifications(db, fwd, env, t(21), logger)).toBe(1);
    const opened = sent.at(-1) as Record<string, string>;
    expect(opened.id).toEndWith(":opened");
    expect(opened.environment).toBe("echo-next");
    expect(opened.message).toBe(
      "Concurrent recording cap exceeded. Account ba000000-0000-4000-8000-000000000001 on changemaker has 7 recordings, cap 3. Since 2026-09-27 10:00 UTC.",
    );
    expect(opened.project_id).toBe(PROJECT);
    expect(await filePendingNotifications(db, fwd, env, t(22), logger)).toBe(0);

    const [e] = await episodes();
    await db
      .update(schema.recording_overage)
      .set({ ended_at: "2026-09-27T10:30:00+00:00" })
      .where(eq(schema.recording_overage.id, e?.id as string));
    status = 422;
    expect(await filePendingNotifications(db, fwd, env, t(31), logger)).toBe(0); // rejected, stays pending
    status = 200;
    expect(await filePendingNotifications(db, fwd, env, t(32), logger)).toBe(1);
    const closed = sent.at(-1) as Record<string, string>;
    expect(closed.id).toBe(`${e?.id}:closed:20260927T103000`);
    expect(closed.message).toContain(
      "peaked at 7 recordings, cap 3, 4 over, from 2026-09-27 10:00 to 2026-09-27 10:30 UTC.",
    );
    expect(await filePendingNotifications(db, fwd, env, t(33), logger)).toBe(0);
  });
});
