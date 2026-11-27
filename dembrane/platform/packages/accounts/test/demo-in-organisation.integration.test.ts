import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { heldForDemo, resolveProject, shownToOrganisation } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { resolveLocale } from "@dembrane/i18n";
import { and, eq, inArray } from "drizzle-orm";
import * as K from "../src/contract";
import { demoBuildAccess } from "../src/demo/access";
import { buildDemo, type DemoBuildDeps } from "../src/demo/build";
import { ensureUser, releaseHeldContacts } from "../src/prospect";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import {
  ADMIN_PLACE,
  accountOf,
  DEMO_SITE,
  emailsQueued,
  existingOrganisation,
  fakeDemoBuild,
  joinOrganisation,
  type OrgRole,
  organisationCount,
  type Person,
  personWithAccount,
  placesIn,
  setOrganisationDeleted,
  setRemovedFromOrganisation,
  whereIs,
  workspacesOf,
} from "./demo-helpers";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// Story 2: a demo staff place in an organisation its contact already works in. It gets a
// workspace of its own there, hidden until staff publish with the email on; nothing of the
// organisation changes, and the contact gets a "demo is ready" email instead of an account
// invitation. The prospect path (a new organisation) is held by demo-build.integration.test.ts.
const run = admin ? describe : describe.skip;
const DB = `accounts_demo_in_org_${process.pid}`;
const DEMOS = "/api/v2/admin/accounts/demos";
const SUBJECT = "Brent Council";

run("a demo placed in an organisation the contact already works in", () => {
  setDefaultTimeout(120_000);
  let w: World;
  let deps: DemoBuildDeps;
  let extracted: string[];

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    ({ deps, extracted } = fakeDemoBuild(w));
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  let made = 0;
  /**
   * A fresh organisation for one test: its owner, the contact with `role`, and an admin
   * colleague. The contact's saved language is German, the demo's is English, so the email's
   * language says which one was used.
   */
  const organisation = async (
    role: OrgRole,
    over: Partial<Parameters<typeof existingOrganisation>[1]> = {},
  ) => {
    made++;
    const owner = await personWithAccount(w, `owner${made}`);
    const contact = await personWithAccount(w, `contact${made}`, {
      name: `Olivia ${made}`,
      language: "de-DE",
    });
    const colleague = await personWithAccount(w, `colleague${made}`);
    const org = await existingOrganisation(w, {
      name: `Demos ${made}`,
      stage: "customer",
      billingEmail: `finance${made}@example.test`,
      members: [
        { person: owner, role: "owner" },
        { person: contact, role },
        { person: colleague, role: "admin" },
      ],
      ...over,
    });
    return { org, owner, contact, colleague };
  };

  const start = (orgId: string | null, contact: Person, over: Record<string, unknown> = {}) =>
    call(w, "POST", DEMOS, "staff", {
      organisation_name: SUBJECT,
      website_url: DEMO_SITE,
      brief: "Participation for the new town square.",
      language: "en",
      contact_name: "Olivia",
      contact_email: contact.email,
      ...(orgId && { org_id: orgId }),
      ...over,
    });
  const statusOf = async (id: string) =>
    K.DemoStatus.parse((await call(w, "GET", `${DEMOS}/${id}`, "staff")).data);
  /** Starts and builds a demo in the organisation; answers its status as a draft. */
  const draftIn = async (orgId: string, contact: Person, over: Record<string, unknown> = {}) => {
    const r = await start(orgId, contact, over);
    expect(r.status).toBe(201);
    const id = K.DemoStatus.parse(r.data).id;
    await buildDemo(deps, id, 1);
    return statusOf(id);
  };
  const publish = (id: string, signIn: boolean) =>
    call(w, "POST", `${DEMOS}/${id}/publish`, "staff", { sign_in: signIn });
  const unpublish = (id: string) => call(w, "POST", `${DEMOS}/${id}/unpublish`, "staff");
  const projectOf = (view: K.DemoStatusT) => view.links.projects[0]?.project_id as string;
  /**
   * Where the demo's project is. Every test below first checks that it is in a workspace of
   * the chosen organisation: without that, a test about what the organisation does not see
   * would pass for a demo that went somewhere else.
   */
  const placedIn = async (view: K.DemoStatusT, orgId: string) => {
    const where = await whereIs(w, projectOf(view));
    expect(where?.org_id).toBe(orgId);
    return where as NonNullable<typeof where>;
  };
  const release = (orgId: string) =>
    w.db.transaction((tx) => releaseHeldContacts(tx, orgId, w.clock.now));

  describe("the demo is a workspace of its own in the organisation (criterion 3)", () => {
    test("after publishing with the email on, the organisation has one new workspace named after the demo, the project pinned in it, the contact its admin", async () => {
      const { org, contact } = await organisation("member");
      const before = await workspacesOf(w, org.id);
      const view = await draftIn(org.id, contact, { sign_in: true });
      expect((await publish(view.id, true)).status).toBe(200);
      const after = await workspacesOf(w, org.id);
      const added = after.filter((a) => !before.some((b) => b.id === a.id));
      expect(added.map((a) => [a.name, a.deleted_at])).toEqual([[SUBJECT, null]]);
      const where = await placedIn(view, org.id);
      expect(where.workspace_id).toBe(added[0]?.id as string);
      expect(where.pin_order).not.toBeNull();
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([ADMIN_PLACE]);
    });

    test("publishing again, also after an unpublish, adds no second workspace row for the contact", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      expect((await publish(view.id, true)).status).toBe(200);
      expect((await publish(view.id, true)).status).toBe(200);
      expect((await unpublish(view.id)).status).toBe(200);
      expect((await publish(view.id, true)).status).toBe(200);
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([ADMIN_PLACE]);
      expect((await workspacesOf(w, org.id)).length).toBe(2);
    });

    test("a contact removed from the demo's workspace is not put back when staff publish", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      await w.db.insert(schema.workspace_membership).values({
        id: newId(),
        workspace_id: where.workspace_id as string,
        user_id: contact.appUserId as string,
        role: "member",
        source: "direct",
        deleted_at: w.clock.now.toISOString(),
      });
      expect((await publish(view.id, true)).status).toBe(200);
      expect(
        (await placesIn(w, where.workspace_id as string, contact)).map((r) => [
          r.role,
          r.deleted_at !== null,
        ]),
      ).toEqual([["member", true]]);
    });
  });

  describe("no newcomer treatment (criterion 4)", () => {
    test("for a contact who is a plain member: no new organisation, no tasks, and manager, stage, billing and their role stay as they were", async () => {
      // No stage and no account manager yet, and a @dembrane.com staff member starts the
      // demo: the prospect path would fill both. The contact is a member, not an admin.
      const { org, contact } = await organisation("member", {
        stage: null,
        managerAppUserId: null,
      });
      const sales = await w.db.transaction((tx) =>
        ensureUser(tx, {
          email: "sales@dembrane.com",
          name: "Sales Person",
          passwordHash: null,
          nowIso: w.clock.now.toISOString(),
        }),
      );
      const before = await accountOf(w, org.id);
      const organisations = await organisationCount(w);
      const r = await start(org.id, contact, { sign_in: true });
      expect(r.status).toBe(201);
      const id = K.DemoStatus.parse(r.data).id;
      await w.db
        .update(schema.account_demo)
        .set({ createdBy: sales.userId })
        .where(eq(schema.account_demo.id, id));
      await buildDemo(deps, id, 1);
      const view = await statusOf(id);
      await placedIn(view, org.id);
      expect(await organisationCount(w)).toBe(organisations);
      expect(await accountOf(w, org.id)).toEqual(before);
      expect((await publish(id, true)).status).toBe(200);
      expect(await organisationCount(w)).toBe(organisations);
      const after = await accountOf(w, org.id);
      expect(after).toEqual(before);
      expect(after.tasks).toEqual([]);
      expect(after.stage).toBeNull();
      expect(after.account_manager_id).toBeNull();
      expect(after.members.find((m) => m.user === contact.appUserId)?.role).toBe("member");
    });

    test("for a contact who is an admin of a customer with a manager: the same, nothing changes", async () => {
      const { org, contact } = await organisation("admin", {
        stage: "customer",
        managerAppUserId: w.people.staff.appUserId as string,
      });
      const before = await accountOf(w, org.id);
      const organisations = await organisationCount(w);
      const view = await draftIn(org.id, contact, { sign_in: true });
      await placedIn(view, org.id);
      expect((await publish(view.id, true)).status).toBe(200);
      expect(await organisationCount(w)).toBe(organisations);
      const after = await accountOf(w, org.id);
      expect(after).toEqual(before);
      expect(after.stage).toBe("customer");
      expect(after.members.find((m) => m.user === contact.appUserId)?.role).toBe("admin");
    });
  });

  describe("the email says the demo is ready (criterion 5)", () => {
    test("publishing with the email on queues one 'demo is ready' email in the contact's saved language, naming the demo and the organisation, with a link to the project", async () => {
      const { org, contact } = await organisation("member");
      w.jobs.jobs.length = 0;
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      expect((await publish(view.id, true)).status).toBe(200);
      const emails = emailsQueued(w);
      expect(emails).toHaveLength(1);
      expect(emails[0]).toMatchObject({
        to: contact.email,
        template: "account_demo_ready",
        // Saved on their profile as German; the demo itself is in English.
        language: resolveLocale("de-DE"),
        data: { demo_name: SUBJECT, org_name: org.name },
      });
      // The button opens the demo project, through the sign-in as continueUrl wraps a path.
      const url = String(emails[0]?.data.demo_url);
      const prefix = "https://dash.test/login?next=";
      expect(url.startsWith(prefix)).toBe(true);
      expect(decodeURIComponent(url.slice(prefix.length))).toMatch(
        new RegExp(`^/[^/]+/w/${where.workspace_id}/projects/${projectOf(view)}(/|$)`),
      );
      expect(emails.some((e) => e.template === "account_invite")).toBe(false);
    });

    test("publishing again after an unpublish sends no second email", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      await placedIn(view, org.id);
      w.jobs.jobs.length = 0;
      expect((await publish(view.id, true)).status).toBe(200);
      expect(emailsQueued(w).map((e) => e.template)).toEqual(["account_demo_ready"]);
      w.jobs.jobs.length = 0;
      expect((await unpublish(view.id)).status).toBe(200);
      expect((await publish(view.id, true)).status).toBe(200);
      expect(emailsQueued(w)).toEqual([]);
    });
  });

  describe("nothing shows before publish (criterion 6, the rows and emails)", () => {
    test("while the demo is a draft the contact has no place in its workspace and no email is queued", async () => {
      const { org, contact } = await organisation("member");
      w.jobs.jobs.length = 0;
      const view = await draftIn(org.id, contact, { sign_in: true });
      expect(view.status).toBe("draft");
      const where = await placedIn(view, org.id);
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([]);
      expect(emailsQueued(w)).toEqual([]);
    });

    test("a publish with the email off keeps it that way: the link is live, the contact has no place and no email", async () => {
      const { org, contact } = await organisation("member");
      w.jobs.jobs.length = 0;
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      const r = await publish(view.id, false);
      expect(r.status).toBe(200);
      const published = K.DemoStatus.parse(r.data);
      expect(published.status).toBe("published");
      expect(published.links.public[0]?.live).toBe(true);
      expect(published.invited_at).toBeNull();
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([]);
      expect(emailsQueued(w)).toEqual([]);
    });
  });

  describe("the release staff actions on the organisation call (offer sent, account enabled)", () => {
    test("while the demo is a draft it hands nothing over and leaves the contact's role; publishing with the email on still does", async () => {
      const { org, contact } = await organisation("member");
      w.jobs.jobs.length = 0;
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      const before = await accountOf(w, org.id);
      await release(org.id);
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([]);
      expect(await accountOf(w, org.id)).toEqual(before);
      expect(emailsQueued(w)).toEqual([]);
      // Only a publish with the email on hands it over, release or not before it.
      expect((await publish(view.id, true)).status).toBe(200);
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([ADMIN_PLACE]);
      expect(emailsQueued(w).map((e) => e.template)).toEqual(["account_demo_ready"]);
      expect((await accountOf(w, org.id)).members).toEqual(before.members);
    });

    test("it does not bring back a contact who was removed from the organisation", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      await setRemovedFromOrganisation(w, org.id, contact, true);
      const before = await accountOf(w, org.id);
      await release(org.id);
      const after = await accountOf(w, org.id);
      expect(after).toEqual(before);
      expect(after.members.find((m) => m.user === contact.appUserId)).toMatchObject({
        role: "member",
        deleted_at: expect.any(String),
      });
      expect(await placesIn(w, where.workspace_id as string, contact)).toEqual([]);
    });
  });

  describe("the seed step checks the organisation and the contact again", () => {
    /** The seed step's error reads as a sentence, not as a code or a stack. */
    const readable = (error: string | null | undefined) => {
      expect(typeof error).toBe("string");
      const text = String(error);
      expect(text).not.toMatch(/^[a-z_]+\.[a-z_.]+$/);
      expect(text).not.toMatch(/undefined|null|\[object|at .*\.ts/);
      expect(text).toContain(" ");
      return text;
    };
    const failedSeed = async (id: string) => {
      await expect(buildDemo(deps, id, 1)).rejects.toThrow();
      const failed = await statusOf(id);
      expect(failed.status).toBe("failed");
      const seed = failed.steps.find((s) => s.name === "seed");
      expect(seed?.status).toBe("failed");
      return readable(seed?.error);
    };
    const retryFinishes = async (id: string, orgId: string) => {
      const retried = await call(w, "POST", `${DEMOS}/${id}/retry`, "staff");
      expect(retried.status).toBe(200);
      await buildDemo(deps, id, 2);
      const view = await statusOf(id);
      expect(view.status).toBe("draft");
      await placedIn(view, orgId);
    };

    test("a contact who is no longer a live member fails the step readably; a retry once they are back finishes", async () => {
      const { org, contact } = await organisation("member");
      const organisations = await organisationCount(w);
      const r = await start(org.id, contact, { sign_in: true });
      expect(r.status).toBe(201);
      const id = K.DemoStatus.parse(r.data).id;
      await setRemovedFromOrganisation(w, org.id, contact, true);
      expect(await failedSeed(id)).toMatch(/member|no longer in|not in/i);
      // Nothing was made elsewhere in the meantime.
      expect(await organisationCount(w)).toBe(organisations);
      await setRemovedFromOrganisation(w, org.id, contact, false);
      await retryFinishes(id, org.id);
    });

    test("a deleted organisation fails the step readably; a retry once it is restored finishes", async () => {
      const { org, contact } = await organisation("member");
      const organisations = await organisationCount(w);
      const r = await start(org.id, contact, { sign_in: true });
      expect(r.status).toBe(201);
      const id = K.DemoStatus.parse(r.data).id;
      await setOrganisationDeleted(w, org.id, true);
      expect(await failedSeed(id)).toMatch(/delet|removed|no longer exists/i);
      expect(await organisationCount(w)).toBe(organisations);
      await setOrganisationDeleted(w, org.id, false);
      await retryFinishes(id, org.id);
    });
  });

  describe("publishing with the email on checks the organisation and the contact again", () => {
    /** The workspace still held for the demo, so nothing of it showed. */
    const heldFor = async (workspaceId: string) => {
      const [ws] = await w.db
        .select({ settings: schema.workspace.settings, visibility: schema.workspace.visibility })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, workspaceId));
      return [(ws?.settings as Record<string, unknown> | null)?.held_for_demo, ws?.visibility];
    };
    /** Refused with a code the staff screen has a sentence for, and a readable detail. */
    const refusedReadably = async (id: string, match: RegExp, code: string) => {
      const r = await publish(id, true);
      expect(r.status).toBe(409);
      expect((r.data as { code?: unknown }).code).toBe(code);
      const detail = (r.data as { detail?: unknown }).detail;
      expect(typeof detail).toBe("string");
      expect(String(detail)).toMatch(match);
      expect(String(detail)).not.toMatch(/^[a-z_]+\.[a-z_.]+$/);
    };
    const nothingChanged = async (id: string, workspaceId: string, contact: Person) => {
      const view = await statusOf(id);
      expect([view.status, view.invited_at, view.links.public[0]?.live]).toEqual([
        "draft",
        null,
        false,
      ]);
      expect(await placesIn(w, workspaceId, contact)).toEqual([]);
      expect(await heldFor(workspaceId)).toEqual([id, "private"]);
      expect(emailsQueued(w)).toEqual([]);
    };

    test("a contact removed from the organisation since the build is refused readably: nothing is written and no email is queued", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      await setRemovedFromOrganisation(w, org.id, contact, true);
      w.jobs.jobs.length = 0;
      await refusedReadably(view.id, /member/i, "demo.contact_not_in_organisation");
      await nothingChanged(view.id, where.workspace_id as string, contact);
    });

    test("an organisation deleted since the build is refused readably: nothing is written and no email is queued", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      await setOrganisationDeleted(w, org.id, true);
      w.jobs.jobs.length = 0;
      await refusedReadably(view.id, /delet/i, "demo.organisation_deleted");
      await nothingChanged(view.id, where.workspace_id as string, contact);
      await setOrganisationDeleted(w, org.id, false);
    });

    /** With the email on refused as above; then with the email off it still publishes. */
    const refusedThenPublishedWithoutEmail = async (
      view: K.DemoStatusT,
      workspaceId: string,
      contact: Person,
    ) => {
      w.jobs.jobs.length = 0;
      await refusedReadably(view.id, /account|member/i, "demo.contact_not_in_organisation");
      await nothingChanged(view.id, workspaceId, contact);
      const r = await publish(view.id, false);
      expect(r.status).toBe(200);
      expect(K.DemoStatus.parse(r.data).links.public[0]?.live).toBe(true);
      expect(await heldFor(workspaceId)).toEqual([view.id, "private"]);
      expect(await placesIn(w, workspaceId, contact)).toEqual([]);
      expect(emailsQueued(w)).toEqual([]);
    };

    test("a contact whose account was erased since the build is refused readably, and the email off still publishes", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      // Staff's privacy erasure (staff/src/privacy-storage.ts erase) removes the account with
      // these three deletes; the memberships go with the app_user.
      await w.db.delete(schema.app_user).where(eq(schema.app_user.id, contact.appUserId as string));
      await w.db.delete(schema.auth_user).where(eq(schema.auth_user.id, contact.directusUserId));
      await w.db
        .delete(schema.directus_users)
        .where(eq(schema.directus_users.id, contact.directusUserId));
      await refusedThenPublishedWithoutEmail(view, where.workspace_id as string, contact);
    });

    test("a contact who asked to delete their account since the build is refused readably, and the email off still publishes", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      // "Delete account" in the app (account/src/settings.ts) suspends the person until the
      // purge, with these writes (auth/src/account.ts suspend). Their rows stay.
      await w.db
        .update(schema.directus_users)
        .set({ status: "suspended", description: "deletion requested in-app" })
        .where(eq(schema.directus_users.id, contact.directusUserId));
      await w.db
        .delete(schema.auth_session)
        .where(eq(schema.auth_session.userId, contact.directusUserId));
      await refusedThenPublishedWithoutEmail(view, where.workspace_id as string, contact);
    });

    test("publishing with the email off stays allowed: the link goes live and the workspace stays held", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      await setRemovedFromOrganisation(w, org.id, contact, true);
      w.jobs.jobs.length = 0;
      const r = await publish(view.id, false);
      expect(r.status).toBe(200);
      expect(K.DemoStatus.parse(r.data).links.public[0]?.live).toBe(true);
      expect(await heldFor(where.workspace_id as string)).toEqual([view.id, "private"]);
      expect(emailsQueued(w)).toEqual([]);
    });

    test("an organisation deleted outright takes its held demo workspace with it, and a publish with the email on is refused and sends nothing", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      // Nothing of the demo stands in the way of deleting the organisation's row.
      await w.db.delete(schema.org).where(eq(schema.org.id, org.id));
      const left = await w.db
        .select({ id: schema.workspace.id })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, where.workspace_id as string));
      expect(left).toEqual([]);
      w.jobs.jobs.length = 0;
      await refusedReadably(view.id, /no longer exists/i, "demo.organisation_deleted");
      expect((await statusOf(view.id)).status).toBe("draft");
      expect(emailsQueued(w)).toEqual([]);
    });

    test("email off, unpublish, email on: the hand-over and the one email happen on the last step", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      const workspaceId = where.workspace_id as string;
      w.jobs.jobs.length = 0;
      expect((await publish(view.id, false)).status).toBe(200);
      expect(await placesIn(w, workspaceId, contact)).toEqual([]);
      expect(await heldFor(workspaceId)).toEqual([view.id, "private"]);
      expect((await unpublish(view.id)).status).toBe(200);
      expect(await placesIn(w, workspaceId, contact)).toEqual([]);
      expect(emailsQueued(w)).toEqual([]);
      const r = await publish(view.id, true);
      expect(r.status).toBe(200);
      expect(K.DemoStatus.parse(r.data).invited_at).not.toBeNull();
      expect(await placesIn(w, workspaceId, contact)).toEqual([ADMIN_PLACE]);
      expect(await heldFor(workspaceId)).toEqual([undefined, "open_to_organisation"]);
      expect(emailsQueued(w).map((e) => e.template)).toEqual(["account_demo_ready"]);
    });
  });

  test("an organisation without a billing account of its own gets the one a workspace made there would get, and the demo builds", async () => {
    const contact = await personWithAccount(w, "no-billing-contact");
    const orgId = newId();
    await w.db
      .insert(schema.org)
      .values({ id: orgId, name: "No billing yet", account_stage: "customer" });
    await joinOrganisation(w, orgId, contact, "member");
    const view = await draftIn(orgId, contact, { sign_in: true });
    expect(view.status).toBe("draft");
    const where = await placedIn(view, orgId);
    const accounts = await w.db
      .select()
      .from(schema.billing_account)
      .where(eq(schema.billing_account.org_id, orgId));
    expect(accounts.map((a) => [a.tier, a.payment_mode, a.label, a.deleted_at])).toEqual([
      ["free", "none", "Org billing", null],
    ]);
    const [ws] = await w.db
      .select({ account: schema.workspace.billing_account_id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, where.workspace_id as string));
    expect(ws?.account).toBe(accounts[0]?.id as string);
  });

  test("with staff's shared demo workspace configured, a demo with an org_id still goes to a workspace of its own in that organisation", async () => {
    const shared = await organisation("admin");
    const { org, contact } = await organisation("member");
    const r = await start(org.id, contact, { sign_in: true });
    expect(r.status).toBe(201);
    const id = K.DemoStatus.parse(r.data).id;
    const withShared = { ...deps, demo: { ...deps.demo, workspaceId: shared.org.workspaceId } };
    await buildDemo(withShared, id, 1);
    const view = await statusOf(id);
    expect(view.status).toBe("draft");
    const where = await placedIn(view, org.id);
    expect(where.workspace_id).not.toBe(shared.org.workspaceId);
    expect(where.workspace_name).toBe(SUBJECT);
  });

  describe("staff adding onboarding to the organisation", () => {
    const addOnboarding = (orgId: string) =>
      call(w, "POST", `/api/v2/admin/accounts/${orgId}/onboarding`, "staff");
    const tasksOf = async (orgId: string) =>
      (await store.tasks(w.db, orgId)).map((t) => ({ code: t.code, params: t.params }));

    test("never names a placed demo: no 'explore the demo' task for it, published or not", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftIn(org.id, contact, { sign_in: true });
      const where = await placedIn(view, org.id);
      expect((await publish(view.id, true)).status).toBe(200);
      expect((await addOnboarding(org.id)).status).toBe(200);
      const tasks = await tasksOf(org.id);
      expect(tasks.map((t) => t.code)).not.toContain("explore_demo");
      expect(JSON.stringify(tasks)).not.toContain(projectOf(view));
      expect(JSON.stringify(tasks)).not.toContain(where.workspace_id as string);
    });

    test("in an organisation whose only workspace is a held demo, no task points at that workspace", async () => {
      const contact = await personWithAccount(w, "only-held-contact");
      const orgId = newId();
      await w.db
        .insert(schema.org)
        .values({ id: orgId, name: "Only a demo", account_stage: "customer" });
      await w.db
        .insert(schema.billing_account)
        .values({ id: newId(), org_id: orgId, tier: "free" });
      await joinOrganisation(w, orgId, contact, "owner");
      const view = await draftIn(orgId, contact, { sign_in: true });
      const where = await placedIn(view, orgId);
      expect((await addOnboarding(orgId)).status).toBe(200);
      const tasks = await tasksOf(orgId);
      expect(tasks.length).toBeGreaterThan(0);
      expect(JSON.stringify(tasks)).not.toContain(where.workspace_id as string);
    });
  });

  test("the SQL and the TypeScript held markers agree on every value: only a non-empty string holds", async () => {
    const owner = await personWithAccount(w, "marker-owner");
    const org = await existingOrganisation(w, {
      name: "Markers",
      stage: "customer",
      members: [{ person: owner, role: "owner" }],
    });
    const values: [unknown, boolean][] = [
      ["a-demo-id", true],
      ["", false],
      [null, false],
      [true, false],
      [false, false],
      [1, false],
      [0, false],
      [{ id: "x" }, false],
      [["x"], false],
    ];
    const ids: string[] = [];
    for (const [value] of values) {
      const id = newId();
      ids.push(id);
      await w.db.insert(schema.workspace).values({
        id,
        org_id: org.id,
        name: `Marker ${JSON.stringify(value)}`,
        billing_account_id: org.billingId,
        visibility: "private",
        settings: { held_for_demo: value },
      });
    }
    // A workspace with no settings, and one without the key, are shown too.
    for (const settings of [null, { other: "x" }]) {
      const id = newId();
      ids.push(id);
      values.push([undefined, false]);
      await w.db.insert(schema.workspace).values({
        id,
        org_id: org.id,
        name: `Marker ${JSON.stringify(settings)}`,
        billing_account_id: org.billingId,
        visibility: "private",
        settings,
      });
    }
    const shown = new Set(
      (
        await w.db
          .select({ id: schema.workspace.id })
          .from(schema.workspace)
          .where(and(inArray(schema.workspace.id, ids), shownToOrganisation))
      ).map((r) => r.id),
    );
    const rows = await w.db
      .select({ id: schema.workspace.id, settings: schema.workspace.settings })
      .from(schema.workspace)
      .where(inArray(schema.workspace.id, ids));
    const settingsOf = new Map(rows.map((r) => [r.id, r.settings]));
    const read = ids.map((id) => [!shown.has(id), heldForDemo(settingsOf.get(id)) !== null]);
    expect(read).toEqual(values.map(([, held]) => [held, held]));
  });

  test("the build's popcorn read reaches the hidden project as its owner, the contact, before publish", async () => {
    // A plain member: the organisation role alone opens no hidden workspace.
    const { org, contact } = await organisation("member");
    const view = await draftIn(org.id, contact, { sign_in: true });
    expect(view.status).toBe("draft");
    await placedIn(view, org.id);
    const project = projectOf(view);
    const [loop] = await w.db
      .select({ id: schema.agent_loop.id })
      .from(schema.agent_loop)
      .where(eq(schema.agent_loop.project_id, project));
    expect(extracted).toContain(loop?.id as string);
    const [owner] = await w.db
      .select({ owner: schema.project.directus_user_id })
      .from(schema.project)
      .where(eq(schema.project.id, project));
    expect(owner?.owner).toBe(contact.directusUserId);
    const who = { appUserId: contact.appUserId, directusUserId: contact.directusUserId };
    expect((await resolveProject(demoBuildAccess(w.db), project, who, w.clock.now))?.role).toBe(
      "admin",
    );
  });

  describe("the dembrane person who made the demo is in its held workspace", () => {
    let builder: Person;
    beforeAll(async () => {
      const u = await w.db.transaction((tx) =>
        ensureUser(tx, {
          email: "maker@dembrane.com",
          name: "Demo Maker",
          passwordHash: null,
          nowIso: w.clock.now.toISOString(),
        }),
      );
      builder = {
        appUserId: u.appUserId,
        directusUserId: u.userId,
        isStaff: true,
        email: "maker@dembrane.com",
      };
    });
    /** Starts a demo in the organisation, made by the builder, and builds it to a draft. */
    const draftByBuilder = async (orgId: string, contact: Person) => {
      const r = await start(orgId, contact, { sign_in: true });
      expect(r.status).toBe(201);
      const id = K.DemoStatus.parse(r.data).id;
      await w.db
        .update(schema.account_demo)
        .set({ createdBy: builder.directusUserId })
        .where(eq(schema.account_demo.id, id));
      await buildDemo(deps, id, 1);
      return statusOf(id);
    };
    const projectRole = (who: Person, projectId: string) =>
      w.deps.access.project(who, projectId, "project:read").then(
        (a) => a.role,
        () => null,
      );
    const workspaceRole = (who: Person, workspaceId: string) =>
      w.deps.access.workspace(who, workspaceId, "project:read").then(
        (a) => a.role,
        () => null,
      );

    test("after the seed the builder is its admin and opens the draft, while the organisation's people get nothing of it and nothing is sent", async () => {
      const { org, owner, contact, colleague } = await organisation("member");
      const before = await accountOf(w, org.id);
      w.jobs.jobs.length = 0;
      const view = await draftByBuilder(org.id, contact);
      expect(view.status).toBe("draft");
      const where = await placedIn(view, org.id);
      const workspaceId = where.workspace_id as string;
      expect(await placesIn(w, workspaceId, builder)).toEqual([ADMIN_PLACE]);
      expect(await projectRole(builder, projectOf(view))).toBe("admin");
      expect(await workspaceRole(builder, workspaceId)).toBe("admin");
      // Still held back from the organisation: no role for its owner, admin or the contact.
      const [ws] = await w.db
        .select({ settings: schema.workspace.settings })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, workspaceId));
      expect(heldForDemo(ws?.settings)).toBe(view.id);
      for (const who of [owner, colleague, contact]) {
        expect(await projectRole(who, projectOf(view))).toBeNull();
        expect(await workspaceRole(who, workspaceId)).toBeNull();
        expect(await placesIn(w, workspaceId, who)).toEqual([]);
      }
      // The organisation is as it was: the builder is in the workspace, not the organisation.
      expect(await accountOf(w, org.id)).toEqual(before);
      expect(emailsQueued(w)).toEqual([]);
      const notices = await w.db
        .select({ id: schema.notification.id })
        .from(schema.notification)
        .where(eq(schema.notification.ref_workspace_id, workspaceId));
      expect(notices).toEqual([]);
      // The account's timeline says a dembrane person joined the customer's workspace.
      const [seeded] = await w.db
        .select({ detail: schema.account_event.detail })
        .from(schema.account_event)
        .where(
          and(eq(schema.account_event.orgId, org.id), eq(schema.account_event.type, "demo.seeded")),
        );
      expect(
        (seeded?.detail as Record<string, unknown> | undefined)?.staff_member_added_to_workspace,
      ).toBe(builder.appUserId);
    });

    test("a builder who already has a live row there keeps it as it is when the seed runs again", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftByBuilder(org.id, contact);
      const workspaceId = (await placedIn(view, org.id)).workspace_id as string;
      await w.db
        .update(schema.workspace_membership)
        .set({ role: "member" })
        .where(
          and(
            eq(schema.workspace_membership.workspace_id, workspaceId),
            eq(schema.workspace_membership.user_id, builder.appUserId as string),
          ),
        );
      // The seed step again, as a retry after a crash between its commit and its "done".
      const [row] = await w.db
        .select({ steps: schema.account_demo.steps })
        .from(schema.account_demo)
        .where(eq(schema.account_demo.id, view.id));
      const steps = row?.steps as Record<string, { status: string }>;
      await w.db
        .update(schema.account_demo)
        .set({
          status: "failed",
          // As the retry leaves it: the row is on the attempt the run below is.
          attempt: 2,
          steps: {
            ...steps,
            seed: { ...steps.seed, status: "failed" },
            extract: { ...steps.extract, status: "pending" },
            review: { ...steps.review, status: "pending" },
          } as never,
        })
        .where(eq(schema.account_demo.id, view.id));
      await buildDemo(deps, view.id, 2);
      expect((await statusOf(view.id)).status).toBe("draft");
      expect(await placesIn(w, workspaceId, builder)).toEqual([{ ...ADMIN_PLACE, role: "member" }]);
    });

    test("handed over with the email on: the contact joins as before and the builder stays its admin", async () => {
      const { org, contact } = await organisation("member");
      const view = await draftByBuilder(org.id, contact);
      const workspaceId = (await placedIn(view, org.id)).workspace_id as string;
      expect((await publish(view.id, true)).status).toBe(200);
      expect(await placesIn(w, workspaceId, contact)).toEqual([ADMIN_PLACE]);
      expect(await placesIn(w, workspaceId, builder)).toEqual([ADMIN_PLACE]);
      expect(emailsQueued(w).filter((e) => e.to === builder.email)).toEqual([]);
    });

    test("a builder who is also the demo's contact gets no place at the seed, only at hand-over", async () => {
      const owner = await personWithAccount(w, "selfowner");
      const org = await existingOrganisation(w, {
        name: "Demos self",
        stage: "customer",
        members: [
          { person: owner, role: "owner" },
          { person: builder, role: "member" },
        ],
      });
      w.jobs.jobs.length = 0;
      const view = await draftByBuilder(org.id, builder);
      const workspaceId = (await placedIn(view, org.id)).workspace_id as string;
      expect(await placesIn(w, workspaceId, builder)).toEqual([]);
      expect(await workspaceRole(builder, workspaceId)).toBeNull();
      const [seeded] = await w.db
        .select({ detail: schema.account_event.detail })
        .from(schema.account_event)
        .where(
          and(eq(schema.account_event.orgId, org.id), eq(schema.account_event.type, "demo.seeded")),
        );
      expect(seeded?.detail).not.toHaveProperty("staff_member_added_to_workspace");
      expect((await publish(view.id, true)).status).toBe(200);
      expect(await placesIn(w, workspaceId, builder)).toEqual([ADMIN_PLACE]);
      expect(emailsQueued(w).map((e) => [e.to, e.template])).toEqual([
        [builder.email, "account_demo_ready"],
      ]);
    });
  });

  describe("starting a demo in an existing organisation (criterion 9)", () => {
    const demoCount = async () => (await w.db.select().from(schema.account_demo)).length;
    /** The fields a 422 names, as the forms read them. */
    const fieldsOf = (r: { data: unknown }) => {
      const detail = (r.data as { detail?: unknown }).detail;
      return Array.isArray(detail) ? detail.map((d) => (d as { loc: string[] }).loc[1]) : [];
    };
    const refusedOnOrgId = async (r: { status: number; data: unknown }, before: number) => {
      expect([r.status, fieldsOf(r)]).toEqual([422, ["org_id"]]);
      expect(await demoCount()).toBe(before);
    };

    test("an organisation that does not exist is refused on org_id", async () => {
      const { contact } = await organisation("member");
      const before = await demoCount();
      await refusedOnOrgId(await start(newId(), contact), before);
    });

    test("a deleted organisation is refused on org_id", async () => {
      const { org, contact } = await organisation("member");
      await setOrganisationDeleted(w, org.id, true);
      const before = await demoCount();
      await refusedOnOrgId(await start(org.id, contact), before);
    });

    test("an organisation the contact is not a live member of is refused on org_id", async () => {
      const { org, contact } = await organisation("member");
      const before = await demoCount();
      // Never in it.
      await refusedOnOrgId(await start(w.otherOrgId, contact), before);
      // Removed from it.
      await setRemovedFromOrganisation(w, org.id, contact, true);
      await refusedOnOrgId(await start(org.id, contact), before);
    });

    test("a contact without an account is refused on org_id", async () => {
      const { org } = await organisation("member");
      const before = await demoCount();
      const nobody = { email: "nobody-yet@example.test" } as Person;
      await refusedOnOrgId(await start(org.id, nobody), before);
    });

    test("an offer together with an org_id is refused", async () => {
      const { org, contact } = await organisation("member");
      const before = await demoCount();
      const r = await start(org.id, contact, {
        offer: {
          template: "subscription",
          language: "en",
          items: [
            { description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 },
          ],
        },
      });
      expect(r.status).toBe(422);
      expect(fieldsOf(r).some((f) => f === "offer" || f === "org_id")).toBe(true);
      expect(await demoCount()).toBe(before);
    });

    test("a valid org_id is accepted, and the demo names the organisation from the first answer on", async () => {
      const { org, contact } = await organisation("member");
      w.jobs.jobs.length = 0;
      const r = await start(org.id, contact);
      expect(r.status).toBe(201);
      const first = K.DemoStatus.parse(r.data);
      expect(first.status).toBe("queued");
      expect(first.existing_organisation).toEqual({ id: org.id, name: org.name });
      expect((await statusOf(first.id)).existing_organisation).toEqual({
        id: org.id,
        name: org.name,
      });
      expect(w.jobs.jobs.map((j) => j.name)).toEqual(["accounts.demo-build"]);
      // A demo without org_id still answers null.
      const own = K.DemoStatus.parse((await start(null, contact)).data);
      expect(own.existing_organisation).toBeNull();
    });
  });

  describe("the new demo form's check (POST .../demos/check)", () => {
    const check = async (body: Record<string, unknown>) => {
      const r = await call(w, "POST", `${DEMOS}/check`, "staff", body);
      expect(r.status).toBe(200);
      return K.DemoCheck.parse(r.data);
    };

    test("without an email there is no contact", async () => {
      expect((await check({})).contact).toBeNull();
      expect((await check({ organisation_name: "Nowhere Council" })).contact).toBeNull();
    });

    test("an address without an account reads as new: no account and no organisations", async () => {
      expect((await check({ contact_email: "first-time@nowhere.example" })).contact).toEqual({
        has_account: false,
        name: null,
        organisations: [],
      });
    });

    test("a known contact gets their live organisations with role and stage, real organisations before prospects", async () => {
      const jules = await personWithAccount(w, "jules", { name: "Jules Example" });
      const at = (name: string, stage: "customer" | "prospect" | null, role: OrgRole) =>
        existingOrganisation(w, { name, stage, members: [{ person: jules, role }] });
      // The prospect first, so the order cannot come from the order they were joined.
      const prospect = await at("Example Water Board", "prospect", "owner");
      const customer = await at("Provincie Proefland", "customer", "member");
      const noStage = await at("Stichting Zonder Fase", null, "admin");
      const left = await at("Verlaten BV", "customer", "admin");
      await setRemovedFromOrganisation(w, left.id, jules, true);
      const gone = await at("Opgeheven BV", "customer", "admin");
      await setOrganisationDeleted(w, gone.id, true);

      const { contact } = await check({ contact_email: "JULES@example.test" });
      expect(contact?.has_account).toBe(true);
      expect(contact?.name).toBe("Jules Example");
      const orgs = contact?.organisations ?? [];
      expect(orgs).toHaveLength(3);
      expect(orgs.slice(0, 2).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { id: customer.id, name: customer.name, account_stage: "customer", role: "member" },
        { id: noStage.id, name: noStage.name, account_stage: null, role: "admin" },
      ]);
      expect(orgs[2]).toEqual({
        id: prospect.id,
        name: prospect.name,
        account_stage: "prospect",
        role: "owner",
      });
    });

    test("organisations with the same name match trimmed and case-insensitive, and leave out the contact's own", async () => {
      const kim = await personWithAccount(w, "kim");
      const own = await existingOrganisation(w, {
        name: "Harbour Board",
        stage: "customer",
        members: [{ person: kim, role: "member" }],
      });
      const named = async (name: string, stage: "customer" | "prospect" | null) =>
        existingOrganisation(w, { name, stage, members: [] });
      const same = await named("Harbour Board", "prospect");
      const lower = await named("harbour board", null);
      const spaced = await named("  Harbour Board ", "customer");
      const deleted = await named("HARBOUR BOARD", "customer");
      await setOrganisationDeleted(w, deleted.id, true);
      await named("Harbour Boards", "customer");

      const answer = await check({
        contact_email: kim.email,
        organisation_name: "  hArBoUr bOaRd ",
      });
      expect(answer.contact?.organisations.map((o) => o.id)).toEqual([own.id]);
      expect(answer.organisations_named.map((o) => o.id).sort()).toEqual(
        [same.id, lower.id, spaced.id].sort(),
      );
      const stageOf = new Map(answer.organisations_named.map((o) => [o.id, o.account_stage]));
      expect(stageOf.get(same.id)).toBe("prospect");
      expect(stageOf.get(lower.id)).toBeNull();
      // Without an email every live organisation of that name is named, theirs included.
      expect(
        (await check({ organisation_name: "harbour board" })).organisations_named
          .map((o) => o.id)
          .sort(),
      ).toEqual([own.id, same.id, lower.id, spaced.id].sort());
    });

    test("earlier demos for the same email or the same name come newest first, at most five, with both flags", async () => {
      const repeat = await personWithAccount(w, "repeat");
      const someone = await personWithAccount(w, "someone");
      const clock = w.clock.now;
      const made: string[] = [];
      const demoAt = async (minute: number, who: Person, email: string, name: string) => {
        w.clock.now = new Date(clock.getTime() + minute * 60_000);
        const r = await start(null, who, { contact_email: email, organisation_name: name });
        expect(r.status).toBe(201);
        made.push(K.DemoStatus.parse(r.data).id);
      };
      try {
        await demoAt(1, repeat, repeat.email, "Somewhere Else"); // same contact, dropped as the sixth
        await demoAt(2, repeat, repeat.email.toUpperCase(), "Herhaalstad"); // both
        await demoAt(3, someone, someone.email, "herhaalstad"); // same name
        await demoAt(4, someone, someone.email, "HERHAALSTAD"); // same name
        await demoAt(5, repeat, repeat.email, "Anything"); // same contact
        await demoAt(6, repeat, repeat.email, "Anything Else"); // same contact
        await demoAt(7, someone, someone.email, "Unrelated Town"); // neither, and the newest
      } finally {
        w.clock.now = clock;
      }
      const { demos } = await check({
        contact_email: repeat.email.toUpperCase(),
        organisation_name: " Herhaalstad ",
      });
      expect(
        demos.map((d) => `${d.id} contact:${d.same_contact} name:${d.same_organisation}`),
      ).toEqual([
        `${made[5]} contact:true name:false`,
        `${made[4]} contact:true name:false`,
        `${made[3]} contact:false name:true`,
        `${made[2]} contact:false name:true`,
        `${made[1]} contact:true name:true`,
      ]);
      expect(demos[0]).toMatchObject({
        organisation_name: "Anything Else",
        contact_email: repeat.email,
        status: "queued",
      });
    });
  });
});
