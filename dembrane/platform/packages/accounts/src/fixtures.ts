import type { z } from "zod";
import type {
  AccountCard,
  AccountList,
  AccountPage,
  CreateAccountResponse,
  DemoCreateRequest,
  DemoStatus,
  DocumentDetail,
  DocumentFields,
  DocumentSummary,
  OnboardingResponse,
  PushOfferRequest,
  PushOfferResponse,
  SigningRequests,
  SignRequest,
  SignResponse,
  Task,
  TasksSummary,
  Ticket,
} from "./contract";

/**
 * The demo scenario as the API returns it, for building the UI before the backend runs:
 * Example Town Council (sample), a fictional customer, with a sent subscription offer (lines, pinned legal versions and
 * its fields), "Review and sign the offer" open, the billing details task locked, a signed
 * DPA with its PDF, an open invoice with bank details, a question answered once, the
 * one-page read, and the staff list and card. Every fixture parses against contract.ts
 * (test/contract.test.ts). Hashes and ids are illustrative, not computed.
 */

type Out<S extends z.ZodType> = z.output<S>;

const ORG = "5f1a2b3c-0d4e-4f60-8a71-92b3c4d5e6f7";
const OFFER = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const DPA = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3c";
const INVOICE = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a4d";
const SIGN_TASK = "0199a1b3-0000-7000-8000-000000000001";
const BILLING_TASK = "0199a1b3-0000-7000-8000-000000000002";
const PO_TASK = "0199a1b3-0000-7000-8000-000000000003";
const LOGO_TASK = "0199a1b3-0000-7000-8000-000000000004";
const TICKET = "0199a1b4-0000-7000-8000-000000000001";
const CUSTOMER_USER = "0199a1b5-0000-7000-8000-000000000001";
const STAFF_USER = "0199a1b5-0000-7000-8000-000000000002";
const CUSTOMER_APP_USER = "0199a1b6-0000-7000-8000-000000000001";
const SIGNATURE = "0199a1b7-0000-7000-8000-000000000001";

const C = `/api/v2/orgs/${ORG}/account`;
const bank = {
  iban: "NL49 RABO 0318910535",
  bic: "RABONL2U",
  account_name: "Dembrane B.V.",
};

const legal = {
  terms: {
    version: "2.0",
    effective_on: "2026-06-21",
    url: "https://www.dembrane.com/legal/terms",
  },
  sla: { version: "1.1", effective_on: "2026-06-21", url: "https://www.dembrane.com/legal/sla" },
  dpa: { version: "3.0.1", effective_on: "2026-07-17", url: "https://www.dembrane.com/legal/dpa" },
};

const items = [
  {
    description: "dembrane changemaker, jaarlicentie",
    bullets: [
      "5 seats, 12 maanden (60 seat-maanden)",
      "Startdatum 01-11-2026",
      "Einddatum 31-10-2027",
      "Onbeperkt aantal uren opnames",
    ],
    quantity: 60,
    unit_price_cents: 8600,
    vat_rate_bps: 2100,
  },
  {
    description: "Onboarding workshop",
    bullets: ["Halve dag op locatie, tot 15 deelnemers", "Inclusief voorbereiding"],
    quantity: 1,
    unit_price_cents: 125000,
    vat_rate_bps: 2100,
  },
];

export const pushOfferRequest: Out<typeof PushOfferRequest> = {
  template: "subscription",
  language: "nl",
  offer_name: "Example Town Council (sample)",
  person_name: "Robin",
  attention: null,
  reference: "DMB-DEMO-1",
  title: null,
  currency: "EUR",
  date: "2026-09-28",
  items,
  external_ref: "attio-deal-8f2c",
  supersedes_id: null,
  send: true,
};

const offerFields = [
  { kind: "name", label: "Naam", key: null, page: 2, y: 0.412 },
  { kind: "text", label: "Organisatie", key: "organisation", page: 2, y: 0.438 },
  { kind: "text", label: "Adres", key: "address", page: 2, y: 0.464 },
  { kind: "text", label: "Btw-nummer", key: "vat_number", page: 2, y: 0.49 },
  { kind: "role", label: "Functie", key: null, page: 2, y: 0.516 },
  { kind: "date", label: "Datum van ondertekening", key: null, page: 2, y: 0.542 },
  { kind: "signature", label: "Handtekening", key: null, page: 2, y: 0.568 },
].map((f, i) => ({
  id: `0199a1b8-0000-7000-8000-00000000000${i + 1}`,
  page: f.page,
  x: 0.36,
  y: f.y,
  width: f.kind === "signature" ? 0.3 : 0.45,
  height: f.kind === "signature" ? 0.06 : 0.022,
  kind: f.kind as "name" | "text" | "role" | "date" | "signature",
  label: f.label,
  required: f.key !== "vat_number",
  signer_role: "signer" as const,
  key: f.key,
  sort: i,
}));

const offerSummary: Out<typeof DocumentSummary> = {
  id: OFFER,
  kind: "offer",
  title: "Example Town Council (sample) x dembrane",
  reference: "DMB-DEMO-1",
  language: "nl",
  version: 1,
  status: "sent",
  requires_signature: true,
  currency: "EUR",
  subtotal_cents: 641000,
  vat_cents: 134610,
  total_cents: 775610,
  valid_until: "2026-10-12",
  sent_at: "2026-09-28T09:00:00.000Z",
  viewed_at: null,
  signed_at: null,
  declined_at: null,
  voided_at: null,
  signer: null,
  file_url: `${C}/documents/${OFFER}/file`,
  signed_pdf_url: null,
};

export const offerDetail: Out<typeof DocumentDetail> = {
  ...offerSummary,
  body: "dembrane B.V.\nAddress: Sint Janssingel 88, ‘s-Hertogenbosch, NL\n...\n# Example Town Council (sample) x dembrane\n28-09-2026 | Offer ID: DMB-DEMO-1\n...",
  content: {
    template: "subscription",
    language: "nl",
    offer_name: "Example Town Council (sample)",
    date: "2026-09-28",
    reference: "DMB-DEMO-1",
    person_name: "Robin",
    attention: null,
    currency: "EUR",
    valid_days: 14,
    company: {
      name: "dembrane B.V.",
      address: "Sint Janssingel 88, ‘s-Hertogenbosch, NL",
      vat: "NL864967433B01",
      kvk: "89391438",
      iban: bank.iban,
      bic: bank.bic,
    },
    legal,
    items,
  },
  lines: [
    {
      ...(items[0] as (typeof items)[number]),
      net_cents: 516000,
      vat_cents: 108360,
      total_cents: 624360,
    },
    {
      ...(items[1] as (typeof items)[number]),
      net_cents: 125000,
      vat_cents: 26250,
      total_cents: 151250,
    },
  ],
  sha256: "9b4f3c1e2a7d8e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f",
  page_count: 2,
  fields: offerFields,
  legal: [
    {
      kind: "terms",
      ...legal.terms,
      sha256: "4e2d1c0b9a8f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3a2918070f6e",
    },
    {
      kind: "sla",
      ...legal.sla,
      sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    },
    {
      kind: "dpa",
      ...legal.dpa,
      sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    },
  ],
  signing_note:
    "Met je handtekening is de overeenkomst compleet: wij kunnen factureren, en je voorwaarden, SLA en verwerkersovereenkomst gelden.",
  confirmation: {
    dpa_authorised:
      'Ik, {name}, {role}, bevestig dat ik namens {organisation} mag tekenen, en ik onderteken "Example Town Council (sample) x dembrane" (DMB-DEMO-1) zoals aan mij getoond, SHA-256 9b4f3c1e2a7d8e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f. Ik ben ook bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan.',
    dpa_not_authorised:
      'Ik, {name}, {role}, bevestig dat ik namens {organisation} mag tekenen, en ik onderteken "Example Town Council (sample) x dembrane" (DMB-DEMO-1) zoals aan mij getoond, SHA-256 9b4f3c1e2a7d8e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f. Ik ben niet bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan; de verwerkersovereenkomst wordt apart ondertekend.',
  },
  signature: null,
  access: "member",
};

const dpaSummary: Out<typeof DocumentSummary> = {
  id: DPA,
  kind: "dpa",
  title: "Data Processing Agreement (DPA) 3.0.1",
  reference: "DMB-DEMO-0-DPA",
  language: "nl",
  version: 1,
  status: "signed",
  requires_signature: true,
  currency: null,
  subtotal_cents: null,
  vat_cents: null,
  total_cents: null,
  valid_until: null,
  sent_at: "2026-09-20T10:00:00.000Z",
  viewed_at: "2026-09-21T08:12:00.000Z",
  signed_at: "2026-09-21T08:20:31.000Z",
  declined_at: null,
  voided_at: null,
  signer: {
    email: "privacy@example-town.example",
    name: "Alex Example",
    role: "Functionaris gegevensbescherming",
  },
  file_url: `${C}/documents/${DPA}/file`,
  signed_pdf_url: `${C}/documents/${DPA}/signed.pdf`,
};

export const signedDpaDetail: Out<typeof DocumentDetail> = {
  ...dpaSummary,
  body: 'This Data Processing Agreement ("Processing Agreement") is an annex to the General Terms and Conditions ...',
  content: null,
  lines: null,
  sha256: "c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4",
  page_count: 9,
  fields: [
    {
      id: "0199a1b9-0000-7000-8000-000000000001",
      page: 9,
      x: 0.1,
      y: 0.62,
      width: 0.45,
      height: 0.022,
      kind: "name",
      label: "Name",
      required: true,
      signer_role: "signer",
      key: null,
      sort: 0,
    },
    {
      id: "0199a1b9-0000-7000-8000-000000000002",
      page: 9,
      x: 0.1,
      y: 0.66,
      width: 0.45,
      height: 0.022,
      kind: "role",
      label: "Role",
      required: true,
      signer_role: "signer",
      key: null,
      sort: 1,
    },
    {
      id: "0199a1b9-0000-7000-8000-000000000003",
      page: 9,
      x: 0.1,
      y: 0.7,
      width: 0.45,
      height: 0.022,
      kind: "text",
      label: "Organisation",
      required: true,
      signer_role: "signer",
      key: "organisation",
      sort: 2,
    },
    {
      id: "0199a1b9-0000-7000-8000-000000000004",
      page: 9,
      x: 0.1,
      y: 0.74,
      width: 0.25,
      height: 0.022,
      kind: "date",
      label: "Date",
      required: true,
      signer_role: "signer",
      key: null,
      sort: 3,
    },
    {
      id: "0199a1b9-0000-7000-8000-000000000005",
      page: 9,
      x: 0.1,
      y: 0.78,
      width: 0.3,
      height: 0.06,
      kind: "signature",
      label: "Signature",
      required: true,
      signer_role: "signer",
      key: null,
      sort: 4,
    },
  ],
  legal: [
    {
      kind: "dpa",
      ...legal.dpa,
      sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    },
  ],
  signing_note:
    "Met je handtekening geldt de verwerkersovereenkomst, en is de overeenkomst compleet.",
  confirmation: {
    dpa_authorised:
      'Ik, {name}, {role}, bevestig dat ik namens {organisation} mag tekenen, en ik onderteken "Data Processing Agreement (DPA) 3.0.1" (DMB-DEMO-0-DPA) zoals aan mij getoond, SHA-256 c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4.',
    dpa_not_authorised: null,
  },
  signature: {
    id: SIGNATURE,
    name: "Alex Example",
    role: "Functionaris gegevensbescherming",
    email: "privacy@example-town.example",
    organisation: "Example Town Council (sample)",
    address: null,
    vat_number: null,
    dpa_authorised: true,
    signed_at: "2026-09-21T08:20:31.000Z",
    sha256: "c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4",
    method: "drawn",
    image_sha256: "5e4d3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a392817060",
    values: {
      "0199a1b9-0000-7000-8000-000000000001": "Alex Example",
      "0199a1b9-0000-7000-8000-000000000002": "Functionaris gegevensbescherming",
      "0199a1b9-0000-7000-8000-000000000003": "Example Town Council (sample)",
      "0199a1b9-0000-7000-8000-000000000004": "21-09-2026",
    },
  },
  access: "member",
};

const invoiceSummary: Out<typeof DocumentSummary> = {
  id: INVOICE,
  kind: "invoice",
  title: "Invoice 2026-0421",
  reference: "2026-0421",
  language: "nl",
  version: 1,
  status: "sent",
  requires_signature: false,
  currency: "EUR",
  subtotal_cents: 125000,
  vat_cents: 26250,
  total_cents: 151250,
  valid_until: null,
  sent_at: "2026-09-28T09:05:00.000Z",
  viewed_at: null,
  signed_at: null,
  declined_at: null,
  voided_at: null,
  signer: null,
  file_url: `${C}/documents/${INVOICE}/file`,
  signed_pdf_url: null,
  invoice: {
    number: "2026-0421",
    exact_id: "DEMO-EXACT-0001",
    issued_on: "2026-09-28",
    due_on: "2026-10-28",
    status: "open",
    paid_at: null,
    bank_transfer: { ...bank, reference: "2026-0421" },
    payment_url: "https://mollie.test/pay/demo-2026-0421",
  },
};

export const signTask: Out<typeof Task> = {
  id: SIGN_TASK,
  code: "sign_offer",
  params: { document_title: "Example Town Council (sample) x dembrane" },
  title: null,
  body: null,
  kind: "sign",
  status: "open",
  locked: false,
  locked_until_document_id: null,
  locked_until_title: null,
  document_id: OFFER,
  due_on: null,
  opened_at: "2026-09-28T09:00:00.000Z",
  response_text: null,
  response_file_name: null,
  submitted_at: null,
  review_note: null,
  reviewed_at: null,
  next_reminder_at: "2026-10-05T09:00:00.000Z",
  reminder_interval_days: null,
  reminders_sent: 0,
};

export const billingTask: Out<typeof Task> = {
  ...signTask,
  id: BILLING_TASK,
  code: "billing_details",
  params: {},
  title: null,
  body: null,
  kind: "billing_details",
  status: "locked",
  locked: true,
  locked_until_document_id: OFFER,
  locked_until_title: "Example Town Council (sample) x dembrane",
  document_id: null,
  opened_at: null,
  next_reminder_at: null,
};

const poTask: Out<typeof Task> = {
  ...signTask,
  id: PO_TASK,
  code: null,
  params: null,
  title: "Stuur ons jullie PO-nummer",
  body: "Werken jullie met inkoopordernummers? Stuur het nummer, dan zetten we het op de factuur.",
  kind: "generic",
  document_id: null,
};

const logoTask: Out<typeof Task> = {
  ...signTask,
  id: LOGO_TASK,
  code: null,
  params: null,
  title: "Upload jullie logo",
  body: "Voor de presentatie en het rapport: een logo als SVG of PNG.",
  kind: "upload",
  status: "submitted",
  document_id: null,
  response_text: "Hierbij ons logo.",
  response_file_name: "example-town-logo.svg",
  submitted_at: "2026-09-28T09:10:00.000Z",
  next_reminder_at: null,
};

export const ticket: Out<typeof Ticket> = {
  id: TICKET,
  subject: "Kunnen we per kwartaal betalen?",
  status: "waiting_on_customer",
  created_at: "2026-09-28T09:15:00.000Z",
  updated_at: "2026-09-28T09:16:00.000Z",
  closed_at: null,
  messages: [
    {
      id: "0199a1ba-0000-7000-8000-000000000001",
      body: "Onze afdeling financien vraagt of de jaarlicentie ook per kwartaal gefactureerd kan worden.",
      from: "customer",
      created_at: "2026-09-28T09:15:00.000Z",
    },
    {
      id: "0199a1ba-0000-7000-8000-000000000002",
      body: "Dat kan. Na ondertekening zetten we de facturatie op vier kwartaalfacturen; het totaal blijft gelijk.",
      from: "dembrane",
      created_at: "2026-09-28T09:16:00.000Z",
    },
  ],
};

const organisation = {
  id: ORG,
  name: "Example Town Council (sample)",
  account_stage: "customer" as const,
};
const emptyBilling = {
  legal_name: null,
  vat_id: null,
  kvk_number: null,
  kbo_number: null,
  billing_email: "robin@example-town.example",
  po_number: null,
  peppol_id: null,
  address_line1: null,
  address_line2: null,
  postal_code: null,
  city: null,
  country: null,
};

/** The billing details task once the customer saved the details: done at once, no review. */
export const billingTaskDone: Out<typeof Task> = {
  ...billingTask,
  status: "done",
  locked: false,
  locked_until_document_id: null,
  locked_until_title: null,
  opened_at: "2026-09-29T08:00:00.000Z",
  submitted_at: "2026-09-29T08:04:00.000Z",
  next_reminder_at: null,
};

/** GET /api/v2/orgs/:orgId/account */
export const accountPage: Out<typeof AccountPage> = {
  organisation,
  tasks: [signTask, poTask, billingTask, logoTask],
  documents: [offerSummary, invoiceSummary, dpaSummary],
  billing: emptyBilling,
  tickets: [ticket],
  needs_form_reference: "DEM-7K2P",
};

export const signRequest: Out<typeof SignRequest> = {
  sha256: offerDetail.sha256 as string,
  values: {
    [offerFields[0]?.id as string]: "Robin Example",
    [offerFields[1]?.id as string]: "Example Town Council (sample)",
    [offerFields[2]?.id as string]: "Example Street 1, 0000 XX Example Town",
    [offerFields[3]?.id as string]: "NL000099998B57",
    [offerFields[4]?.id as string]: "Wethouder",
    [offerFields[5]?.id as string]: "28-09-2026",
  },
  signature: {
    png_base64: `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg${"A".repeat(40)}`,
    method: "drawn",
  },
  initials: null,
  dpa_authorised: true,
  confirmation_text:
    'Ik, Robin Example, Wethouder, bevestig dat ik namens Example Town Council (sample) mag tekenen, en ik onderteken "Example Town Council (sample) x dembrane" (DMB-DEMO-1) zoals aan mij getoond, SHA-256 9b4f3c1e2a7d8e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f. Ik ben ook bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan.',
};

export const signResponse: Out<typeof SignResponse> = {
  signature_id: "0199a1b7-0000-7000-8000-000000000002",
  signed_at: "2026-09-28T10:02:11.000Z",
  confirmation_text: signRequest.confirmation_text,
};

export const signingRequests: Out<typeof SigningRequests> = [
  { organisation: { id: ORG, name: "Example Town Council (sample)" }, document: offerSummary },
];

/** GET /api/v2/admin/accounts */
export const accountList: Out<typeof AccountList> = {
  accounts: [
    {
      id: ORG,
      name: "Example Town Council (sample)",
      stage: "customer",
      created_at: "2026-09-28T08:55:00.000Z",
      open_tasks: 2,
      waiting_on_us: 1,
      unsigned_documents: 1,
      overdue_invoices: 0,
      open_tickets: 1,
    },
  ],
  limit: 50,
  offset: 0,
};

/** GET /api/v2/admin/accounts/:orgId */
export const accountCard: Out<typeof AccountCard> = {
  organisation: { ...organisation, created_at: "2026-09-28T08:55:00.000Z" },
  account_manager: null,
  billing: emptyBilling,
  needs_form: {
    id: "0199a1bb-0000-7000-8000-000000000001",
    reference: "DEM-7K2P",
    status: "submitted",
    email: "robin@example-town.example",
    answers: { volume: "20-50 conversations a month", use: "participatie bij de omgevingsvisie" },
    config: { tier: "changemaker", seats: 5 },
    booking_status: "accepted",
    booking_uid: "cal-7f3d",
  },
  demo: {
    slug: "voorbeeldwonen",
    links: { nl: { public_link: "https://api.example.test/api/v2/popcorn/public/abc123/" } },
  },
  members: [
    {
      app_user_id: CUSTOMER_APP_USER,
      email: "robin@example-town.example",
      name: "Robin Voorbeeld (klant demo)",
      role: "admin",
      since: "2026-09-28T08:55:00.000Z",
    },
  ],
  pending_invites: [],
  usage: { workspaces: 1, projects: 2 },
  documents: [offerSummary, invoiceSummary, dpaSummary].map((x) => ({
    ...x,
    file_url: x.file_url?.replace(C, `/api/v2/admin/accounts/${ORG}`) ?? null,
    signed_pdf_url: x.signed_pdf_url?.replace(C, `/api/v2/admin/accounts/${ORG}`) ?? null,
  })),
  tasks: [signTask, billingTask, poTask, logoTask],
  tickets: [ticket],
  timeline: [
    {
      id: "0199a1bc-0000-7000-8000-000000000003",
      type: "document.sent",
      actor: "staff",
      actor_user_id: STAFF_USER,
      subject_type: "document",
      subject_id: OFFER,
      detail: {
        kind: "offer",
        total_cents: 775610,
        pinned: { terms: "2.0", sla: "1.1", dpa: "3.0.1" },
      },
      created_at: "2026-09-28T09:00:00.000Z",
    },
    {
      id: "0199a1bc-0000-7000-8000-000000000002",
      type: "demo.seeded",
      actor: "staff",
      actor_user_id: STAFF_USER,
      subject_type: null,
      subject_id: null,
      detail: { slug: "voorbeeldwonen" },
      created_at: "2026-09-28T08:56:00.000Z",
    },
    {
      id: "0199a1bc-0000-7000-8000-000000000001",
      type: "account.created",
      actor: "staff",
      actor_user_id: STAFF_USER,
      subject_type: null,
      subject_id: null,
      detail: { stage: "customer", contact: "robin@example-town.example" },
      created_at: "2026-09-28T08:55:00.000Z",
    },
  ],
};

export const pushOfferResponse: Out<typeof PushOfferResponse> = {
  document: { ...offerDetail, access: "staff" },
  task: signTask,
};

export const createAccountResponse: Out<typeof CreateAccountResponse> = {
  org_id: ORG,
  created: true,
  contact: { user_id: CUSTOMER_USER, created: true },
  pricing_configuration_id: "0199a1bb-0000-7000-8000-000000000001",
  continue_url: `https://dashboard.example.test/login?next=${encodeURIComponent(`/o/${ORG}/account`)}`,
};

export const offerFieldsResponse: Out<typeof DocumentFields> = {
  document_id: OFFER,
  status: "sent",
  page_count: 2,
  fields: offerFields,
};

export { signedDpaDetail as signedDocument };

/** GET /api/v2/account/tasks-summary: "Tasks 1/4" under Help, and the org picker. */
export const tasksSummary: Out<typeof TasksSummary> = [
  {
    org_id: ORG,
    name: "Example Town Council (sample)",
    logo_url: null,
    account_stage: "customer",
    tasks_done: 0,
    tasks_total: 4,
    tasks_waiting: 2,
    next_task_title: null,
    next_task_code: "sign_offer",
    next_task_params: { document_title: "Example Town Council (sample) x dembrane" },
  },
];

const DEMO_PROJECT = "0199a1bd-0000-7000-8000-0000000000a1";
const DEMO_WORKSPACE = "0199a1bd-0000-7000-8000-0000000000a2";

/** An onboarding task: done by the step itself, never a reminder. */
const onboardingTask = (
  id: string,
  code: "explore_demo" | "watch_tutorial" | "create_project" | "book_call",
  params: Record<string, string>,
  status: "open" | "done" = "open",
): Out<typeof Task> => ({
  ...signTask,
  id,
  code,
  params,
  kind: "generic",
  status,
  document_id: null,
  next_reminder_at: null,
});

/** POST /api/v2/admin/accounts/:orgId/onboarding: a prospect who already opened the demo. */
export const onboardingResponse: Out<typeof OnboardingResponse> = {
  added: ["explore_demo", "watch_tutorial", "create_project", "book_call"],
  tasks: [
    onboardingTask(
      "0199a1bd-0000-7000-8000-0000000000b1",
      "explore_demo",
      { project_id: DEMO_PROJECT, workspace_id: DEMO_WORKSPACE },
      "done",
    ),
    onboardingTask("0199a1bd-0000-7000-8000-0000000000b2", "watch_tutorial", {}),
    onboardingTask("0199a1bd-0000-7000-8000-0000000000b3", "create_project", {
      workspace_id: DEMO_WORKSPACE,
    }),
    onboardingTask("0199a1bd-0000-7000-8000-0000000000b4", "book_call", {}),
  ],
};

const DEMO = "0199a1bd-0000-7000-8000-000000000001";

/** POST /api/v2/admin/accounts/demos */
export const demoCreateRequest: Out<typeof DemoCreateRequest> = {
  organisation_name: "Example Town Council (sample)",
  website_url: "https://www.example-town.example/",
  brief:
    "Participatie bij de nieuwe omgevingsvisie: bewoners, ondernemers en jongeren denken mee over wonen en groen in de binnenstad.",
  language: "nl",
  example: "Een avond in de bibliotheek met zestig bewoners, in maart.",
  contact_name: "Alex Example",
  contact_email: "robin@example-town.example",
  sign_in: true,
  offer: {
    template: "subscription",
    language: "nl",
    person_name: "Robin",
    attention: null,
    items,
    external_ref: null,
  },
};

const steps = (done: number, failed?: number) =>
  (["fetch", "research", "author", "seed", "extract", "review"] as const).map((name, i) => ({
    name,
    status:
      i < done
        ? ("done" as const)
        : i === failed
          ? ("failed" as const)
          : i === done
            ? ("running" as const)
            : ("pending" as const),
    started_at: i <= done ? `2026-09-28T09:0${i}:00.000Z` : null,
    finished_at: i < done ? `2026-09-28T09:0${i}:40.000Z` : null,
    error: i === failed ? "The model did not answer in time" : null,
  }));

/** GET .../demos/:demoId while it is authoring. */
export const demoRunning: Out<typeof DemoStatus> = {
  id: DEMO,
  status: "running",
  organisation_name: "Example Town Council (sample)",
  website_url: "https://www.example-town.example/",
  language: "nl",
  contact_email: "robin@example-town.example",
  sign_in: true,
  org_id: null,
  slug: null,
  steps: steps(2),
  links: { public: [], projects: [], account: null, continue_url: null },
  research: null,
  conversations: null,
  offer_document_id: null,
  invited_at: null,
  published_at: null,
  created_at: "2026-09-28T09:00:00.000Z",
  updated_at: "2026-09-28T09:02:00.000Z",
};

/** A step that failed: POST .../retry resumes from it. */
export const demoFailed: Out<typeof DemoStatus> = {
  ...demoRunning,
  status: "failed",
  steps: steps(2, 2),
};

/** The reviewable draft: links work for staff, the public link is not live yet. */
export const demoDraft: Out<typeof DemoStatus> = {
  ...demoRunning,
  status: "draft",
  org_id: ORG,
  slug: "example-town-council-sample",
  steps: steps(6),
  links: {
    public: [
      {
        language: "nl",
        url: "https://api.example.test/api/v2/popcorn/public/k2Jd8fQx0aLm3PzR7tVw1yB5/",
        live: false,
      },
    ],
    projects: [
      {
        language: "nl",
        project_id: "0199a1be-0000-7000-8000-000000000001",
        url: "https://dashboard.example.test/projects/0199a1be-0000-7000-8000-000000000001/overview",
      },
    ],
    account: `/api/v2/admin/accounts/${ORG}`,
    continue_url: `https://dashboard.example.test/login?next=${encodeURIComponent(`/o/${ORG}/account`)}`,
  },
  research:
    "# Example Town Council (sample): research\n\nRetrieved 28-09-2026 from https://www.example-town.example/ ...\n\n## Verified facts\n- ...\n\n## Unknowns\n- ...\n\n## Invented themes (fiction)\n- ...",
  conversations: 6,
  offer_document_id: OFFER,
};

/** After POST .../publish with sign-in on: live, and the contact invited. */
export const demoPublished: Out<typeof DemoStatus> = {
  ...demoDraft,
  status: "published",
  links: {
    ...demoDraft.links,
    public: demoDraft.links.public.map((p) => ({ ...p, live: true })),
  },
  invited_at: "2026-09-28T10:00:00.000Z",
  published_at: "2026-09-28T10:00:00.000Z",
};
