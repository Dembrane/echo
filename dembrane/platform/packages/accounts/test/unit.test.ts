import { describe, expect, test } from "bun:test";
import { assetPath } from "@dembrane/core";
import { LOCALES } from "@dembrane/i18n";
import { PDFDocument } from "pdf-lib";
import { walkOrder } from "../src/documents";
import { runDeliverEvent, runNotifySlack } from "../src/jobs";
import { legalSha256, parseLegalDump, parseLegalPage } from "../src/legal/parse";
import { REFERENCE_DPA, REFERENCE_SLA, REFERENCE_TERMS } from "../src/legal/reference";
import { priceLines, vatOf } from "../src/money";
import { euro, layoutOffer, type OfferContent, offerText } from "../src/offer";
import { ONBOARDING_CODES } from "../src/onboarding";
import { offerPdf, signedPdf, textPdf } from "../src/pdf";
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
  test("amounts as the templates write them", () => {
    expect(euro(8600)).toBe("€86");
    expect(euro(125000)).toBe("€1.250");
    expect(euro(123456)).toBe("€1.234,56");
  });
});

describe("the offer", () => {
  test("follows the template: letterhead, title, meta, columns, total, acceptance, pinned versions", () => {
    const text = offerText(offer());
    expect(text).toContain("IBAN: NL49 RABO 0318910535");
    expect(text).toContain("# Gemeente Voorbeeldstad x dembrane");
    expect(text).toContain("28-09-2026 | Offer ID: DMB-1");
    expect(text).toContain(
      "| Description | Price per seat/month (excl. VAT) | Amount of seats | Total Price (excl. VAT) |",
    );
    expect(text).toContain("| Changemaker<br>• Unlimited recording hours | €86 | 60 | €5.160 |");
    expect(text).toContain("Total price (excl. VAT): €6.410");
    expect(text).toContain(
      "Annex B: Data Processing Agreement (version 3.0.1, 17-07-2026, https://www.dembrane.com/legal/dpa)",
    );
    expect(text).toContain("valid for 14 days");
    const nl = offerText(offer({ language: "nl" }));
    expect(nl).toContain("met het btw nummer");
    expect(nl).toContain("Bijlage B: Verwerkersovereenkomst (versie 3.0.1, 17-07-2026");
    const event = layoutOffer(offer({ template: "event", attention: "Anna" }));
    expect(event.columns).toEqual([
      "Description",
      "Quantity",
      "Price per Unit",
      "Total Price (excl. VAT)",
    ]);
    expect(event.rows[0]?.cells).toEqual(["60", "€86", "€5.160"]);
    expect(event.meta).toBe("28-09-2026 | Offer ID: DMB-1 | Attn. Anna");
    expect(
      layoutOffer(offer({ template: "event", language: "nl" })).acceptance.fields.some(
        (f) => f.key === "vat_number",
      ),
    ).toBe(false);
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
  test("events go to the configured URL with the secret; 4xx is final, 5xx retries, unset is off", async () => {
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
    await runDeliverEvent({ deliver: deliver(500), url: null, secret: null, logger: silent }, p);
    expect(seen).toHaveLength(3);
  });
  test("Slack gets the line; a refusal retries; unset is off", async () => {
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
    await runNotifySlack({ post: async () => 500, url: null }, { text: "x" });
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
      "Bekijk je demo",
    );
    expect(taskTitle({ code: "book_call", params: {}, title: null }, "en-US")).toBe(
      "Book a call with us",
    );
  });
});
