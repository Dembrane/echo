import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// Offer words as data: staff and sam read and change a template's words through the API,
// a new draft copies them, and each draft can change its own without touching the template.
const run = admin ? describe : describe.skip;
const DB = `accounts_offer_template_${process.pid}`;

run("offer templates and an offer's own words", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const T = "/api/v2/admin/accounts/offer-templates";
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;

  const offer = (over: Record<string, unknown> = {}) => ({
    template: "custom",
    language: "en",
    offer_name: "Voorbeeldlab",
    person_name: "Anna",
    send: false,
    items: [
      {
        description: "dembrane licence",
        quantity: 3,
        unit: "months",
        unit_price_cents: 40000,
        vat_rate_bps: 0,
      },
      {
        description: "Integration work",
        quantity: 12,
        unit: "hours",
        unit_price_cents: 12500,
        vat_rate_bps: 0,
      },
    ],
    vat_treatment: "reverse_charge",
    ...over,
  });
  const draft = async (over: Record<string, unknown> = {}) => {
    const res = await call(w, "POST", `${S()}/offers`, "key", offer(over));
    expect(res.status).toBe(201);
    return K.PushOfferResponse.parse(res.data).document;
  };
  const change = async (docId: string, over: Record<string, unknown>) => {
    const res = await call(w, "PUT", `${S()}/offers/${docId}`, "key", offer(over));
    expect(res.status).toBe(200);
    return K.DocumentDetail.parse(res.data);
  };

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("every template and language reads its built-in words until someone changes them", async () => {
    const res = await call(w, "GET", T, "key");
    expect(res.status).toBe(200);
    const { templates } = K.OfferTemplateList.parse(res.data);
    expect(templates.map((t) => `${t.template}/${t.language}`)).toEqual([
      "subscription/en",
      "subscription/nl",
      "event/en",
      "event/nl",
      "custom/en",
      "custom/nl",
    ]);
    expect(templates.every((t) => !t.changed && t.valid_days === 14)).toBe(true);
    // One table for every template.
    expect(
      new Set(templates.filter((t) => t.language === "en").map((t) => t.columns.join("|"))),
    ).toEqual(new Set(["Description|Quantity|Unit price|Amount"]));
    expect((await call(w, "GET", T, "outsider")).status).toBe(403);
  });

  test("a new draft takes the template's words, units and validity; one table, quantity first", async () => {
    const doc = await draft();
    expect(doc.title).toBe(`Offer ${doc.reference}`);
    expect(doc.body).toContain("Dear Anna,");
    expect(doc.body).toContain("Here is what your dembrane offer includes and what it costs.");
    expect(doc.body).toContain("| Description | Quantity | Unit price | Amount |");
    expect(doc.body).toContain("| dembrane licence | 3 months | €400.00 | €1,200.00 |");
    expect(doc.body).toContain("| Integration work | 12 hours | €125.00 | €1,500.00 |");
    expect(doc.body).toContain("VAT reverse-charged");
    expect(doc.body).toContain("Kind regards,\nTeam dembrane");
  });

  test("a subscription line without a unit counts seats, or months when billed per month", async () => {
    const items = [
      { description: "Licence", quantity: 12, unit_price_cents: 30000, vat_rate_bps: 2100 },
    ];
    const seats = await draft({ template: "subscription", vat_treatment: "standard", items });
    expect(seats.body).toContain("| Licence | 12 seats | €300.00 | €3,600.00 |");
    const months = await draft({
      template: "subscription",
      vat_treatment: "standard",
      billing_unit: "month",
      language: "nl",
      items,
    });
    expect(months.body).toContain("| Omschrijving | Aantal | Prijs per stuk | Bedrag |");
    expect(months.body).toContain("| Licence | 12 maanden | € 300,00 | € 3.600,00 |");
  });

  test("a draft changes its own words; a later change keeps them, null goes back to the template", async () => {
    const doc = await draft({
      text: {
        intro:
          "Thank you for Friday.\n\n## What we will do\n\nConnect the partner's speech recognition.",
      },
      valid_days: 60,
      date: "2026-10-22",
    });
    expect(doc.body).toContain(
      "Thank you for Friday.\n\n## What we will do\n\nConnect the partner's",
    );
    expect(doc.body).not.toContain("Here is what your dembrane offer includes");
    // Valid for 60 days, not 14.
    const valid = "21 December 2026";
    expect(doc.body).toContain(`Valid until: ${valid}`);

    // Only the greeting changes; the intro and the validity stay.
    const greeted = await change(doc.id, { text: { greeting: "Hello" } });
    expect(greeted.body).toContain("Hello Anna,");
    expect(greeted.body).toContain("Thank you for Friday.");
    expect(greeted.body).toContain(`Valid until: ${valid}`);

    const back = await change(doc.id, { text: null, valid_days: null });
    expect(back.body).toContain("Dear Anna,");
    expect(back.body).toContain("Here is what your dembrane offer includes");
    expect(back.body).not.toContain(`Valid until: ${valid}`);
  });

  test("staff change a template's words: new drafts take them, existing drafts keep theirs", async () => {
    const before = await draft();
    const res = await call(w, "PUT", `${T}/custom/en`, "staff", {
      kind: "Proposal",
      intro: "Here is our proposal.",
      columns: ["What", "How many", "Price each", "Total"],
      valid_days: 30,
    });
    expect(res.status).toBe(200);
    const view = K.OfferTemplateView.parse(res.data);
    expect(view).toMatchObject({
      changed: true,
      kind: "Proposal",
      greeting: "Dear",
      valid_days: 30,
    });

    const after = await draft();
    expect(after.title).toBe(`Proposal ${after.reference}`);
    expect(after.body).toContain("Proposal\n# Voorbeeldlab");
    expect(after.body).toContain("Here is our proposal.");
    expect(after.body).toContain("| What | How many | Price each | Total |");

    // The draft made before keeps the words it was made with, also when it is saved again.
    const kept = await change(before.id, { offer_name: "Voorbeeldlab Stichting" });
    expect(kept.body).toContain("Here is what your dembrane offer includes");
    expect(kept.title).toBe(`Offer ${before.reference}`);

    const reset = await call(w, "POST", `${T}/custom/en/reset`, "staff");
    expect(K.OfferTemplateView.parse(reset.data)).toMatchObject({ changed: false, kind: "Offer" });
    expect((await call(w, "PUT", `${T}/workshop/en`, "staff", { kind: "x" })).status).toBe(404);
    expect((await call(w, "PUT", `${T}/custom/fr`, "staff", { kind: "x" })).status).toBe(404);
  });
});
