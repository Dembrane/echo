import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sendEmail } from "@dembrane/account";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// dembrane's sub-processor change notice (DPA article 9.2) to the people who run every
// live organisation: a dry run first, then both languages to one test address, then,
// confirmed, one email per person, never twice.
const run = admin ? describe : describe.skip;
const DB = `accounts_notices_${process.pid}`;
const PATH = "/api/v2/admin/accounts/notices/subprocessors";

run("the sub-processor notice", () => {
  setDefaultTimeout(60_000);
  let w: World;
  type Job = {
    to: string;
    template: string;
    language: string;
    data: Record<string, string>;
    replyTo?: { email: string };
  };
  const queued = () =>
    (w.jobs.of(sendEmail.name) as Job[])
      .filter((j) => j.template === "account_subprocessor_notice")
      .sort((x, y) => x.to.localeCompare(y.to) || x.language.localeCompare(y.language));
  const dates = { effective_date: "2026-12-11", objection_deadline: "2026-12-10" };
  const notice = (body: Record<string, unknown>, as: keyof World["people"] = "staff") =>
    call(w, "POST", PATH, as, { ...dates, ...body });

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    // The admin reads Dutch; billing also runs the other organisation.
    await w.db
      .update(schema.directus_users)
      .set({ language: "nl-NL" })
      .where(eq(schema.directus_users.id, w.people.admin.directusUserId));
    await w.db.insert(schema.org_membership).values({
      id: newId(),
      org_id: w.otherOrgId,
      user_id: w.people.billing.appUserId as string,
      role: "admin",
    });
    // Neither a deleted organisation nor one whose demo is still being built is written to.
    const gone = newId();
    const building = newId();
    await w.db.insert(schema.org).values([
      { id: gone, name: "Opgeheven BV", deleted_at: new Date().toISOString() },
      { id: building, name: "Demo in de maak", account_stage: "prospect" },
    ]);
    for (const org_id of [gone, building])
      await w.db.insert(schema.org_membership).values({
        id: newId(),
        org_id,
        user_id: w.people.signer.appUserId as string,
        role: "owner",
      });
    await w.db.insert(schema.account_demo).values({
      id: newId(),
      orgId: building,
      input: {},
      steps: {},
      createdBy: w.people.staff.directusUserId,
    });
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("only staff, and a send to everyone only when confirmed", async () => {
    expect((await notice({}, "admin")).status).toBe(403);
    expect((await notice({ dry_run: false, reply_to: "legal@dembrane.com" })).status).toBe(422);
    expect(
      (
        await notice({
          dry_run: false,
          reply_to: "legal@dembrane.com",
          confirm: "send to all",
        })
      ).status,
    ).toBe(422);
    // Objections come back as replies, so the real send needs somewhere for them to go.
    expect((await notice({ dry_run: false, confirm: K.SUBPROCESSOR_NOTICE_CONFIRM })).status).toBe(
      422,
    );
    expect((await notice({ effective_date: "2026-02-31" })).status).toBe(422);
    // A staff key gets the dry run and nothing more.
    expect((await notice({}, "key")).status).toBe(200);
    expect((await notice({ dry_run: false, test_to: "jor@example.test" }, "key")).status).toBe(403);
    expect(queued()).toEqual([]);
  });

  test("a dry run lists everyone once, in their language, and sends nothing", async () => {
    const res = await notice({});
    expect(res.status).toBe(200);
    const dry = K.SubprocessorNoticeResponse.parse(res.data);
    expect(dry.queued).toBe(0);
    expect(dry.recipients).toEqual([
      { to: "admin@example.test", language: "nl-NL", orgs: ["Gemeente Testdorp"] },
      { to: "billing@example.test", language: "en-US", orgs: ["Elders BV", "Gemeente Testdorp"] },
      { to: "outsider@example.test", language: "en-US", orgs: ["Elders BV"] },
    ]);
    expect(dry.counts).toEqual({ nl: 1, en: 2, total: 3 });
    expect(dry.samples.map((s) => [s.language, s.subject])).toEqual([
      ["nl-NL", "Wijzigingen in de subverwerkers van dembrane"],
      ["en-US", "Changes to dembrane's sub-processors"],
    ]);
    expect(dry.samples[0]?.text).toContain("Vanaf 11 december 2026");
    expect(dry.samples[1]?.text).toContain("until 10 December 2026");
    expect(queued()).toEqual([]);
  });

  test("a test send queues both languages to that one address", async () => {
    const res = K.SubprocessorNoticeResponse.parse(
      (await notice({ dry_run: false, test_to: "jor@example.test" })).data,
    );
    expect(res.queued).toBe(2);
    const jobs = queued();
    expect(jobs.map((j) => [j.to, j.language])).toEqual([
      ["jor@example.test", "en-US"],
      ["jor@example.test", "nl-NL"],
    ]);
    expect(jobs.find((j) => j.language === "nl-NL")?.data.dpa_url).toBe(
      "https://dembrane.com/nl/legal/dpa",
    );
    w.jobs.jobs.length = 0;
  });

  test("the send queues one email per address, and asked again queues nothing new", async () => {
    const send = {
      dry_run: false,
      reply_to: "legal@dembrane.com",
      confirm: K.SUBPROCESSOR_NOTICE_CONFIRM,
    };
    const sent = K.SubprocessorNoticeResponse.parse((await notice(send)).data);
    expect(sent.queued).toBe(3);
    const jobs = queued();
    expect(jobs.map((j) => [j.to, j.language])).toEqual([
      ["admin@example.test", "nl-NL"],
      ["billing@example.test", "en-US"],
      ["outsider@example.test", "en-US"],
    ]);
    expect(jobs[1]?.data).toEqual({
      org_names: "Elders BV\nGemeente Testdorp",
      effective_date: "2026-12-11",
      objection_deadline: "2026-12-10",
      dpa_url: "https://dembrane.com/legal/dpa",
    });
    expect(jobs.every((j) => j.replyTo?.email === "legal@dembrane.com")).toBe(true);
    const events = await store.events(w.db, w.otherOrgId);
    const event = events.find(
      (e) => e.type === "message.sent" && e.subjectId === "subprocessors:2026-12-11",
    );
    expect(event?.detail).toMatchObject({
      kind: "subprocessor_notice",
      to: ["billing@example.test", "outsider@example.test"],
    });

    await notice(send);
    expect(queued()).toHaveLength(3);
  });
});
