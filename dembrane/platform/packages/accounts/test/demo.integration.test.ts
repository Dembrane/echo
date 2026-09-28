import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { createDb, schema } from "@dembrane/db";
import {
  buildBundle,
  continueSnippet,
  demoFromFixture,
  dict,
  type Json,
  popcornDemoRoutes,
  renderPopcornPage,
} from "@dembrane/popcorn";
import { FilesystemStorage } from "@dembrane/storage";
import { count, eq } from "drizzle-orm";
import { demoProspectHook } from "../src/demo-hook";
import { accountsRoutes } from "../src/routes";
import { CUSTOMER_EMAIL, DEMO_IDS, STAFF_EMAIL, seedAccountsDemo } from "../src/seed";
import { admin, dropDatabase, FakeWeb, freshDatabase, silent, type World, world } from "./helpers";

// The prospect block of the demo seed route, and the accounts demo seed.
const run = admin ? describe : describe.skip;
const demos = new URL("../../../../demos", import.meta.url).pathname;
const company = {
  name: "dembrane B.V.",
  address: "Sint Janssingel 88, ‘s-Hertogenbosch, NL",
  vat: "NL864967433B01",
  kvk: "89391438",
  iban: "NL49 RABO 0318910535",
  bic: "RABONL2U",
  accountName: "Dembrane B.V.",
};

async function demoBody() {
  const fixture = (await Bun.file(join(demos, "example/fixture.json")).json()) as Json;
  const inputs = demoFromFixture(fixture, "https://portal.example.test/nl-NL/sales/start");
  return {
    session: inputs.session,
    research: await Bun.file(join(demos, "example/research.md")).text(),
    corpus: inputs.corpus,
    out: inputs.out,
    sales_portal: await Bun.file(join(demos, "sales-portal.json")).json(),
    portal_base_url: "https://portal.example.test",
    api_base_url: "https://api.example.test",
  };
}

run("the demo route's prospect block", () => {
  setDefaultTimeout(60_000);
  const DB = `accounts_demo_${process.pid}`;
  let w: World;
  let workspaceId = "";

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    const billing = newId();
    workspaceId = newId();
    await w.db.insert(schema.billing_account).values({ id: billing, org_id: w.orgId });
    await w.db.insert(schema.workspace).values({
      id: workspaceId,
      org_id: w.orgId,
      name: "Sales demos",
      billing_account_id: billing,
    });
    w.app.route(
      "/",
      popcornDemoRoutes({
        db: w.db,
        staffAudit: w.deps.staffAudit,
        ownUrls: ["https://api.example.test"],
        prospect: demoProspectHook(w.deps),
        now: () => w.clock.now,
      }),
    );
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  const post = async (body: unknown, as: string | null = "staff") =>
    w.app.request("/api/v2/admin/popcorn/demos", {
      method: "POST",
      headers: { "content-type": "application/json", ...(as && { "x-as": as }) },
      body: JSON.stringify(body),
    });

  test("without the block the demo seeds exactly as before", async () => {
    const res = await post({
      ...(await demoBody()),
      workspace_id: workspaceId,
      owner_id: w.people.staff.directusUserId,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Json;
    expect(out.prospect).toBeUndefined();
    const [loop] = await w.db.select().from(schema.agent_loop);
    expect(dict(dict(loop?.popcorn_state).demo).continue_url).toBeUndefined();
  });

  test("the block requires a contact email and staff", async () => {
    const base = {
      ...(await demoBody()),
      workspace_id: workspaceId,
      owner_id: w.people.staff.directusUserId,
    };
    expect(
      (await post({ ...base, prospect: { organisation_name: "Waterschap Proef" } })).status,
    ).toBe(422);
    expect(
      (
        await post(
          { ...base, prospect: { organisation_name: "W", contact_email: "a@b.example" } },
          "admin",
        )
      ).status,
    ).toBe(403);
    const dry = await post({
      ...base,
      dry_run: true,
      prospect: { organisation_name: "Waterschap Proef", contact_email: "p@proef.example" },
    });
    expect(((await dry.json()) as Json).prospect).toEqual({
      dry_run: true,
      organisation_name: "Waterschap Proef",
      contact_email: "p@proef.example",
    });
    const orgs = await w.db
      .select()
      .from(schema.org)
      .where(eq(schema.org.name, "Waterschap Proef"));
    expect(orgs).toHaveLength(0);
  });

  test("with the block: a prospect organisation, its contact as admin, the needs form linked, and Continue in dembrane", async () => {
    await w.db.insert(schema.pricing_configuration).values({
      id: newId(),
      reference: "WEB-PR0EF",
      config_session_id: "sess-proef",
      email: "p@proef.example",
    });
    const base = {
      ...(await demoBody()),
      workspace_id: workspaceId,
      owner_id: w.people.staff.directusUserId,
    };
    const res = await post({
      ...base,
      prospect: {
        organisation_name: "Waterschap Proef",
        contact_email: "P@Proef.example",
        contact_name: "Pieter Proef",
        pricing_configuration_reference: "WEB-PR0EF",
      },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      prospect: { org_id: string; continue_url: string; created: boolean };
    };
    expect(out.prospect.created).toBe(true);
    const org = await w.db.select().from(schema.org).where(eq(schema.org.id, out.prospect.org_id));
    expect(org[0]?.account_stage).toBe("prospect");
    expect(org[0]?.origin_pricing_configuration_id).toBeTruthy();
    const [pc] = await w.db
      .select()
      .from(schema.pricing_configuration)
      .where(eq(schema.pricing_configuration.reference, "WEB-PR0EF"));
    expect(pc?.org_id).toBe(out.prospect.org_id);
    const [loop] = await w.db.select().from(schema.agent_loop);
    const state = dict(loop?.popcorn_state);
    expect(dict(state.demo).continue_url).toBe(out.prospect.continue_url);
    // The public page's session carries the link the page shows as "Continue in dembrane".
    const files = buildBundle({
      state,
      settings: dict(dict(base.out).nl).settings as Json,
      report: { id: 1, date_created: "2026-09-28T09:00:00Z" },
      project: { id: "p", language: "nl" },
      participantBaseUrl: "https://portal.example.test",
    });
    expect(dict(dict(dict(files.files)["session.json"]).demo).continue_url).toBe(
      out.prospect.continue_url,
    );
    // The public page gains the link only for such a demo; any other page is unchanged.
    const plain = renderPopcornPage({ mode: "public" });
    const withLink = renderPopcornPage(
      { mode: "public" },
      continueSnippet(out.prospect.continue_url, "nl"),
    );
    expect(plain).not.toContain("popcorn-continue");
    expect(withLink).toContain(`href="${out.prospect.continue_url}"`);
    expect(withLink).toContain("Verder in dembrane");
    expect(withLink.replace(continueSnippet(out.prospect.continue_url, "nl"), "")).toBe(plain);
    const events = await w.db
      .select()
      .from(schema.account_event)
      .where(eq(schema.account_event.orgId, out.prospect.org_id));
    expect(events.map((e) => e.type).sort()).toEqual(["account.created", "demo.seeded"]);
    // A second seed of the same demo finds the same organisation.
    const again = await post({
      ...base,
      prospect: {
        organisation_name: "Waterschap Proef",
        contact_email: "p@proef.example",
        pricing_configuration_reference: "WEB-PR0EF",
      },
    });
    expect(((await again.json()) as typeof out).prospect).toMatchObject({
      org_id: out.prospect.org_id,
      created: false,
    });
  });
});

run("bun run seed:accounts-demo", () => {
  setDefaultTimeout(120_000);
  const DB = `accounts_seed_${process.pid}`;
  let url = "";
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    url = await freshDatabase(DB);
    database = createDb({ url, poolMax: 4 });
  });
  afterAll(async () => {
    await database?.close();
    await dropDatabase(DB);
  });

  const options = async () => {
    const web = new FakeWeb();
    await web.load();
    return {
      db: database.db,
      files: new FilesystemStorage(mkdtempSync(join(tmpdir(), "seed-files-")), "http://localhost"),
      access: new Access(new DrizzleAccessStore(database.db)),
      logger: silent,
      now: new Date("2026-09-28T09:00:00.000Z"),
      password: "a-demo-password-for-tests",
      env: "preview",
      dashboardUrl: "https://dash.example.test",
      portalUrl: "https://portal.example.test",
      apiUrl: "https://api.example.test",
      company,
      demosDir: demos,
      fetchText: web.fetch,
    };
  };

  const counts = async () => {
    const out: Record<string, number> = {};
    for (const [name, table] of Object.entries({
      org: schema.org,
      auth_user: schema.auth_user,
      app_user: schema.app_user,
      org_membership: schema.org_membership,
      workspace: schema.workspace,
      workspace_membership: schema.workspace_membership,
      project: schema.project,
      conversation: schema.conversation,
      account_document: schema.account_document,
      account_document_field: schema.account_document_field,
      account_task: schema.account_task,
      account_ticket: schema.account_ticket,
      account_ticket_message: schema.account_ticket_message,
      account_event: schema.account_event,
      legal_text: schema.legal_text,
    }))
      out[name] = (await database.db.select({ n: count() }).from(table))[0]?.n ?? 0;
    return out;
  };

  test("refuses production", async () => {
    await expect(seedAccountsDemo({ ...(await options()), env: "prod" })).rejects.toThrow(
      /never production/,
    );
    await expect(
      seedAccountsDemo({ ...(await options()), dashboardUrl: "https://dashboard.dembrane.com" }),
    ).rejects.toThrow(/staging/);
  });

  test("builds the demo, and a second run creates nothing new", async () => {
    const first = await seedAccountsDemo(await options());
    expect(first.offer_created).toBe(true);
    const after = await counts();
    expect(after.account_document).toBe(2); // the offer and the invoice
    expect(after.account_task).toBe(4); // sign, billing (locked), PO, logo
    expect(after.account_ticket_message).toBe(2);
    expect(after.conversation).toBeGreaterThan(0);
    const second = await seedAccountsDemo(await options());
    expect(second.offer_created).toBe(false);
    expect(second.offer_id).toBe(first.offer_id);
    expect(await counts()).toEqual(after);

    const tasks = await database.db
      .select()
      .from(schema.account_task)
      .where(eq(schema.account_task.orgId, DEMO_IDS.org));
    expect(tasks.map((t) => `${t.kind}:${t.status}`).sort()).toEqual([
      "billing_details:locked",
      "generic:open",
      "sign:open",
      "upload:submitted",
    ]);
    const [org] = await database.db
      .select()
      .from(schema.org)
      .where(eq(schema.org.id, DEMO_IDS.org));
    expect([org?.name, org?.account_stage]).toEqual(["Gemeente Voorbeeldstad", "customer"]);
    // Both logins work with the demo password, and the password is stored only hashed.
    for (const email of [CUSTOMER_EMAIL, STAFF_EMAIL]) {
      const [user] = await database.db
        .select()
        .from(schema.auth_user)
        .where(eq(schema.auth_user.email, email));
      const [cred] = await database.db
        .select()
        .from(schema.auth_account)
        .where(eq(schema.auth_account.userId, user?.id as string));
      expect(cred?.password?.startsWith("$argon2id$")).toBe(true);
      expect(await Bun.password.verify("a-demo-password-for-tests", cred?.password as string)).toBe(
        true,
      );
    }
    const [staffRole] = await database.db
      .select({ name: schema.directus_roles.name })
      .from(schema.directus_users)
      .innerJoin(schema.directus_roles, eq(schema.directus_roles.id, schema.directus_users.role))
      .innerJoin(schema.auth_user, eq(schema.auth_user.id, schema.directus_users.id))
      .where(eq(schema.auth_user.email, STAFF_EMAIL));
    expect(staffRole?.name).toBe("Administrator");
  });

  test("the customer owns the demo workspace, by app user id, and a removed membership comes back", async () => {
    const [customer] = await database.db
      .select({ id: schema.app_user.id })
      .from(schema.app_user)
      .innerJoin(schema.auth_user, eq(schema.auth_user.id, schema.app_user.directus_user_id))
      .where(eq(schema.auth_user.email, CUSTOMER_EMAIL));
    const memberships = () =>
      database.db
        .select()
        .from(schema.workspace_membership)
        .where(eq(schema.workspace_membership.workspace_id, DEMO_IDS.workspace));
    const [owner, ...others] = await memberships();
    expect(others).toEqual([]);
    expect([owner?.user_id, owner?.role, owner?.source, owner?.deleted_at]).toEqual([
      customer?.id,
      "owner",
      "direct",
      null,
    ]);

    await database.db
      .update(schema.workspace_membership)
      .set({ role: "member", deleted_at: new Date().toISOString() })
      .where(eq(schema.workspace_membership.workspace_id, DEMO_IDS.workspace));
    await seedAccountsDemo(await options());
    const after = await memberships();
    expect(after.map((m) => ({ id: m.id, role: m.role, deleted_at: m.deleted_at }))).toEqual([
      { id: owner?.id as string, role: "owner", deleted_at: null },
    ]);
  });

  test("DEMO_LANGUAGE: English by default; a Dutch run rewords the demo and replaces the offer", async () => {
    const tasks = async () =>
      await database.db
        .select()
        .from(schema.account_task)
        .where(eq(schema.account_task.id, DEMO_IDS.poTask));
    expect((await tasks())[0]?.title).toBe("Send us your PO number");
    const [english] = await database.db
      .select()
      .from(schema.account_document)
      .where(eq(schema.account_document.kind, "offer"));
    expect(english?.language).toBe("en");
    const nl = await seedAccountsDemo({ ...(await options()), language: "nl" });
    expect(nl.offer_created).toBe(true);
    expect((await tasks())[0]?.title).toBe("Stuur ons jullie PO-nummer");
    const offers = await database.db
      .select()
      .from(schema.account_document)
      .where(eq(schema.account_document.kind, "offer"));
    expect(offers.find((o) => o.id === english?.id)?.status).toBe("void");
    expect(offers.find((o) => o.id === nl.offer_id)?.language).toBe("nl");
    const [ticket] = await database.db
      .select()
      .from(schema.account_ticket)
      .where(eq(schema.account_ticket.id, DEMO_IDS.ticket));
    expect(ticket?.subject).toBe("Kunnen we per kwartaal betalen?");
    // Back to English for the tests after this one.
    await seedAccountsDemo(await options());
    expect((await tasks())[0]?.title).toBe("Send us your PO number");
  });

  test("after the demo offer is signed or withdrawn, the next run pushes a fresh one", async () => {
    const [offer] = await database.db
      .select()
      .from(schema.account_document)
      .where(eq(schema.account_document.kind, "offer"));
    await database.db
      .update(schema.account_document)
      .set({ status: "void" })
      .where(eq(schema.account_document.id, offer?.id as string));
    const third = await seedAccountsDemo(await options());
    expect(third.offer_created).toBe(true);
    expect(third.offer_id).not.toBe(offer?.id);
  });
});
