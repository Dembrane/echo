import { join } from "node:path";
import type { Access } from "@echo/access";
import { MemoryStaffAudit } from "@echo/access";
import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import type { Signed } from "@echo/http";
import type { Logger } from "@echo/observability";
import {
  demoFromFixture,
  demoIdentity,
  type Json,
  refuseProduction,
  seedDemo,
} from "@echo/popcorn";
import type { ObjectStorage } from "@echo/storage";
import { and, eq } from "drizzle-orm";
import type { AccountsDeps, Company } from "./deps";
import { emit } from "./events";
import { seedLegalTexts } from "./legal/store";
import { createAccount, ensureUser } from "./prospect";
import { sha256Hex } from "./signing";
import { MemoryJobs } from "./sink";
import { pushOffer } from "./staff";
import { store } from "./storage";
import { createTask, settleTask } from "./tasks";

/**
 * The accounts demo on a non-production database (docs/accounts.md, "Demo"): a fictional
 * customer, Gemeente Voorbeeldstad, with the example synthetic demo, a sent subscription
 * offer and its signing task, the locked billing task, a PO task (open), a logo task
 * (submitted, waiting for our review), an open invoice, a question answered once, and the
 * timeline all of that writes. Two people sign in with email and password: the customer's
 * admin and a staff Administrator. Every id is fixed, so a second run changes nothing;
 * after someone signs, declines or voids the demo offer, the next run pushes a fresh one.
 */

export const DEMO_SLUG = "accounts-demo-28sep";
export const CUSTOMER_EMAIL = "sameer+28sep@dembrane.com";
export const STAFF_EMAIL = "sameer+28sep-staff@dembrane.com";
export const ORG_NAME = "Gemeente Voorbeeldstad";

const id = (kind: string) => demoIdentity(DEMO_SLUG, kind);
export const DEMO_IDS = {
  org: id("org"),
  workspace: id("workspace"),
  poTask: id("task-po"),
  logoTask: id("task-logo"),
  ticket: id("ticket"),
  invoice: id("invoice"),
};

export interface SeedOptions {
  readonly db: Db;
  readonly files: ObjectStorage;
  readonly access: Access;
  readonly logger: Logger;
  readonly now: Date;
  /** From DEMO_PASSWORD; never logged or stored in plain text. */
  readonly password: string;
  readonly env: string;
  readonly dashboardUrl: string;
  readonly portalUrl: string;
  readonly apiUrl: string;
  readonly company: Company;
  /** echo/demos, for the example fixture and the sales portal words. */
  readonly demosDir: string;
  /** The demo's language (DEMO_LANGUAGE): the offer, tasks, question and corpus follow it. */
  readonly language?: "en" | "nl";
  /** Offers pin texts from dembrane.com; the seed passes a fetcher that fails fast offline. */
  readonly fetchText: (url: string) => Promise<string>;
}

/** Everything the demo writes in words, per language. */
const WORDS = {
  en: {
    contact: "Sameer (customer demo)",
    workspace: "Example town",
    example: "example-en",
    portal: "en-US",
    offer: {
      licence: "dembrane changemaker, annual licence",
      licenceBullets: [
        "5 seats, 12 months (60 seat-months)",
        "Start date 01-11-2026",
        "End date 31-10-2027",
        "Unlimited recording hours",
      ],
      workshop: "Onboarding workshop",
      workshopBullets: ["Half a day on site, up to 15 participants", "Preparation included"],
    },
    po: {
      title: "Send us your PO number",
      body: "Do you work with purchase order numbers? Send us the number and we put it on the invoice.",
    },
    logo: {
      title: "Upload your logo",
      body: "For the presentation and the report: a logo as SVG or PNG.",
      reply: "Here is our logo.",
    },
    ticket: {
      subject: "Can we pay per quarter?",
      ask: "Our finance team asks whether the annual licence can also be invoiced per quarter.",
      answer:
        "Yes. Once it is signed we invoice in four quarterly invoices; the total stays the same.",
    },
  },
  nl: {
    contact: "Sameer (klant demo)",
    workspace: "Voorbeeldstad",
    example: "example",
    portal: "nl-NL",
    offer: {
      licence: "dembrane changemaker, jaarlicentie",
      licenceBullets: [
        "5 seats, 12 maanden (60 seat-maanden)",
        "Startdatum 01-11-2026",
        "Einddatum 31-10-2027",
        "Onbeperkt aantal uren opnames",
      ],
      workshop: "Onboarding workshop",
      workshopBullets: ["Halve dag op locatie, tot 15 deelnemers", "Inclusief voorbereiding"],
    },
    po: {
      title: "Stuur ons jullie PO-nummer",
      body: "Werken jullie met inkoopordernummers? Stuur het nummer, dan zetten we het op de factuur.",
    },
    logo: {
      title: "Upload jullie logo",
      body: "Voor de presentatie en het rapport: een logo als SVG of PNG.",
      reply: "Hierbij ons logo.",
    },
    ticket: {
      subject: "Kunnen we per kwartaal betalen?",
      ask: "Onze afdeling financien vraagt of de jaarlicentie ook per kwartaal gefactureerd kan worden.",
      answer:
        "Dat kan. Na ondertekening zetten we de facturatie op vier kwartaalfacturen; het totaal blijft gelijk.",
    },
  },
} as const;

export const PRODUCTION_REFUSAL =
  "The accounts demo is for staging environments, never production.";

export interface SeedSummary {
  readonly org_id: string;
  readonly offer_id: string;
  readonly offer_created: boolean;
  readonly demo_links: Json;
  readonly customer_email: string;
  readonly staff_email: string;
}

async function administratorRole(db: Db): Promise<string> {
  const [row] = await db
    .select({ id: schema.directus_roles.id })
    .from(schema.directus_roles)
    .where(eq(schema.directus_roles.name, "Administrator"))
    .limit(1);
  if (row) return row.id;
  const roleId = id("administrator-role");
  await db
    .insert(schema.directus_roles)
    .values({ id: roleId, name: "Administrator", icon: "verified", description: "dembrane staff" })
    .onConflictDoNothing();
  return roleId;
}

export async function seedAccountsDemo(o: SeedOptions): Promise<SeedSummary> {
  if (o.env === "prod") throw new Error(PRODUCTION_REFUSAL);
  refuseProduction([o.dashboardUrl, o.portalUrl, o.apiUrl]);
  if (o.password.length < 12) throw new Error("DEMO_PASSWORD must be at least 12 characters");
  const lang = o.language ?? "en";
  const w = WORDS[lang];

  const jobs = new MemoryJobs();
  const d: AccountsDeps = {
    db: o.db,
    access: o.access,
    staffAudit: new MemoryStaffAudit(),
    // Nothing leaves the database: no emails, Slack or events for sam from a demo.
    jobs,
    files: o.files,
    logger: o.logger,
    now: () => o.now,
    fetchText: o.fetchText,
    settings: {
      dashboardUrl: o.dashboardUrl,
      company: o.company,
      eventsEnabled: false,
      slackEnabled: false,
      reminderIntervalDays: 7,
      inviteSecret: "unused",
    },
  };
  const nowIso = o.now.toISOString();
  const hash = await Bun.password.hash(o.password, { algorithm: "argon2id" });
  await seedLegalTexts(o.db, o.now);

  const adminRole = await administratorRole(o.db);
  const staffUser = await o.db.transaction((tx) =>
    ensureUser(tx, {
      email: STAFF_EMAIL,
      name: "Sameer (staff demo)",
      passwordHash: hash,
      nowIso,
      directusRoleId: adminRole,
    }),
  );
  const staff: Signed = {
    appUserId: staffUser.appUserId,
    directusUserId: staffUser.userId,
    isStaff: true,
  };

  const account = await createAccount(
    d,
    staff,
    {
      organisation_name: ORG_NAME,
      contact_email: CUSTOMER_EMAIL,
      contact_name: w.contact,
      pricing_configuration_reference: null,
      stage: "customer",
      language: lang,
      org_id: DEMO_IDS.org,
    },
    { password: o.password },
  );
  await store.updateOrg(o.db, account.org_id, { account_stage: "customer", updated_at: nowIso });
  const customer = await store.identityByEmail(o.db, CUSTOMER_EMAIL);
  const customerApp = customer ? await store.appUserByDirectusId(o.db, customer.id) : null;
  if (!customer || !customerApp) throw new Error("demo customer was not created");

  // A workspace for the synthetic demo, on the organisation's own billing account.
  const billing = await store.billing(o.db, account.org_id);
  if (!billing) throw new Error("demo organisation has no billing account");
  await o.db
    .insert(schema.workspace)
    .values({
      id: DEMO_IDS.workspace,
      org_id: account.org_id,
      name: w.workspace,
      billing_account_id: billing.id,
      visibility: "open_to_organisation",
      is_default: true,
      created_by: customerApp.id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .onConflictDoNothing();

  const fixture = (await Bun.file(join(o.demosDir, `${w.example}/fixture.json`)).json()) as Json;
  const research = await Bun.file(join(o.demosDir, `${w.example}/research.md`)).text();
  const salesPortal = (await Bun.file(join(o.demosDir, "sales-portal.json")).json()) as Record<
    string,
    Json
  >;
  const inputs = demoFromFixture(
    fixture,
    `${o.portalUrl.replace(/\/+$/, "")}/${w.portal}/sales/start`,
  );
  const seeded = await seedDemo(
    o.db,
    {
      ...inputs,
      research,
      salesPortal,
      workspaceId: DEMO_IDS.workspace,
      ownerId: customer.id,
      portalBaseUrl: o.portalUrl,
      apiBaseUrl: o.apiUrl,
      dryRun: false,
      continueUrl: account.continue_url,
    },
    o.now,
  );
  const events = await store.events(o.db, account.org_id, 500);
  if (
    !events.some(
      (e) => e.type === "demo.seeded" && (e.detail as { slug?: string })?.slug === fixture.slug,
    )
  )
    await o.db.transaction((tx) =>
      emit(d, tx, {
        orgId: account.org_id,
        actor: { kind: "staff", userId: staff.directusUserId },
        type: "demo.seeded",
        detail: { slug: String(fixture.slug), links: seeded.result },
      }),
    );

  // The offer: a year licence and an onboarding workshop, in euros, 21% VAT. A fresh one
  // is pushed only when no demo offer is still waiting for a signature.
  const docs = await store.documents(o.db, account.org_id);
  let waiting = docs.find((x) => x.kind === "offer" && ["sent", "viewed"].includes(x.status));
  // A demo rebuilt in the other language withdraws the offer in the old one.
  if (waiting && waiting.language !== lang) {
    await store.updateDocument(o.db, waiting.id, {
      status: "void",
      voidedAt: o.now,
      updatedAt: o.now,
    });
    for (const t of await store.tasks(o.db, account.org_id))
      if (t.documentId === waiting.id && !["done", "withdrawn"].includes(t.status))
        await store.updateTask(o.db, t.id, {
          status: "withdrawn",
          nextReminderAt: null,
          updatedAt: o.now,
        });
    waiting = undefined;
  }
  let offerId = waiting?.id ?? "";
  let offerCreated = false;
  if (!waiting) {
    const generation = docs.filter((x) => x.kind === "offer").length + 1;
    const pushed = await pushOffer(
      d,
      staff,
      account.org_id,
      {
        template: "subscription",
        language: lang,
        offer_name: ORG_NAME,
        person_name: "Sameer",
        attention: null,
        reference: `DMB-DEMO-${generation}`,
        title: null,
        currency: "EUR",
        date: nowIso.slice(0, 10),
        items: [
          {
            description: w.offer.licence,
            bullets: [...w.offer.licenceBullets],
            quantity: 60,
            unit_price_cents: 8600,
            vat_rate_bps: 2100,
          },
          {
            description: w.offer.workshop,
            bullets: [...w.offer.workshopBullets],
            quantity: 1,
            unit_price_cents: 125000,
            vat_rate_bps: 2100,
          },
        ],
        external_ref: null,
        supersedes_id: null,
      },
      { document: id(`offer-${generation}`), task: id(`task-sign-${generation}`) },
    );
    offerId = pushed.document.id;
    offerCreated = true;
  }

  await o.db.transaction(async (tx) => {
    const tasks = await store.tasks(tx, account.org_id);
    // The demo's own words follow DEMO_LANGUAGE on every run.
    if (tasks.some((t) => t.id === DEMO_IDS.poTask))
      await store.updateTask(tx, DEMO_IDS.poTask, { title: w.po.title, body: w.po.body });
    if (tasks.some((t) => t.id === DEMO_IDS.logoTask))
      await store.updateTask(tx, DEMO_IDS.logoTask, {
        title: w.logo.title,
        body: w.logo.body,
        responseText: w.logo.reply,
      });
    if (await store.ticket(tx, account.org_id, DEMO_IDS.ticket)) {
      await store.updateTicket(tx, DEMO_IDS.ticket, { subject: w.ticket.subject });
      await tx
        .update(schema.account_ticket_message)
        .set({ body: w.ticket.ask })
        .where(eq(schema.account_ticket_message.id, id("ticket-message-1")));
      await tx
        .update(schema.account_ticket_message)
        .set({ body: w.ticket.answer })
        .where(eq(schema.account_ticket_message.id, id("ticket-message-2")));
    }
    if (!tasks.some((t) => t.id === DEMO_IDS.poTask))
      await createTask(d, tx, {
        id: DEMO_IDS.poTask,
        orgId: account.org_id,
        title: w.po.title,
        body: w.po.body,
        kind: "generic",
        createdBy: staff.directusUserId,
      });
    if (!tasks.some((t) => t.id === DEMO_IDS.logoTask)) {
      await createTask(d, tx, {
        id: DEMO_IDS.logoTask,
        orgId: account.org_id,
        title: w.logo.title,
        body: w.logo.body,
        kind: "upload",
        createdBy: staff.directusUserId,
      });
      const key = `accounts/${account.org_id}/tasks/${DEMO_IDS.logoTask}/voorbeeldstad-logo.svg`;
      await o.files.put(
        key,
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><text x="10" y="40" font-size="28" font-family="sans-serif">Voorbeeldstad</text></svg>',
        "image/svg+xml",
      );
      await settleTask(d, tx, DEMO_IDS.logoTask, "submitted", {
        responseText: w.logo.reply,
        responseFileKey: key,
        responseFileName: "voorbeeldstad-logo.svg",
        submittedAt: o.now,
        submittedBy: customer.id,
      });
    }
    if (!(await store.ticket(tx, account.org_id, DEMO_IDS.ticket))) {
      await store.insertTicket(tx, {
        id: DEMO_IDS.ticket,
        orgId: account.org_id,
        subject: w.ticket.subject,
        status: "waiting_on_customer",
        openedBy: customer.id,
        createdAt: o.now,
        updatedAt: o.now,
      });
      await store.insertMessage(tx, {
        id: id("ticket-message-1"),
        ticketId: DEMO_IDS.ticket,
        authorUserId: customer.id,
        fromStaff: false,
        body: w.ticket.ask,
        createdAt: o.now,
      });
      await store.insertMessage(tx, {
        id: id("ticket-message-2"),
        ticketId: DEMO_IDS.ticket,
        authorUserId: staff.directusUserId,
        fromStaff: true,
        body: w.ticket.answer,
        createdAt: new Date(o.now.getTime() + 60_000),
      });
      await emit(d, tx, {
        orgId: account.org_id,
        actor: { kind: "customer", userId: customer.id },
        type: "ticket.opened",
        subject: { type: "ticket", id: DEMO_IDS.ticket },
      });
    }
    if (!(await store.documentByExactId(tx, "DEMO-EXACT-0001"))) {
      const body = [
        "Invoice 2026-0421",
        `Issued ${nowIso.slice(0, 10)}, due ${new Date(o.now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10)}`,
        "Subtotal 125000 cents, VAT 26250 cents, total 151250 cents EUR",
      ].join("\n");
      await store.insertDocument(tx, {
        id: DEMO_IDS.invoice,
        orgId: account.org_id,
        kind: "invoice",
        title: "Invoice 2026-0421",
        language: lang,
        reference: "2026-0421",
        body,
        sha256: sha256Hex(body),
        requiresSignature: false,
        status: "sent",
        subtotalCents: 125000,
        vatCents: 26250,
        totalCents: 151250,
        currency: "EUR",
        exactId: "DEMO-EXACT-0001",
        issuedOn: nowIso.slice(0, 10),
        dueOn: new Date(o.now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
        invoiceStatus: "open",
        // A placeholder, not a payable link: the demo shows where Mollie's link appears.
        paymentUrl: "https://www.mollie.com/checkout/test-mode?demo=voorbeeldstad",
        paymentReference: "2026-0421",
        sentAt: o.now,
        createdAt: o.now,
        updatedAt: o.now,
      });
      await emit(d, tx, {
        orgId: account.org_id,
        actor: { kind: "system", userId: null },
        type: "invoice.created",
        subject: { type: "document", id: DEMO_IDS.invoice },
        detail: { number: "2026-0421", status: "open", total_cents: 151250 },
      });
    }
  });

  // The customer is an admin through createAccount; make sure nothing downgraded them.
  await o.db
    .update(schema.org_membership)
    .set({ role: "admin", deleted_at: null })
    .where(
      and(
        eq(schema.org_membership.org_id, account.org_id),
        eq(schema.org_membership.user_id, customerApp.id),
      ),
    );
  return {
    org_id: account.org_id,
    offer_id: offerId,
    offer_created: offerCreated,
    demo_links: seeded.result,
    customer_email: CUSTOMER_EMAIL,
    staff_email: STAFF_EMAIL,
  };
}
