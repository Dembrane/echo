import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb, schema } from "@dembrane/db";
import { initTracing } from "@dembrane/observability";
import { installQueueSchema, Queue } from "@dembrane/queue";
import { deliverSamMessage } from "@dembrane/webhooks";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { AccountsDeps } from "../src/deps";
import {
  ACCOUNT_EVENT_CODES,
  ACCOUNT_EVENTS,
  emit,
  INBOX_ONLY_EVENTS,
  type InboxEvent,
} from "../src/events";
import { deliverEvent, notifySlack } from "../src/jobs";
import { type AccountsJobs, MemoryJobs, queueJobs } from "../src/sink";
import { admin, dropDatabase, freshDatabase, silent } from "./helpers";

const run = admin ? describe : describe.skip;
const NAME = "accounts_sam_inbox_test";
const NOW = new Date("2026-10-02T09:00:00.000Z");

run("account events and sam's inbox", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let queue: Queue;
  const orgId = newId();

  beforeAll(async () => {
    const url = await freshDatabase(NAME);
    await installQueueSchema(url);
    database = createDb({ url, poolMax: 4 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    // Enqueue only, like the API: the rows it writes are what this test reads.
    queue = new Queue(
      url,
      silent,
      initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 }).tracer,
    );
    await queue.start([deliverSamMessage, deliverEvent, notifySlack]);
    await database.db.insert(schema.org).values({ id: orgId, name: "Gemeente Testdorp" });
  });
  afterAll(async () => {
    await queue?.stop();
    await sql?.end();
    await database?.close();
    await dropDatabase(NAME);
  });

  const deps = (jobs: AccountsJobs, samInbox: boolean, eventsEnabled = true) =>
    ({
      db: database.db,
      jobs,
      logger: silent,
      now: () => NOW,
      settings: { eventsEnabled, slackEnabled: true, samInbox },
    }) as unknown as AccountsDeps;

  const fire = (d: AccountsDeps, event: InboxEvent) =>
    d.db.transaction((tx) =>
      emit(d, tx, {
        orgId,
        actor: { kind: "customer", userId: null },
        type: event.replace(/^account\./, ""),
        webhook: { event, org: { id: orgId, name: "Gemeente Testdorp" } },
        slack: `a line about ${event}`,
      }),
    );

  const eventIds = async (type: string) =>
    (
      await database.db
        .select({ id: schema.account_event.id })
        .from(schema.account_event)
        .where(eq(schema.account_event.type, type))
    ).map((r) => r.id);

  test("with the inbox on, each event goes to the inbox under its code and timeline id, with no Slack line", async () => {
    const jobs = new MemoryJobs();
    const d = deps(jobs, true);
    const all = [...ACCOUNT_EVENTS, ...INBOX_ONLY_EVENTS];
    for (const event of all) await fire(d, event);
    expect(jobs.of(deliverEvent.name)).toHaveLength(0);
    expect(jobs.of(notifySlack.name)).toHaveLength(0);
    const sent = jobs.of(deliverSamMessage.name);
    expect(sent.map((m) => m.code)).toEqual([
      "echo_account_document_signed_v1",
      "echo_account_document_declined_v1",
      "echo_account_billing_details_updated_v1",
      "echo_account_task_submitted_v1",
      "echo_account_ticket_opened_v1",
      "echo_account_call_booked_v1",
    ]);
    for (const [i, event] of all.entries()) {
      const m = sent[i] as { code: string; id: string; body: string };
      expect(m.code).toBe(ACCOUNT_EVENT_CODES[event]);
      expect(await eventIds(event.replace(/^account\./, ""))).toContain(m.id);
      // The json is the payload ACCOUNTS_EVENTS_URL gets today.
      expect(JSON.parse(m.body)).toEqual({
        code: m.code,
        json: {
          id: m.id,
          timestamp: NOW.toISOString(),
          event,
          org: { id: orgId, name: "Gemeente Testdorp" },
          account_manager: null,
        },
      });
    }
  });

  test("with the inbox off, events and Slack lines go out exactly as before", async () => {
    const jobs = new MemoryJobs();
    await fire(deps(jobs, false), "account.ticket.opened");
    expect(jobs.of(deliverSamMessage.name)).toHaveLength(0);
    const [delivered] = jobs.of(deliverEvent.name);
    expect(delivered?.payload).toMatchObject({
      timestamp: NOW.toISOString(),
      event: "account.ticket.opened",
      org: { id: orgId, name: "Gemeente Testdorp" },
      account_manager: null,
    });
    expect(jobs.of(notifySlack.name)).toEqual([{ text: "a line about account.ticket.opened" }]);

    // An inbox-only event goes nowhere without the inbox, but its Slack line still does.
    const booked = new MemoryJobs();
    await fire(deps(booked, false), "account.call.booked");
    expect(booked.of(deliverEvent.name)).toHaveLength(0);
    expect(booked.of(deliverSamMessage.name)).toHaveLength(0);

    const quiet = new MemoryJobs();
    await fire(deps(quiet, false, false), "account.ticket.opened");
    expect(quiet.of(deliverEvent.name)).toHaveLength(0);
    expect(quiet.of(notifySlack.name)).toHaveLength(1);
  });

  // DBOS keeps a run's payload in workflow_input, beside its status row.
  const queued = async (marker: string) =>
    sql`select 1 from dbos.workflow_status s join dbos.workflow_input i using (workflow_uuid)
      where s.name = ${deliverSamMessage.name} and i.inputs like ${`%${marker}%`}`;

  test("a rolled-back cause queues nothing for the inbox", async () => {
    const marker = `rollback-${newId()}`;
    const d = deps(queueJobs(queue), true);
    await d.db
      .transaction(async (tx) => {
        await emit(d, tx, {
          orgId,
          actor: { kind: "staff", userId: null },
          type: "document.signed",
          webhook: { event: "account.document.signed", marker },
          slack: "never",
        });
        throw new Error("rollback");
      })
      .catch(() => {});
    expect(await queued(marker)).toHaveLength(0);
  });

  test("a committed cause queues one inbox delivery", async () => {
    const marker = `commit-${newId()}`;
    const d = deps(queueJobs(queue), true);
    await d.db.transaction((tx) =>
      emit(d, tx, {
        orgId,
        actor: { kind: "staff", userId: null },
        type: "document.signed",
        webhook: { event: "account.document.signed", marker },
      }),
    );
    expect(await queued(marker)).toHaveLength(1);
  });

  describe("the account manager", () => {
    const managed = newId();
    const billingId = newId();
    const people = { anne: newId(), bram: newId() };

    beforeAll(async () => {
      await database.db.insert(schema.org).values({ id: managed, name: "Gemeente Beheerd" });
      await database.db.insert(schema.app_user).values([
        { id: people.anne, email: "anne@dembrane.com", display_name: "Anne Jansen" },
        { id: people.bram, email: "bram@dembrane.com", display_name: null },
      ]);
      await database.db
        .insert(schema.billing_account)
        .values({ id: billingId, org_id: managed, account_manager_id: people.anne });
    });

    const setManager = (id: string | null) =>
      database.db
        .update(schema.billing_account)
        .set({ account_manager_id: id })
        .where(eq(schema.billing_account.id, billingId));

    const fireManaged = (d: AccountsDeps, event: InboxEvent, marker?: string) =>
      d.db.transaction((tx) =>
        emit(d, tx, {
          orgId: managed,
          actor: { kind: "customer", userId: null },
          type: event.replace(/^account\./, ""),
          webhook: { event, ...(marker && { marker }) },
        }),
      );

    const lastJson = (jobs: MemoryJobs) => {
      const sent = jobs.of(deliverSamMessage.name);
      return (
        JSON.parse((sent.at(-1) as { body: string }).body) as { json: Record<string, unknown> }
      ).json;
    };

    test("every account message names the manager by email and name", async () => {
      await setManager(people.anne);
      const jobs = new MemoryJobs();
      for (const event of [...ACCOUNT_EVENTS, ...INBOX_ONLY_EVENTS]) {
        await fireManaged(deps(jobs, true), event);
        expect(lastJson(jobs).account_manager).toEqual({
          email: "anne@dembrane.com",
          name: "Anne Jansen",
        });
      }
      // ACCOUNTS_EVENTS_URL, without the inbox, gets the same field.
      const legacy = new MemoryJobs();
      await fireManaged(deps(legacy, false), "account.ticket.opened");
      expect(legacy.of(deliverEvent.name)[0]?.payload).toMatchObject({
        account_manager: { email: "anne@dembrane.com", name: "Anne Jansen" },
      });
    });

    test("a manager without a display name has a null name; no manager is null", async () => {
      const jobs = new MemoryJobs();
      await setManager(people.bram);
      await fireManaged(deps(jobs, true), "account.document.signed");
      expect(lastJson(jobs).account_manager).toEqual({ email: "bram@dembrane.com", name: null });
      await setManager(null);
      await fireManaged(deps(jobs, true), "account.document.signed");
      expect(lastJson(jobs).account_manager).toBeNull();
    });

    test("a queued message keeps the manager it was written with", async () => {
      await setManager(people.anne);
      const marker = `snapshot-${newId()}`;
      await fireManaged(deps(queueJobs(queue), true), "account.task.submitted", marker);
      await setManager(people.bram);
      const [row] = await sql<{ inputs: string }[]>`
        select i.inputs from dbos.workflow_status s join dbos.workflow_input i using (workflow_uuid)
        where s.name = ${deliverSamMessage.name} and i.inputs like ${`%${marker}%`}`;
      expect(row?.inputs).toContain("anne@dembrane.com");
      expect(row?.inputs).not.toContain("bram@dembrane.com");
    });
  });
});
