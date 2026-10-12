import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sendEmail } from "@dembrane/account";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// sam asks echo to write the people who run an account: a document withdrawn, a check-in
// on a waiting task. echo reads the facts, words and draws the email in each person's
// language, and queues one per person, replies going to the manager.
const run = admin ? describe : describe.skip;
const DB = `accounts_messages_${process.pid}`;

run("messages sam asks echo to send", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const S = (org = w.orgId) => `/api/v2/admin/accounts/${org}`;
  type Job = {
    to: string;
    template: string;
    data: Record<string, string>;
    replyTo?: { email: string };
  };
  const queued = (template: string) =>
    (w.jobs.of(sendEmail.name) as Job[])
      .filter((j) => j.template === template)
      .sort((x, y) => x.to.localeCompare(y.to));
  const message = (body: Record<string, unknown>, as: keyof World["people"] = "staff") =>
    call(w, "POST", `${S()}/messages`, as, body);

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    const anne = newId();
    await w.db
      .insert(schema.app_user)
      .values({ id: anne, email: "anne@dembrane.com", display_name: "Anne Jansen" });
    await w.db
      .insert(schema.billing_account)
      .values({ id: newId(), org_id: w.orgId, account_manager_id: anne });
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("only staff, and each kind needs its subject", async () => {
    expect((await message({ kind: "task_reminder", task_id: null }, "admin")).status).toBe(403);
    expect((await message({ kind: "task_reminder" })).status).toBe(422);
    expect(
      (await message({ kind: "document_withdrawn", task_id: crypto.randomUUID() })).status,
    ).toBe(422);
    expect(
      (await message({ kind: "document_withdrawn", document_id: crypto.randomUUID() })).status,
    ).toBe(404);
    expect(
      (await message({ kind: "invoice_issued", document_id: crypto.randomUUID() })).status,
    ).toBe(422);
  });

  test("a withdrawal only for a withdrawn document; a check-in only for a waiting task", async () => {
    const offer = K.PushOfferResponse.parse(
      (
        await call(w, "POST", `${S()}/offers`, "staff", {
          template: "subscription",
          language: "en",
          offer_name: "Gemeente Testdorp",
          person_name: "Anna",
          reference: "OFFER-990",
          items: [
            { description: "Licence", quantity: 1, unit_price_cents: 1000, vat_rate_bps: 2100 },
          ],
        })
      ).data,
    ).document;
    expect((await message({ kind: "document_withdrawn", document_id: offer.id })).status).toBe(409);
    await call(w, "POST", `${S()}/documents/${offer.id}/void`, "staff", {});
    const withdrawn = K.SendMessageResponse.parse(
      (
        await message({
          kind: "document_withdrawn",
          document_id: offer.id,
          note: "A corrected offer follows this week.",
          dry_run: true,
        })
      ).data,
    );
    expect(withdrawn.queued).toBe(0);
    expect(withdrawn.messages.length).toBeGreaterThan(0);
    expect(withdrawn.messages[0]?.subject).toContain("has been withdrawn");
    expect(withdrawn.messages[0]?.text).toContain("A corrected offer follows this week.");
    expect(withdrawn.messages[0]?.text).toEndWith("Anne Jansen\ndembrane\n");
    expect(queued("account_document_withdrawn")).toEqual([]);

    const sent = K.SendMessageResponse.parse(
      (await message({ kind: "document_withdrawn", document_id: offer.id })).data,
    );
    expect(sent.queued).toBe(withdrawn.messages.length);
    const jobs = queued("account_document_withdrawn");
    expect(jobs.map((j) => j.to)).toEqual(withdrawn.messages.map((m) => m.to).sort());
    expect(jobs[0]?.data).toMatchObject({ document_title: offer.title });
    expect(jobs[0]?.replyTo?.email).toBe("anne@dembrane.com");
    // Asked again, nobody gets it twice.
    await message({ kind: "document_withdrawn", document_id: offer.id });
    expect(queued("account_document_withdrawn")).toHaveLength(jobs.length);
    const events = await store.events(w.db, w.orgId);
    expect(events.some((e) => e.type === "message.sent" && e.subjectId === offer.id)).toBe(true);

    const task = K.Task.parse(
      (await call(w, "POST", `${S()}/tasks`, "staff", { title: "Send us your PO number" })).data,
    );
    const reminder = K.SendMessageResponse.parse(
      (await message({ kind: "task_reminder", task_id: task.id })).data,
    );
    expect(reminder.queued).toBeGreaterThan(0);
    expect(reminder.messages[0]?.subject).toBe(
      "Still open for Gemeente Testdorp: Send us your PO number",
    );
    // Check-ins may be asked for again.
    await message({ kind: "task_reminder", task_id: task.id });
    expect(queued("account_task_reminder")).toHaveLength(reminder.queued * 2);
  });
});
