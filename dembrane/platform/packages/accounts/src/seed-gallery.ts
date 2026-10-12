import type { Signed } from "@dembrane/http";
import { demoIdentity } from "@dembrane/popcorn";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { documentDetail, markViewed, nameSigner } from "./customer";
import type { AccountsDeps } from "./deps";
import type { OfferItem } from "./offer";
import { createAccount } from "./prospect";
import { signDocument } from "./signing";
import { type InvoiceInput, pushOffer, upsertInvoice } from "./staff";
import { store } from "./storage";

/**
 * Preview data for the call-to-cash surfaces, next to the main accounts demo: four more
 * fictional customers, each showing the offer, invoice and account page in another state.
 *
 * - Harbour City (sample), Dutch: signed offer, a paid and an overdue invoice.
 * - Westhoek (sample), Belgian, Dutch: offer opened but not signed and an open invoice,
 *   both with VAT reverse-charged.
 * - Northfield Library (sample), English prospect: an event offer just sent, nothing else.
 * - Riverside Region (sample), English: offer signed and its invoice paid.
 * - Lakeview Water Board (sample), English: the contact passed the offer to a colleague who
 *   has no account yet, so it waits on them.
 *
 * Invoices go through upsertInvoice the way sam mirrors them from Exact Online, which renders
 * and sends the real invoice; their PDF here is a plain placeholder standing in for Exact's. Every id is fixed and every step checks for its own row first, so a
 * second run changes nothing. Logins share the demo password; no email leaves the database.
 */

export const GALLERY_SLUG = "call-to-cash-gallery";
const id = (kind: string) => demoIdentity(GALLERY_SLUG, kind);

/** A small grey PNG standing in for a drawn signature. */
const SIGNATURE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAQCAAAAABBvGJxAAABWUlEQVR4nGNgYOcTlVHWMrSwd/MNiU7KLCiva+2ZPGvhivXb9h45fenmg+fvvv5h4RZi4BWRVtI0MLdz9QmOSszIL6tt6Z40c8HydVv3HD518cb9Z2+//GbmEpSQZ5BS1NA3s3XxDopMSM8rrWnumjhj/rK1W3YfOnnh+r2nbz7/YuIUEJdT1WFQ1zO1cfYKjIhPyy2pbuqcMH3e0jWbdx08cf7a3SevP/1k5OAXk1XRNrJkMLF28gwIj0vNKa5q7OifNnfJ6k07Dxw/d/XO41cffyB5gMHRwz8sNiW7qLKhvW/qnMWrNu7Yf+zslduPXn74/o8NyQMMfqExyVmFFfVtvVNmL1q5Yfu+o2cu33r44v23v6w8wkgeYMATIpIKSB5gwBMiarpIHmDAEyLGVkgeYMATIg7uSB5gwBMiKFHKgCdEUKKUAU+IoEQpA54QQYlSBjwhghKlAK8jOSEe5Wa7AAAAAElFTkSuQmCC";

type Lang = "en" | "nl";

/** Who the invoice is for, as the signer fills it in and the placeholder PDF prints it. */
interface BillTo {
  readonly legal_name: string;
  readonly attention: string | null;
  readonly address_line1: string;
  readonly address_line2: string | null;
  readonly postal_code: string | null;
  readonly city: string;
  readonly country: string;
  readonly vat_id: string | null;
  readonly kvk_number: string | null;
  readonly kbo_number: string | null;
}

interface GalleryOffer {
  readonly template: "subscription" | "event";
  readonly reference: string;
  readonly items: readonly OfferItem[];
  readonly vat_treatment?: "reverse_charge";
  /** "delegated": opened, then passed to someone else to sign (`signer`). */
  readonly state: "sent" | "viewed" | "delegated" | "signed";
  readonly signer?: { readonly name: string; readonly email: string; readonly role: string };
}

interface GalleryInvoice {
  readonly exactId: string;
  readonly number: string;
  /** Days from today: issued 30 days before due. */
  readonly dueInDays: number;
  readonly status: InvoiceInput["status"];
  readonly reverseCharge: boolean;
  readonly items: readonly OfferItem[];
}

interface GalleryAccount {
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly contact: string;
  readonly firstName: string;
  readonly stage: "prospect" | "customer";
  readonly language: Lang;
  readonly billTo: BillTo;
  readonly offer: GalleryOffer;
  readonly invoices: readonly GalleryInvoice[];
}

const licence = (lang: Lang, seats: number, vat: number): OfferItem => ({
  description:
    lang === "nl" ? "dembrane changemaker, jaarlicentie" : "dembrane changemaker, annual licence",
  bullets:
    lang === "nl"
      ? [`${seats} seats, 12 maanden (${seats * 12} seat-maanden)`, "Onbeperkt aantal uren opnames"]
      : [`${seats} seats, 12 months (${seats * 12} seat-months)`, "Unlimited recording hours"],
  quantity: seats * 12,
  unit_price_cents: 8600,
  vat_rate_bps: vat,
});

const workshop = (lang: Lang, vat: number): OfferItem => ({
  description: lang === "nl" ? "Onboarding workshop" : "Onboarding workshop",
  bullets:
    lang === "nl"
      ? ["Halve dag op locatie, tot 15 deelnemers"]
      : ["Half a day on site, up to 15 participants"],
  quantity: 1,
  unit_price_cents: 125000,
  vat_rate_bps: vat,
});

const eventDay = (lang: Lang, vat: number): OfferItem => ({
  description: lang === "nl" ? "dembrane voor één bijeenkomst" : "dembrane for one event",
  bullets:
    lang === "nl"
      ? ["Tot 12 tafels, opnames en verslag", "Begeleiding op de dag zelf"]
      : ["Up to 12 tables, recordings and report", "Support on the day"],
  quantity: 1,
  unit_price_cents: 395000,
  vat_rate_bps: vat,
});

function accounts(): GalleryAccount[] {
  return [
    {
      key: "harbour",
      name: "Harbour City Council (sample)",
      email: "sameer+c2c-harbour@dembrane.com",
      contact: "Sam Haven (customer demo)",
      firstName: "Sam",
      stage: "customer",
      language: "nl",
      billTo: {
        legal_name: "Gemeente Havenstad (sample)",
        attention: "Sam Haven, Financiën",
        address_line1: "Kade 12",
        address_line2: null,
        postal_code: "4321 HC",
        city: "Havenstad",
        country: "Nederland",
        vat_id: "NL009876543B01",
        kvk_number: null,
        kbo_number: null,
      },
      offer: {
        template: "subscription",
        reference: "DMB-GALLERY-HARBOUR",
        items: [licence("nl", 10, 2100), workshop("nl", 2100)],
        state: "signed",
      },
      invoices: [
        {
          exactId: "GALLERY-EXACT-HARBOUR-1",
          number: "2026-0398",
          dueInDays: -40,
          status: "paid",
          reverseCharge: false,
          items: [workshop("nl", 2100)],
        },
        {
          exactId: "GALLERY-EXACT-HARBOUR-2",
          number: "2026-0455",
          dueInDays: -9,
          status: "overdue",
          reverseCharge: false,
          items: [licence("nl", 10, 2100)],
        },
      ],
    },
    {
      key: "westhoek",
      name: "Westhoek (sample)",
      email: "sameer+c2c-westhoek@dembrane.com",
      contact: "Lien Westhoek (customer demo)",
      firstName: "Lien",
      stage: "customer",
      language: "nl",
      billTo: {
        legal_name: "Intercommunale Westhoek (sample)",
        attention: "Lien Westhoek, Boekhouding",
        address_line1: "Grote Markt 3",
        address_line2: null,
        postal_code: "8900",
        city: "Ieper",
        country: "België",
        vat_id: "BE0123456789",
        kvk_number: null,
        kbo_number: "0123.456.789",
      },
      offer: {
        template: "event",
        reference: "DMB-GALLERY-WESTHOEK",
        items: [eventDay("nl", 0)],
        vat_treatment: "reverse_charge",
        state: "viewed",
      },
      invoices: [
        {
          exactId: "GALLERY-EXACT-WESTHOEK-1",
          number: "2026-0471",
          dueInDays: 21,
          status: "open",
          reverseCharge: true,
          items: [eventDay("nl", 0)],
        },
      ],
    },
    {
      key: "northfield",
      name: "Northfield Library (sample)",
      email: "sameer+c2c-northfield@dembrane.com",
      contact: "Alex North (customer demo)",
      firstName: "Alex",
      stage: "prospect",
      language: "en",
      billTo: {
        legal_name: "Northfield Library (sample)",
        attention: null,
        address_line1: "1 Library Lane",
        address_line2: null,
        postal_code: "1000 AA",
        city: "Northfield",
        country: "Netherlands",
        vat_id: null,
        kvk_number: null,
        kbo_number: null,
      },
      offer: {
        template: "event",
        reference: "DMB-GALLERY-NORTHFIELD",
        items: [eventDay("en", 2100)],
        state: "sent",
      },
      invoices: [],
    },
    {
      key: "riverside",
      name: "Riverside Region (sample)",
      email: "sameer+c2c-riverside@dembrane.com",
      contact: "Jo Rivers (customer demo)",
      firstName: "Jo",
      stage: "customer",
      language: "en",
      billTo: {
        legal_name: "Riverside Region (sample)",
        attention: "Jo Rivers, Finance",
        address_line1: "Riverside 7",
        address_line2: null,
        postal_code: "5678 RR",
        city: "Riverton",
        country: "Netherlands",
        vat_id: "NL001112223B01",
        kvk_number: "12345678",
        kbo_number: null,
      },
      offer: {
        template: "subscription",
        reference: "DMB-GALLERY-RIVERSIDE",
        items: [licence("en", 5, 2100)],
        state: "signed",
      },
      invoices: [
        {
          exactId: "GALLERY-EXACT-RIVERSIDE-1",
          number: "2026-0402",
          dueInDays: -20,
          status: "paid",
          reverseCharge: false,
          items: [licence("en", 5, 2100)],
        },
      ],
    },
    {
      key: "lakeview",
      name: "Lakeview Water Board (sample)",
      email: "sameer+c2c-lakeview@dembrane.com",
      contact: "Sam Lake (customer demo)",
      firstName: "Sam",
      stage: "prospect",
      language: "en",
      billTo: {
        legal_name: "Lakeview Water Board (sample)",
        attention: null,
        address_line1: "Dijkweg 2",
        address_line2: null,
        postal_code: "2345 LW",
        city: "Lakeview",
        country: "Netherlands",
        vat_id: "NL002223334B01",
        kvk_number: null,
        kbo_number: null,
      },
      offer: {
        template: "subscription",
        reference: "DMB-GALLERY-LAKEVIEW",
        items: [licence("en", 3, 2100)],
        state: "delegated",
        signer: {
          name: "Taylor Lake",
          email: "sameer+c2c-lakeview-signer@dembrane.com",
          role: "Head of Finance",
        },
      },
      invoices: [],
    },
  ];
}

const day = (now: Date, days: number) =>
  new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Signs as the customer, filling every field the way a person would. */
async function sign(d: AccountsDeps, who: Signed, orgId: string, docId: string, a: GalleryAccount) {
  const doc = await store.document(d.db, orgId, docId);
  if (!doc?.sha256) throw new Error(`gallery offer ${docId} is missing or has no PDF`);
  const detail = await documentDetail(d, doc, "member");
  const name = a.contact.replace(" (customer demo)", "");
  const role = a.language === "nl" ? "Wethouder" : "Director";
  const values: Record<string, string | boolean> = {};
  for (const f of detail.fields) {
    if (f.kind === "name") values[f.id] = name;
    else if (f.kind === "role") values[f.id] = role;
    else if (f.kind === "date") values[f.id] = d.now().toISOString().slice(0, 10);
    else if (f.kind === "checkbox") values[f.id] = true;
    else if (f.kind === "text")
      values[f.id] =
        f.key === "organisation"
          ? a.billTo.legal_name
          : f.key === "address"
            ? `${a.billTo.address_line1}, ${a.billTo.city}`
            : (a.billTo.vat_id ?? "n/a");
  }
  const confirmation_text = (detail.confirmation?.dpa_authorised ?? "")
    .replace("{name}", name)
    .replace("{role}", role)
    .replace("{organisation}", a.billTo.legal_name);
  await signDocument(
    d,
    who,
    orgId,
    docId,
    {
      sha256: doc.sha256,
      values,
      signature: { png_base64: SIGNATURE_PNG, method: "drawn" },
      initials: null,
      dpa_authorised: true,
      confirmation_text,
    },
    { ip: null, userAgent: "seed:call-to-cash-gallery" },
  );
}

const euro = (cents: number) => `EUR ${(cents / 100).toFixed(2)}`;

/**
 * A plain one-page stand-in for the PDF Exact Online renders and sam uploads: enough for the
 * account page's PDF link to open something that names the invoice, nothing styled.
 */
async function placeholderPdf(
  a: GalleryAccount,
  inv: GalleryInvoice,
  t: { issuedOn: string; dueOn: string; subtotal: number; vat: number },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = [
    `Invoice ${inv.number}`,
    "Sample placeholder for the PDF Exact Online renders and sends.",
    "",
    `Billed to: ${a.billTo.legal_name}`,
    `Issued ${t.issuedOn}, due ${t.dueOn}`,
    "",
    ...inv.items.map((i) => `${i.description}: ${i.quantity} x ${euro(i.unit_price_cents)}`),
    "",
    `Subtotal ${euro(t.subtotal)}`,
    inv.reverseCharge ? "VAT reverse-charged" : `VAT ${euro(t.vat)}`,
    `Total ${euro(t.subtotal + t.vat)}`,
  ];
  text.forEach((line, i) => {
    page.drawText(line, { x: 56, y: 780 - i * 18, size: i === 0 ? 18 : 11, font });
  });
  pdf.setTitle(`Invoice ${inv.number}`);
  // Fixed dates, so the same invoice gives the same bytes on every run.
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  return pdf.save();
}

export interface GallerySummary {
  readonly org_id: string;
  readonly name: string;
  readonly login: string;
}

export async function seedCallToCashGallery(
  d: AccountsDeps,
  staff: Signed,
  password: string,
): Promise<GallerySummary[]> {
  const now = d.now();
  const out: GallerySummary[] = [];
  for (const a of accounts()) {
    const orgId = id(`org-${a.key}`);
    await createAccount(
      d,
      staff,
      {
        organisation_name: a.name,
        contact_email: a.email,
        contact_name: a.contact,
        pricing_configuration_reference: null,
        stage: a.stage,
        language: a.language,
        org_id: orgId,
      },
      { password },
    );
    const identity = await store.identityByEmail(d.db, a.email);
    const app = identity ? await store.appUserByDirectusId(d.db, identity.id) : null;
    if (!identity || !app) throw new Error(`gallery customer ${a.email} was not created`);
    const customer: Signed = {
      appUserId: app.id,
      directusUserId: identity.id,
      isStaff: false,
    };

    // The offer, pushed once and then taken to its state.
    const offerId = id(`offer-${a.key}`);
    if (!(await store.document(d.db, orgId, offerId))) {
      await pushOffer(
        d,
        staff,
        orgId,
        {
          template: a.offer.template,
          language: a.language,
          offer_name: a.name,
          person_name: a.firstName,
          attention: null,
          reference: a.offer.reference,
          title: null,
          currency: "EUR",
          date: day(now, -3),
          items: a.offer.items,
          ...(a.offer.vat_treatment ? { vat_treatment: a.offer.vat_treatment } : {}),
          external_ref: null,
          supersedes_id: null,
        },
        { document: offerId, task: id(`task-sign-${a.key}`) },
      );
      if (a.offer.state !== "sent") await markViewed(d, customer, orgId, offerId);
      if (a.offer.state === "signed") await sign(d, customer, orgId, offerId, a);
      if (a.offer.state === "delegated" && a.offer.signer)
        await nameSigner(d, customer, orgId, offerId, a.offer.signer);
    }

    for (const inv of a.invoices) {
      if (await store.documentByExactId(d.db, inv.exactId)) continue;
      const subtotal = inv.items.reduce((s, i) => s + i.quantity * i.unit_price_cents, 0);
      const vat = inv.items.reduce(
        (s, i) => s + Math.round((i.quantity * i.unit_price_cents * i.vat_rate_bps) / 10_000),
        0,
      );
      const issuedOn = day(now, inv.dueInDays - 30);
      const dueOn = day(now, inv.dueInDays);
      await upsertInvoice(d, staff, orgId, inv.exactId, {
        number: inv.number,
        issued_on: issuedOn,
        due_on: dueOn,
        subtotal_cents: subtotal,
        vat_cents: vat,
        total_cents: subtotal + vat,
        currency: "EUR",
        status: inv.status,
        paid_at: inv.status === "paid" ? `${day(now, inv.dueInDays - 5)}T10:00:00Z` : null,
        // A placeholder on a reserved domain, as in the main demo.
        payment_url: inv.status === "paid" ? null : `https://mollie.test/pay/gallery-${inv.number}`,
        payment_reference: inv.number,
        offer_id: offerId,
        pdf: await placeholderPdf(a, inv, { issuedOn, dueOn, subtotal, vat }),
      });
    }
    out.push({ org_id: orgId, name: a.name, login: a.email });
  }
  return out;
}
