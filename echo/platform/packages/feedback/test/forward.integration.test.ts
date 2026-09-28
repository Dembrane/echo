import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { createDb, schema } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import { runForwardSupport, type SupportForwarder, supportOutbox } from "../src";

// Runs on a copy of the parity template when TEST_PARITY_ADMIN_URL points at its server.
const admin = process.env.TEST_PARITY_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `support_forward_test_${process.pid}`;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}` : "";
const WS = "c0000000-0000-4000-8000-000000000001";
const ORG = "b0000000-0000-4000-8000-000000000001";
const id = (n: number) => `5e000000-0000-4000-8000-00000000000${n}`;

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("support outbox", () => {
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
    await database.db.insert(schema.support_request).values([
      // Oldest first: a real workspace, so the row carries its organisation.
      {
        id: id(1),
        message: "the report is empty",
        source: "agentic_chat",
        workspace_id: WS,
        project_id: "p1",
        status: "new",
        created_at: "2026-09-28T10:00:00Z",
      },
      // A malformed workspace id must not fail the batch.
      {
        id: id(2),
        message: "cannot upload",
        source: "dashboard",
        workspace_id: "not-a-uuid",
        status: "new",
        created_at: "2026-09-28T10:01:00Z",
      },
      // Handled by the team already, and delivered before: neither goes again.
      { id: id(3), message: "x", status: "resolved", created_at: "2026-09-28T10:02:00Z" },
      {
        id: id(4),
        message: "y",
        status: "new",
        forwarded_at: "2026-09-28T09:00:00Z",
        created_at: "2026-09-28T10:03:00Z",
      },
    ]);
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("posts each new request once, oldest first, with its organisation, and stamps it", async () => {
    const sent: Record<string, unknown>[] = [];
    const forwarder: SupportForwarder = {
      async post(p) {
        sent.push(p);
        return { status: 200, text: "" };
      },
    };
    const at = new Date("2026-09-28T11:00:00Z");
    const d = {
      outbox: supportOutbox(database.db),
      forwarder,
      environment: "production",
      dashboardUrl: "https://dashboard.dembrane.com",
      logger,
      clock: () => at,
    };
    expect(await runForwardSupport(d)).toBe(2);
    expect(sent.map((p) => p.id)).toEqual([id(1), id(2)]);
    expect(sent[0]).toMatchObject({
      org_id: ORG,
      origin_link: `https://dashboard.dembrane.com/en-US/w/${WS}/projects/p1`,
    });
    expect(sent[1]?.org_id).toBeUndefined();
    // A second run finds nothing: the stamp is what keeps a request from reaching sam twice.
    expect(await runForwardSupport(d)).toBe(0);
    expect(sent).toHaveLength(2);

    // Stamping again keeps the first delivery time.
    await d.outbox.markForwarded(id(1), new Date("2026-09-28T12:00:00Z"));
    const rows = await database.db
      .select({ id: schema.support_request.id, at: schema.support_request.forwarded_at })
      .from(schema.support_request)
      .where(inArray(schema.support_request.id, [id(1), id(3), id(4)]))
      .orderBy(schema.support_request.id);
    expect(rows.map((r) => [r.id, r.at && new Date(r.at).toISOString()])).toEqual([
      [id(1), at.toISOString()],
      [id(3), null],
      [id(4), "2026-09-28T09:00:00.000Z"],
    ]);
  });
});
