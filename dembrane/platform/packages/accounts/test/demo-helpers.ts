import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { FakeCompleter } from "@dembrane/llm";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DemoBuildDeps } from "../src/demo/build";
import type { HttpGet } from "../src/demo/fetch";
import { ensureUser } from "../src/prospect";
import { store } from "../src/storage";
import type { World } from "./helpers";

// What a demo build needs besides the database, faked: one small website, a model that
// answers the research and the authoring, and a popcorn read that records what it read.
// Shared by the tests of demos placed in an organisation the contact already works in.

export const DEMO_SITE = "https://www.brent.example/";

const PAGES: Record<string, string> = {
  [DEMO_SITE]:
    "<html><title>Brent Council</title><body><h1>Brent</h1><p>The council plans a new town square.</p></body></html>",
};

const RESEARCH = {
  sector: "Municipality",
  summary: "A council that plans a new town square.",
  facts: [{ text: "The council plans a new town square.", source_url: DEMO_SITE }],
  unknowns: ["When the evenings take place."],
  invented_themes: [
    { title: "Shade", description: "Fiction: trees on the square." },
    { title: "Markets", description: "Fiction: a weekly market." },
  ],
  scenario: "An invented evening in the library about the square.",
};

const AUTHORED = {
  title: "What makes the square yours?",
  subtitle: "An invented evening for Brent.",
  disclosure: "Everything in here is invented: synthetic stories, not real outcomes.",
  invitation_title: "Listen to your people",
  invitation_text: "The real stories come from your residents.",
  notice: "Synthetic demo: invented perspectives.",
  conversations: [
    "resident",
    "shop owner",
    "youth worker",
    "volunteer",
    "student",
    "starter",
    "market trader",
    "older resident",
  ].map((role) => ({
    role,
    theme: "the square",
    lines: Array.from({ length: 20 }, (_, i) => ({
      speaker: i % 2 ? role : "Host",
      text: i % 2 ? `As a ${role} I see it differently, point ${i}.` : "What do you think?",
    })),
  })),
};

/** Build deps on fakes; `extracted` lists the popcorn sessions the build read. */
export function fakeDemoBuild(w: World): { deps: DemoBuildDeps; extracted: string[] } {
  const extracted: string[] = [];
  const get: HttpGet = async (url) => {
    const body = PAGES[url];
    return body
      ? { status: 200, url, contentType: "text/html; charset=utf-8", body }
      : { status: 404, url, contentType: "text/html", body: "" };
  };
  const deps: DemoBuildDeps = {
    ...w.deps,
    completer: new FakeCompleter()
      .on("You research an organisation", JSON.stringify(RESEARCH))
      .on("You write the fictional corpus", JSON.stringify(AUTHORED)),
    get,
    extract: async (loopId) => {
      extracted.push(loopId);
      return "ok";
    },
    demo: w.deps.settings.demo as DemoBuildDeps["demo"],
  };
  return { deps, extracted };
}

export type Person = World["people"]["admin"];

/**
 * Someone with a dembrane account, signed in before, known to the world's routes under `key`
 * (call(w, ..., key as never) acts as them). `language` is the language saved on their profile.
 */
export async function personWithAccount(
  w: World,
  key: string,
  opts: { name?: string; language?: string } = {},
): Promise<Person> {
  const email = `${key}@example.test`;
  const u = await w.db.transaction((tx) =>
    ensureUser(tx, {
      email,
      name: opts.name ?? key,
      passwordHash: null,
      nowIso: w.clock.now.toISOString(),
    }),
  );
  await w.db
    .update(schema.auth_user)
    .set({ emailVerified: true })
    .where(eq(schema.auth_user.id, u.userId));
  if (opts.language)
    await w.db
      .update(schema.directus_users)
      .set({ language: opts.language })
      .where(eq(schema.directus_users.id, u.userId));
  const person: Person = {
    appUserId: u.appUserId,
    directusUserId: u.userId,
    isStaff: false,
    email,
  };
  (w.people as Record<string, Person>)[key] = person;
  return person;
}

export type OrgRole = "owner" | "admin" | "billing" | "member";

/**
 * An organisation people already work in: a billing account, one workspace of its own
 * ("Team", open to the organisation) and live memberships for the given people.
 */
export async function existingOrganisation(
  w: World,
  spec: {
    name: string;
    stage: "customer" | "prospect" | "churned" | null;
    managerAppUserId?: string | null;
    billingEmail?: string | null;
    members: readonly { person: Person; role: OrgRole }[];
  },
) {
  const id = newId();
  const billingId = newId();
  const workspaceId = newId();
  await w.db.insert(schema.org).values({ id, name: spec.name, account_stage: spec.stage });
  await w.db.insert(schema.billing_account).values({
    id: billingId,
    org_id: id,
    tier: "free",
    billing_email: spec.billingEmail ?? null,
    account_manager_id: spec.managerAppUserId ?? null,
  });
  await w.db.insert(schema.workspace).values({
    id: workspaceId,
    org_id: id,
    name: "Team",
    billing_account_id: billingId,
    visibility: "open_to_organisation",
    is_default: true,
  });
  for (const m of spec.members) await joinOrganisation(w, id, m.person, m.role);
  return { id, name: spec.name, billingId, workspaceId };
}

/** A live organisation membership. */
export async function joinOrganisation(w: World, orgId: string, person: Person, role: OrgRole) {
  await w.db.insert(schema.org_membership).values({
    id: newId(),
    org_id: orgId,
    user_id: person.appUserId as string,
    role,
  });
}

/** Removes (soft-deletes) a person from an organisation, or puts them back. */
export async function setRemovedFromOrganisation(
  w: World,
  orgId: string,
  person: Person,
  removed: boolean,
) {
  await w.db
    .update(schema.org_membership)
    .set({ deleted_at: removed ? w.clock.now.toISOString() : null })
    .where(
      and(
        eq(schema.org_membership.org_id, orgId),
        eq(schema.org_membership.user_id, person.appUserId as string),
      ),
    );
}

/** Deletes (soft) an organisation, or restores it. */
export async function setOrganisationDeleted(w: World, orgId: string, deleted: boolean) {
  await w.db
    .update(schema.org)
    .set({ deleted_at: deleted ? w.clock.now.toISOString() : null })
    .where(eq(schema.org.id, orgId));
}

/** Every row a person has in a workspace, a removed one included. */
export async function placesIn(w: World, workspaceId: string, person: Person) {
  return w.db
    .select({
      role: schema.workspace_membership.role,
      source: schema.workspace_membership.source,
      deleted_at: schema.workspace_membership.deleted_at,
    })
    .from(schema.workspace_membership)
    .where(
      and(
        eq(schema.workspace_membership.workspace_id, workspaceId),
        eq(schema.workspace_membership.user_id, person.appUserId as string),
      ),
    );
}

export const ADMIN_PLACE = { role: "admin", source: "direct", deleted_at: null };

/** The organisation's workspaces, removed ones included, oldest first. */
export async function workspacesOf(w: World, orgId: string) {
  return w.db
    .select({
      id: schema.workspace.id,
      name: schema.workspace.name,
      deleted_at: schema.workspace.deleted_at,
    })
    .from(schema.workspace)
    .where(eq(schema.workspace.org_id, orgId))
    .orderBy(asc(schema.workspace.created_at), asc(schema.workspace.id));
}

/** Where a project is: its workspace, that workspace's organisation, and its pin. */
export async function whereIs(w: World, projectId: string) {
  const [row] = await w.db
    .select({
      workspace_id: schema.project.workspace_id,
      pin_order: schema.project.pin_order,
      org_id: schema.workspace.org_id,
      workspace_name: schema.workspace.name,
    })
    .from(schema.project)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.project.workspace_id))
    .where(eq(schema.project.id, projectId));
  return row ?? null;
}

export async function organisationCount(w: World) {
  const [row] = (await w.db.execute(sql`select count(*)::int as n from org`)) as unknown as {
    n: number;
  }[];
  return row?.n ?? 0;
}

/**
 * What a demo must leave as it was in an organisation people already work in: its stage,
 * its account manager and billing details, its tasks, and who is in it with which role.
 */
export async function accountOf(w: World, orgId: string) {
  const org = await store.org(w.db, orgId);
  const billing = await store.billing(w.db, orgId);
  const members = await w.db
    .select({
      user: schema.org_membership.user_id,
      role: schema.org_membership.role,
      deleted_at: schema.org_membership.deleted_at,
    })
    .from(schema.org_membership)
    .where(eq(schema.org_membership.org_id, orgId))
    .orderBy(asc(schema.org_membership.user_id));
  return {
    stage: org?.account_stage ?? null,
    deleted_at: org?.deleted_at ?? null,
    account_manager_id: billing?.account_manager_id ?? null,
    billing_email: billing?.billing_email ?? null,
    tier: billing?.tier ?? null,
    payment_mode: billing?.payment_mode ?? null,
    tasks: (await store.tasks(w.db, orgId)).map((t) => t.code),
    members,
  };
}

/** The emails queued so far. */
export const emailsQueued = (w: World) =>
  w.jobs.of("account.send-email") as {
    to: string;
    template: string;
    language?: string;
    subject: string;
    data: Record<string, string>;
  }[];
