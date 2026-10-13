import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sendEmail } from "@dembrane/account";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// Sending an offer puts it in the customer's account and emails nobody. The answer carries
// the email the deal owner sends themselves, worded in the offer's language.
const run = admin ? describe : describe.skip;
const DB = `accounts_offer_email_${process.pid}`;

run("the email to send the customer", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const S = (org = w.orgId) => `/api/v2/admin/accounts/${org}`;
  const login = (org = w.orgId) =>
    `https://dash.test/login?next=${encodeURIComponent(`/o/${org}/account`)}`;

  const draft = async (org = w.orgId, over: Record<string, unknown> = {}) =>
    K.PushOfferResponse.parse(
      (
        await call(w, "POST", `${S(org)}/offers`, "staff", {
          template: "subscription",
          language: "en",
          offer_name: "Gemeente Proefstad (sample)",
          person_name: "Noor",
          reference: "OFFER-501",
          items: [
            { description: "Licence", quantity: 1, unit_price_cents: 8600, vat_rate_bps: 2100 },
          ],
          send: false,
          ...over,
        })
      ).data,
    ).document;
  const send = async (docId: string, org = w.orgId, as: "staff" | "key" = "staff") =>
    K.DocumentDetail.parse(
      (await call(w, "POST", `${S(org)}/documents/${docId}/send`, as, {})).data,
    );
  const read = async (docId: string, as: "staff" | "key" | "admin" = "staff", org = w.orgId) =>
    K.DocumentDetail.parse(
      (
        await call(
          w,
          "GET",
          as === "admin"
            ? `/api/v2/orgs/${org}/account/documents/${docId}`
            : `${S(org)}/documents/${docId}`,
          as,
        )
      ).data,
    );
  const emails = () => w.jobs.of(sendEmail.name).length;

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    await w.db
      .update(schema.auth_user)
      .set({ name: "Sam Staffer" })
      .where(eq(schema.auth_user.id, w.people.staff.directusUserId as string));
    await w.db
      .update(schema.app_user)
      .set({ display_name: "Noor Voorbeeld" })
      .where(eq(schema.app_user.id, w.people.admin.appUserId as string));
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("a sent offer carries the email to the account's contact, and nothing is emailed", async () => {
    const doc = await draft();
    expect(doc.customer_links).toBeNull();
    expect(doc.customer_email).toBeNull();

    const sent = await send(doc.id);
    expect(emails()).toBe(0);
    expect(sent.customer_email).toEqual({
      to: "admin@example.test",
      subject: `Your offer from dembrane: ${sent.title}`,
      body: [
        "Hello Noor Voorbeeld,",
        `The offer "${sent.title}" (OFFER-501) is ready to review and sign:\nhttps://dash.test/o/${w.orgId}/account/documents/${doc.id}/sign`,
        `You sign in with your email address and a one-time code. Sign in here:\n${login()}`,
        "The offer is valid until 12 October 2026.",
        "Kind regards,\nSam",
      ].join("\n\n"),
    });
    // The links in the email are the links beside it.
    expect(sent.customer_email?.body).toContain(sent.customer_links?.document as string);
    expect(sent.customer_email?.body).toContain(sent.customer_links?.sign_in as string);

    // The staff page reads the same text later; the customer's own read has none.
    expect((await read(doc.id)).customer_email).toEqual(sent.customer_email);
    expect((await read(doc.id, "admin")).customer_email).toBeNull();
  });

  test("the email is in the offer's language", async () => {
    const doc = await draft(w.orgId, { language: "nl", reference: "OFFER-502" });
    const sent = await send(doc.id);
    expect(sent.language).toBe("nl");
    expect(sent.customer_email?.subject).toBe(`Je offerte van dembrane: ${sent.title}`);
    const lines = sent.customer_email?.body.split("\n\n") ?? [];
    expect(lines[0]).toBe("Hallo Noor Voorbeeld,");
    expect(lines[1]).toContain("staat klaar om te lezen en te ondertekenen:");
    expect(lines[3]).toBe("De offerte is geldig tot 12 oktober 2026.");
    expect(lines[4]).toBe("Met vriendelijke groet,\nSam");
  });

  test("a staff key is not a person who writes to the customer: the manager signs, else dembrane", async () => {
    const doc = await draft(w.orgId, { reference: "OFFER-503" });
    const sent = await send(doc.id, w.orgId, "key");
    expect(emails()).toBe(0);
    expect(sent.customer_email?.body.endsWith("Kind regards,\ndembrane")).toBe(true);

    await w.db.insert(schema.billing_account).values({
      id: newId(),
      org_id: w.orgId,
      account_manager_id: w.people.billing.appUserId as string,
    });
    await w.db
      .update(schema.app_user)
      .set({ display_name: "Pim Beheerder" })
      .where(eq(schema.app_user.id, w.people.billing.appUserId as string));
    expect((await read(doc.id, "key")).customer_email?.body.endsWith("Kind regards,\nPim")).toBe(
      true,
    );
    // A person still signs with their own first name.
    expect((await read(doc.id)).customer_email?.body.endsWith("Kind regards,\nSam")).toBe(true);
  });

  test("it is null wherever there is nobody to send it to or nothing to send", async () => {
    // An account without anyone who runs it: the links exist, the email has no address.
    const empty = newId();
    await w.db
      .insert(schema.org)
      .values({ id: empty, name: "Leeg (sample)", account_stage: "prospect" });
    const doc = await draft(empty);
    const sent = await send(doc.id, empty);
    expect(sent.customer_links).not.toBeNull();
    expect(sent.customer_email).toBeNull();

    // A draft has neither; a withdrawn offer has neither.
    const second = await draft(w.orgId, { reference: "OFFER-504" });
    expect((await read(second.id)).customer_email).toBeNull();
    await send(second.id);
    expect((await read(second.id)).customer_email).not.toBeNull();
    await call(w, "POST", `${S()}/documents/${second.id}/void`, "staff", { reason: "test" });
    const voided = await read(second.id);
    expect(voided.customer_links).toBeNull();
    expect(voided.customer_email).toBeNull();
    expect(emails()).toBe(0);
  });
});
