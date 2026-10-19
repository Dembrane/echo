import { describe, expect, test } from "bun:test";
import { assetPath } from "@dembrane/core";
import { LOCALES } from "@dembrane/i18n";
import { PDFDocument } from "pdf-lib";
import { walkOrder } from "../src/documents";
import { runDeliverEvent, runNotifySlack } from "../src/jobs";
import { legalSha256, parseLegalDump, parseLegalPage } from "../src/legal/parse";
import { REFERENCE_DPA, REFERENCE_SLA, REFERENCE_TERMS } from "../src/legal/reference";
import { fitsVatTreatment, priceLines, requireAmounts, vatOf } from "../src/money";
import { euro, layoutOffer, legalKinds, type OfferContent, offerText } from "../src/offer";
import { ONBOARDING_CODES } from "../src/onboarding";
import { legalBlocks, offerPdf, signedPdf, textPdf } from "../src/pdf";
import { candidates, lookupPeppol } from "../src/peppol";
import { checkValues, pngBytes, signerFacts } from "../src/signing";
import type { FieldRow } from "../src/storage";
import { taskBody, taskTitle } from "../src/task-text";
import { confirmationText } from "../src/views";
import { fixtureHtml, png, silent } from "./helpers";

const offer = (over: Partial<OfferContent> = {}): OfferContent => ({
  template: "subscription",
  language: "en",
  offer_name: "Gemeente Voorbeeldstad",
  date: "2026-09-28",
  reference: "DMB-1",
  person_name: "Anna",
  attention: null,
  currency: "EUR",
  valid_days: 14,
  company: {
    name: "dembrane B.V.",
    address: "Sint Janssingel 88",
    vat: "NL864967433B01",
    kvk: "89391438",
    iban: "NL49 RABO 0318910535",
    bic: "RABONL2U",
  },
  legal: {
    terms: {
      version: "2.0",
      effective_on: "2026-06-21",
      url: "https://www.dembrane.com/legal/terms",
    },
    sla: { version: "1.1", effective_on: "2026-06-21", url: "https://www.dembrane.com/legal/sla" },
    dpa: {
      version: "3.0.1",
      effective_on: "2026-07-17",
      url: "https://www.dembrane.com/legal/dpa",
    },
  },
  items: [
    {
      description: "Changemaker",
      bullets: ["Unlimited recording hours"],
      quantity: 60,
      unit_price_cents: 8600,
      vat_rate_bps: 2100,
    },
    {
      description: "Workshop",
      bullets: [],
      quantity: 1,
      unit_price_cents: 125000,
      vat_rate_bps: 2100,
    },
  ],
  ...over,
});

describe("money", () => {
  test("VAT per line, half away from zero, in integer cents", () => {
    expect(vatOf(1, 2100)).toBe(0);
    expect(vatOf(3, 2100)).toBe(1); // 0.63 rounds up
    expect(vatOf(50, 900)).toBe(5); // 4.5 rounds away from zero
    expect(vatOf(-50, 900)).toBe(-5);
    const t = priceLines(offer().items);
    expect([t.subtotal_cents, t.vat_cents, t.total_cents]).toEqual([641000, 134610, 775610]);
  });
  test("refuses what cannot be invoiced", () => {
    expect(() => priceLines([])).toThrow(/at least one line/);
    expect(() =>
      priceLines([{ description: "x", quantity: 0, unit_price_cents: 1, vat_rate_bps: 0 }]),
    ).toThrow(/quantity/);
    expect(() =>
      priceLines([{ description: "x", quantity: 1, unit_price_cents: 1.5, vat_rate_bps: 0 }]),
    ).toThrow(/cents/);
    expect(() =>
      priceLines([{ description: "x", quantity: 1, unit_price_cents: 1, vat_rate_bps: 1900 }]),
    ).toThrow(/VAT rate/);
    expect(() =>
      priceLines([{ description: "x", quantity: 1, unit_price_cents: -100, vat_rate_bps: 0 }]),
    ).toThrow(/less than zero/);
    // A discount line is fine while the offer stays positive.
    expect(
      priceLines([
        { description: "Licence", quantity: 1, unit_price_cents: 10000, vat_rate_bps: 2100 },
        { description: "Scholarship", quantity: 1, unit_price_cents: -5000, vat_rate_bps: 2100 },
      ]).total_cents,
    ).toBe(6050);
  });
  test("an offer that is sent carries amounts", () => {
    const line = (unit_price_cents: number) => ({
      description: "x",
      quantity: 1,
      unit_price_cents,
      vat_rate_bps: 2100,
    });
    expect(() => requireAmounts([line(10000), line(0)])).toThrow(/Line 2: give a price/);
    expect(() => requireAmounts([line(10000), line(-10000)])).toThrow(/more than zero/);
    expect(requireAmounts([line(10000), line(-2500)]).total_cents).toBe(9075);
  });
  test("amounts as the templates write them", () => {
    expect(euro(8600)).toBe("€86.00");
    expect(euro(125000)).toBe("€1,250.00");
    expect(euro(123456, "EUR", "nl")).toBe("€ 1.234,56");
    expect(euro(-5000, "EUR", "nl")).toBe("-€ 50,00");
  });
});

describe("the offer", () => {
  test("a subscription billed per month names months, not seats", () => {
    const month = offerText(offer({ billing_unit: "month" }));
    expect(month).toContain("| Description | Price per month | Months | Amount |");
    expect(month).not.toContain("seat");
    expect(month).toContain("Subtotal (excl. VAT): €6,410.00");
    const nl = offerText(offer({ language: "nl", billing_unit: "month" }));
    expect(nl).toContain("| Omschrijving | Prijs per maand | Maanden | Bedrag |");
    expect(nl).not.toContain("seat");
    expect(nl).toContain("Subtotaal (excl. btw): €");
    // Price first, then the quantity, as for seats.
    expect(month).toContain(
      "| Changemaker<br>• Unlimited recording hours | €86.00 | 60 | €5,160.00 |",
    );
  });
  test("seats stay the default, and only subscriptions have a unit", () => {
    const seat = "| Description | Price per seat per month | Seats | Amount |";
    expect(offerText(offer())).toContain(seat);
    expect(offerText(offer({ billing_unit: "seat" }))).toContain(seat);
    const nl = offerText(offer({ language: "nl", billing_unit: "seat" }));
    expect(nl).toContain("| Omschrijving | Prijs per seat per maand | Seats | Bedrag |");
    expect(offerText(offer({ template: "event", billing_unit: "month" }))).toContain(
      "| Description | Quantity | Unit price | Amount |",
    );
  });
  test("follows the template: facts, columns, totals with VAT, acceptance, pinned versions", () => {
    const text = offerText(offer());
    expect(text).toContain("Yearly license offer\n# Gemeente Voorbeeldstad\n");
    expect(text).toContain("Reference: DMB-1");
    expect(text).toContain("Date: 28 September 2026");
    // Validity counts from the offer's own valid_days.
    expect(text).toContain("Valid until: 12 October 2026");
    expect(offerText(offer({ valid_days: 30 }))).toContain("Valid until: 28 October 2026");
    expect(text).toContain("| Description | Price per seat per month | Seats | Amount |");
    expect(text).toContain(
      "| Changemaker<br>• Unlimited recording hours | €86.00 | 60 | €5,160.00 |",
    );
    expect(text).toContain("Subtotal (excl. VAT): €6,410.00");
    expect(text).toContain("VAT 21%: €1,346.10");
    expect(text).toContain("Total (incl. VAT): €7,756.10");
    expect(text).toContain("IBAN NL49 RABO 0318910535");
    expect(text).toContain(
      "Annex B: Data Processing Agreement (version 3.0.1, 17-07-2026, https://www.dembrane.com/legal/dpa)",
    );
    const nl = offerText(offer({ language: "nl" }));
    expect(nl).toContain("Btw-nummer: ");
    expect(nl).toContain("Totaal (incl. btw): € 7.756,10");
    expect(nl).toContain("Bijlage B: Verwerkersovereenkomst (versie 3.0.1, 17-07-2026");
    const event = layoutOffer(offer({ template: "event", attention: "Anna" }));
    expect(event.columns).toEqual(["Description", "Quantity", "Unit price", "Amount"]);
    expect(event.rows[0]?.cells).toEqual(["60", "€86.00", "€5,160.00"]);
    expect(event.facts.at(-1)).toEqual(["For the attention of", "Anna"]);
    expect(
      layoutOffer(offer({ template: "event", language: "nl" })).acceptance.fields.some(
        (f) => f.key === "vat_number",
      ),
    ).toBe(false);
    // Mixed rates show one VAT line without a rate.
    const mixed = layoutOffer(
      offer({
        items: [
          {
            description: "A",
            bullets: [],
            quantity: 1,
            unit_price_cents: 10000,
            vat_rate_bps: 2100,
          },
          {
            description: "B",
            bullets: [],
            quantity: 1,
            unit_price_cents: 10000,
            vat_rate_bps: 900,
          },
        ],
      }),
    );
    expect(mixed.totals.map(([k]) => k)).toEqual([
      "Subtotal (excl. VAT)",
      "VAT",
      "Total (incl. VAT)",
    ]);
  });

  test("reverse charge and outside the EU say why there is no VAT, as the invoice does", () => {
    const zero = offer().items.map((i) => ({ ...i, vat_rate_bps: 0 }));
    const nl = layoutOffer(offer({ language: "nl", vat_treatment: "reverse_charge", items: zero }));
    expect(nl.totals[1]).toEqual(["Btw 0%", "€ 0,00"]);
    expect(nl.vatNote).toBe("Btw verlegd: artikel 196, Richtlijn 2006/112/EG.");
    const en = offerText(offer({ vat_treatment: "outside_eu", items: zero }));
    expect(en).toContain("No Dutch VAT: the service is supplied outside the EU");
    expect(layoutOffer(offer()).vatNote).toBeNull();
    expect(fitsVatTreatment("reverse_charge", zero)).toBe(true);
    expect(fitsVatTreatment("reverse_charge", offer().items)).toBe(false);
    expect(fitsVatTreatment("standard", zero)).toBe(true);
  });

  test("the PDF places the acceptance blanks as fields, on the page, in walk order", async () => {
    const r = await offerPdf(offer({ language: "nl" }));
    expect(r.fields.map((f) => f.kind)).toEqual([
      "name",
      "text",
      "text",
      "text",
      "role",
      "date",
      "signature",
    ]);
    expect(r.fields.find((f) => f.key === "vat_number")?.required).toBe(false);
    for (const f of r.fields) {
      expect(f.page).toBeLessThanOrEqual(r.pageCount);
      expect(f.x + f.width).toBeLessThanOrEqual(1);
      expect(f.y + f.height).toBeLessThanOrEqual(1);
    }
    expect(walkOrder(r.fields)).toEqual(r.fields);
    // The same offer renders to the same bytes, so its hash is stable.
    const again = await offerPdf(offer({ language: "nl" }));
    expect(Buffer.from(again.bytes).equals(Buffer.from(r.bytes))).toBe(true);
  });

  test("a per-month subscription renders on the same two pages", async () => {
    const items = [
      {
        description: "dembrane subscription",
        bullets: [],
        quantity: 12,
        unit_price_cents: 30000,
        vat_rate_bps: 2100,
      },
    ];
    for (const language of ["en", "nl"] as const) {
      const content = offer({ language, billing_unit: "month", items });
      const text = offerText(content);
      expect(text).toContain("| dembrane subscription | €");
      expect(text).toContain("| 12 |");
      const r = await offerPdf(content);
      expect(r.pageCount).toBe(2);
    }
  });

  test("each template puts the acceptance block on its own page and links the texts that apply", async () => {
    for (const template of ["subscription", "event", "custom"] as const)
      for (const language of ["en", "nl"] as const) {
        const content = offer({ template, language });
        const r = await offerPdf(content);
        expect(r.pageCount).toBe(2);
        expect(r.fields.every((f) => f.page === 2)).toBe(true);
        // The date and the signature share one line, the date first.
        const [date, signature] = r.fields.slice(-2);
        expect([date?.kind, signature?.kind]).toEqual(["date", "signature"]);
        expect((date?.y ?? 0) + (date?.height ?? 0)).toBeCloseTo(
          (signature?.y ?? 0) + (signature?.height ?? 0),
          6,
        );
        expect(date?.x).toBeLessThan(signature?.x ?? 0);
        const text = Buffer.from(r.bytes).toString("latin1");
        for (const kind of legalKinds(template))
          expect(text).toContain(`(${content.legal[kind].url})`);
        // A single event has no SLA, so its offer does not name one.
        if (template === "event") expect(text).not.toContain(`(${content.legal.sla.url})`);
        expect(text).toContain("DMSans-Text");
      }
  });

  test("a custom offer carries numbered amendments that take precedence, and every offer is signed electronically", async () => {
    const amendments = [
      {
        title: "Liability cap",
        body: "Regardless of article 12 of the General Terms and Conditions, dembrane's liability is capped at €30,000.\n\nThis applies per year.",
      },
    ];
    const text = offerText(offer({ template: "custom", amendments }));
    expect(text).toContain("## Amendments to the standard documents");
    expect(text).toContain("Amendment 1: Liability cap\nRegardless of article 12");
    expect(text).toContain("\nThis applies per year.");
    expect(text).toContain("5. Amendment 1: Liability cap, as set out in this offer.");
    expect(text).toContain("the amendment applies");
    expect(text).toContain("article 3:15a of the Dutch Civil Code");
    // Without amendments, the clause says nothing about them.
    const plain = offerText(offer({ template: "custom" }));
    expect(plain).not.toContain("Amendment");
    expect(plain).toContain("article 3:15a");
    const nl = offerText(offer({ template: "custom", language: "nl", amendments }));
    expect(nl).toContain("5. Aanvulling 1: Liability cap, zoals opgenomen in deze offerte.");
    expect(nl).toContain("artikel 3:15a BW");
    const pdf = await offerPdf(offer({ template: "custom", amendments }));
    expect(pdf.fields.every((f) => f.page === pdf.pageCount)).toBe(true);
  });

  test("a long offer keeps its rows whole and still ends on the acceptance page", async () => {
    const one = offer().items[0] as OfferContent["items"][number];
    const r = await offerPdf(
      offer({ items: Array.from({ length: 8 }, () => ({ ...one, bullets: ["a", "b", "c"] })) }),
    );
    expect(r.pageCount).toBe(3);
    expect(r.fields.every((f) => f.page === 3)).toBe(true);
  });

  test("a legal text gets back its headings, clauses, lists and tables", () => {
    const body = [
      "Article 2. Processing",
      "2.4. Processor shall not be permitted to:",
      "use the data for itself;",
      "sell the data.",
      "2.5. Workspaces and roles.",
      "Annex III. Sub-processors",
      "Sub-processor (location)",
      "Website",
      "Outsourced Processing",
      "Retention Periods",
      "DigitalOcean (EU)https://www.digitalocean.com/trust",
      "Hosting",
      "Duration of Agreement",
    ].join("\n");
    expect(legalBlocks(body)).toEqual([
      { kind: "heading", level: 2, text: "Article 2. Processing" },
      { kind: "clause", number: "2.4.", text: "Processor shall not be permitted to:" },
      { kind: "item", text: "use the data for itself;" },
      { kind: "item", text: "sell the data." },
      { kind: "clause", number: "2.5.", text: "Workspaces and roles." },
      { kind: "heading", level: 2, text: "Annex III. Sub-processors" },
      {
        kind: "table",
        header: [
          "Sub-processor (location)",
          "Website",
          "Outsourced Processing",
          "Retention Periods",
        ],
        rows: [
          [
            "DigitalOcean (EU)",
            "https://www.digitalocean.com/trust",
            "Hosting",
            "Duration of Agreement",
          ],
        ],
      },
    ]);
  });

  test("stamping values and the signature adds the audit page", async () => {
    const r = await textPdf("Plan", "# Plan\n\nText", { signing: true, language: "en" });
    const fields = r.fields.map((f, i) => ({ ...f, id: `f${i}` }));
    const values = { f0: "Anna", f1: "Wethouder", f2: "Gemeente", f3: "28-09-2026" };
    const out = await signedPdf(
      r.bytes,
      fields,
      values,
      { signature: png(), initials: null },
      {
        documentTitle: "Plan",
        documentId: "d",
        reference: null,
        version: 1,
        sha256: "a".repeat(64),
        signerName: "Anna",
        signerRole: "Wethouder",
        email: "a@b.example",
        organisation: "Gemeente",
        address: null,
        vatNumber: null,
        dpaAuthorised: true,
        signedAt: "2026-09-28T10:00:00.000Z",
        ip: "203.0.113.7",
        userAgent: "ua",
        confirmationText: "I, Anna, ...",
        signatureId: "s",
        method: "drawn",
        imageSha256: "b".repeat(64),
        language: "en",
        legal: [],
      },
    );
    expect((await PDFDocument.load(out)).getPageCount()).toBe(r.pageCount + 1);
  });
});

describe("legal pages", () => {
  test("the live HTML and the text capture of each page are the same text", async () => {
    for (const [kind, dump] of [
      ["terms", REFERENCE_TERMS],
      ["sla", REFERENCE_SLA],
      ["dpa", REFERENCE_DPA],
    ] as const) {
      const page = parseLegalPage(await fixtureHtml(kind));
      const capture = parseLegalDump(dump);
      expect(page.sha256).toBe(capture.sha256);
      expect([page.version, page.effectiveOn]).toEqual([capture.version, capture.effectiveOn]);
    }
    expect(parseLegalDump(REFERENCE_DPA).version).toBe("3.0.1");
  });
  test("the embedded first rows are the captures in reference/", async () => {
    for (const [file, text] of [
      ["legal-terms.txt", REFERENCE_TERMS],
      ["legal-sla.txt", REFERENCE_SLA],
      ["legal-dpa.txt", REFERENCE_DPA],
    ] as const)
      expect(await Bun.file(assetPath("accounts", "reference", file)).text()).toBe(text);
  });
  test("whitespace is layout, words are text", () => {
    expect(legalSha256("a b\n c")).toBe(legalSha256("a  b c"));
    expect(legalSha256("a b")).not.toBe(legalSha256("a c"));
    expect(() => parseLegalPage("<html><h1>x</h1></html>")).toThrow();
  });
});

describe("signing rules", () => {
  const field = (id: string, kind: string, key: string | null = null, required = true) =>
    ({ id, kind, key, required, label: id }) as unknown as FieldRow;
  const fields = [
    field("n", "name"),
    field("r", "role"),
    field("o", "text", "organisation"),
    field("c", "checkbox", null, false),
    field("s", "signature"),
  ];
  test("required fields, known fields, the right types", () => {
    expect(() => checkValues(fields, { n: "A", r: "B", o: "C" })).not.toThrow();
    expect(() => checkValues(fields, { n: "A", r: "", o: "C" })).toThrow(/r is required/);
    expect(() => checkValues(fields, { n: "A", r: "B", o: "C", x: "?" })).toThrow(/Unknown field/);
    expect(() => checkValues(fields, { n: "A", r: "B", o: "C", c: "yes" })).toThrow(/tick/);
    expect(signerFacts(fields, { n: " Anna ", r: "B", o: "" }, "Fallback BV")).toMatchObject({
      name: "Anna",
      organisation: "Fallback BV",
    });
  });
  test("signature images are PNGs of at most 512 KB", () => {
    expect(pngBytes(Buffer.from(png()).toString("base64"), "signature").byteLength).toBeGreaterThan(
      0,
    );
    expect(() => pngBytes(Buffer.from("GIF89a....").toString("base64"), "signature")).toThrow(
      /PNG/,
    );
  });
  test("the confirmation names the signer, the organisation, the document and its hash", () => {
    const doc = {
      kind: "offer",
      language: "en",
      title: "X x dembrane",
      reference: "DMB-1",
      sha256: "c".repeat(64),
    } as never;
    expect(
      confirmationText(doc, {
        name: "Anna",
        role: "Mayor",
        organisation: "Town",
        dpa_authorised: false,
      }),
    ).toBe(
      `I, Anna, Mayor, confirm that I may sign on behalf of Town, and I sign "X x dembrane" (DMB-1) as shown to me, SHA-256 ${"c".repeat(64)}. I am not authorised to agree to data processing on behalf of this organisation; the data processing agreement will be signed separately.`,
    );
    expect(
      confirmationText(doc, { name: "Anna", role: "", organisation: "Town", dpa_authorised: true }),
    ).toStartWith("I, Anna, confirm");
  });
});

describe("delivery to sam and Slack", () => {
  test("events go to the configured URL with the secret; 4xx is final, 5xx retries, unset fails the run", async () => {
    const seen: { url: string | null; secret: string | null; event: unknown }[] = [];
    const deliver =
      (status: number) =>
      async (t: { url: string | null; secret: string | null }, p: Record<string, unknown>) => {
        seen.push({ url: t.url, secret: t.secret, event: p.event });
        return { status, text: "" };
      };
    const p = { payload: { event: "account.document.signed" } };
    await runDeliverEvent(
      { deliver: deliver(204), url: "https://sam.example/hook", secret: "s3", logger: silent },
      p,
    );
    expect(seen[0]).toEqual({
      url: "https://sam.example/hook",
      secret: "s3",
      event: "account.document.signed",
    });
    await runDeliverEvent(
      { deliver: deliver(410), url: "https://sam.example/hook", secret: null, logger: silent },
      p,
    );
    await expect(
      runDeliverEvent(
        { deliver: deliver(502), url: "https://sam.example/hook", secret: null, logger: silent },
        p,
      ),
    ).rejects.toThrow(/502/);
    // Jobs are only queued while a receiver is set; one left over must not vanish.
    await expect(
      runDeliverEvent({ deliver: deliver(500), url: null, secret: null, logger: silent }, p),
    ).rejects.toThrow();
    expect(seen).toHaveLength(3);
  });
  test("Slack gets the line; a refusal retries; unset fails the run", async () => {
    const posted: unknown[] = [];
    await runNotifySlack(
      {
        post: async (_u, b) => {
          posted.push(b);
          return 200;
        },
        url: "https://hooks.slack.example/x",
      },
      { text: "signed" },
    );
    expect(posted).toEqual([{ text: "signed" }]);
    await expect(
      runNotifySlack(
        { post: async () => 500, url: "https://hooks.slack.example/x" },
        { text: "x" },
      ),
    ).rejects.toThrow();
    await expect(
      runNotifySlack({ post: async () => 500, url: null }, { text: "x" }),
    ).rejects.toThrow();
  });
});

describe("onboarding task words", () => {
  test("every onboarding code has a title and body in each language the server writes", () => {
    for (const code of ONBOARDING_CODES)
      for (const language of LOCALES) {
        expect(taskTitle({ code, params: {}, title: null }, language)).not.toBe("");
        expect(taskBody({ code, body: null }, language)).toBeTruthy();
      }
    expect(taskTitle({ code: "explore_demo", params: {}, title: null }, "nl-NL")).toBe(
      "Bekijk de demo die we voor je hebben gemaakt",
    );
    expect(taskTitle({ code: "book_call", params: {}, title: null }, "en-US")).toBe(
      "Book a call with us",
    );
  });
});

describe("peppol", () => {
  const logger = { warn: () => {} } as never;
  const answer = (value: string, name: string) =>
    JSON.stringify({ matches: [{ participantID: { value }, entities: [{ name: [{ name }] }] }] });

  test("tries KvK, KBO, then a Dutch or Belgian VAT number", () => {
    expect(candidates({ kvk_number: "1234 5678" })).toEqual(["0106:12345678"]);
    expect(candidates({ kbo_number: "0123.456.789" })).toEqual(["0208:0123456789"]);
    expect(candidates({ vat_id: "nl 001234567 B01" })).toEqual(["9944:NL001234567B01"]);
    expect(candidates({ vat_id: "BE0123456789" })).toEqual([
      "9925:BE0123456789",
      "0208:0123456789",
    ]);
    expect(candidates({ vat_id: "DE123456789" })).toEqual([]);
  });

  test("the first identifier the directory knows wins; an empty answer tries the next", async () => {
    const asked: string[] = [];
    const fetchText = async (url: string) => {
      asked.push(url);
      return url.includes("0106")
        ? JSON.stringify({ matches: [] })
        : answer("9944:NL001234567B01", "Gemeente X");
    };
    expect(
      await lookupPeppol(
        { fetchText, logger },
        { kvk_number: "12345678", vat_id: "NL001234567B01" },
      ),
    ).toEqual({ participant_id: "9944:NL001234567B01", name: "Gemeente X" });
    expect(asked[0]).toContain(encodeURIComponent("iso6523-actorid-upis::0106:12345678"));
  });

  test("a directory that fails is no match", async () => {
    const fetchText = async () => {
      throw new Error("down");
    };
    expect(await lookupPeppol({ fetchText, logger }, { kvk_number: "12345678" })).toBeNull();
  });
});
