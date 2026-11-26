import { hasStaffPolicy } from "@dembrane/access";
import { sendEmail } from "@dembrane/account";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  newId,
  ValidationError,
  withoutTrailingSlashes,
} from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { localeOfEmail, resolveLocale } from "@dembrane/i18n";
import { and, desc, eq } from "drizzle-orm";
import { assertPersonSends, staffCan } from "../access";
import type { AccountsDeps, Tx } from "../deps";
import { isUuid } from "../deps";
import { emit } from "../events";
import { handOverDemo, releaseHeldContacts } from "../prospect";
import { store } from "../storage";
import { fieldErrors } from "../validate";
import { iso, staffBase } from "../views";
import {
  DEMO_STEPS,
  type DemoInput,
  demoProjectPath,
  freshSteps,
  type SeedOutput,
  type Steps,
} from "./build";
import { demoBuild, demoWorkflowId } from "./job";
import { PUBLISH_PROBLEM, placement, publishRefusal } from "./placement";

type Row = typeof schema.account_demo.$inferSelect;

export function demoView(d: Pick<AccountsDeps, "settings">, row: Row) {
  const input = row.input as DemoInput;
  const steps = row.steps as Steps;
  const seed = row.seed as SeedOutput | null;
  const dash = withoutTrailingSlashes(d.settings.dashboardUrl);
  const live = row.status === "published";
  const links = (seed?.links ?? {}) as Record<string, { public_link?: string }>;
  return {
    id: row.id,
    status: row.status as "queued" | "running" | "draft" | "failed" | "published",
    organisation_name: input.organisation_name,
    website_url: input.website_url,
    language: input.language,
    contact_email: input.contact_email,
    sign_in: input.sign_in,
    org_id: row.orgId,
    existing_organisation: input.existing_organisation ?? null,
    slug: row.slug,
    steps: DEMO_STEPS.map((name) => ({ name, ...steps[name] })),
    links: {
      public: (seed?.projects ?? []).flatMap((p) => {
        const url = links[p.language]?.public_link;
        return url ? [{ language: p.language, url, live }] : [];
      }),
      projects: (seed?.projects ?? []).map((p) => ({
        language: p.language,
        project_id: p.project_id,
        url: `${dash}${demoProjectPath(p.language, seed?.workspace_id as string, p.project_id)}`,
      })),
      account: row.orgId ? staffBase(row.orgId) : null,
      continue_url: seed?.continue_url ?? null,
    },
    research: row.researchMarkdown,
    conversations: Array.isArray(
      (row.corpus as { conversations?: unknown[] } | null)?.conversations,
    )
      ? (row.corpus as { conversations: unknown[] }).conversations.length
      : null,
    offer_document_id: row.offerDocumentId,
    invited_at: iso(row.invitedAt),
    published_at: iso(row.publishedAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** What staff read on the step a build stopped in. */
export const BUILD_STOPPED =
  "The build stopped before this step finished. Retry to go on from this step.";

/** A minute past the job's own limit, for the clocks of the queue and of this process. */
const BUILD_LIMIT_MS = (demoBuild.expireInSeconds + 60) * 1000;

/**
 * A build still "running" after its job's time limit has no run behind it: the queue ended
 * it at the limit, or lost it before. The row then says so on the step it stopped in, which
 * is what the demo's page needs to show a failed step with its retry and never an endless
 * "Building the demo". Every reader of a demo comes through here, so the page, the list and
 * the retry agree. The write is guarded by the row's last change: a build that finishes at
 * the same moment wins.
 */
async function settle(d: AccountsDeps, row: Row): Promise<Row> {
  if (row.status !== "running") return row;
  const now = d.now();
  if (now.getTime() - row.updatedAt.getTime() < BUILD_LIMIT_MS) return row;
  const steps = { ...(row.steps as Steps) };
  // The step it was in, or the first one not done when it stopped between two.
  const stopped =
    DEMO_STEPS.find((name) => steps[name].status === "running") ??
    DEMO_STEPS.find((name) => steps[name].status !== "done");
  if (stopped)
    steps[stopped] = {
      status: "failed",
      started_at: steps[stopped].started_at,
      finished_at: now.toISOString(),
      error: BUILD_STOPPED,
    };
  const [settled] = await d.db
    .update(schema.account_demo)
    .set({ status: "failed", steps, updatedAt: now })
    .where(
      and(
        eq(schema.account_demo.id, row.id),
        eq(schema.account_demo.status, "running"),
        eq(schema.account_demo.updatedAt, row.updatedAt),
      ),
    )
    .returning();
  if (settled) return settled;
  const [latest] = await d.db
    .select()
    .from(schema.account_demo)
    .where(eq(schema.account_demo.id, row.id))
    .limit(1);
  return latest ?? row;
}

async function load(d: AccountsDeps, id: string): Promise<Row> {
  const [row] = isUuid(id)
    ? await d.db.select().from(schema.account_demo).where(eq(schema.account_demo.id, id)).limit(1)
    : [];
  if (!row) throw new NotFoundError("demo.not_found");
  return settle(d, row);
}

/**
 * Starts a demo, on production too: the prospect's demo lives in the organisation their
 * offer and tasks later go to. Unlike the seed route, the caller names no workspace and no
 * owner; the build writes only into the organisation it creates for this demo (or into
 * staff's demo workspace when one is configured), or, with `org_id`, into a workspace of
 * its own in that organisation, which the contact must be a live member of. The row and
 * the workflow's first run commit together, so a demo never waits for a run that was not
 * queued; a refusal writes nothing.
 */
export async function createDemo(d: AccountsDeps, who: Signed, input: DemoInput) {
  if (!/^https?:\/\//i.test(input.website_url)) throw new ValidationError("demo.website_invalid");
  let existing: DemoInput["existing_organisation"] = null;
  if (input.org_id) {
    // An offer goes to an organisation people already work in from its account card.
    if (input.offer) throw fieldErrors([{ field: "offer", code: "field.invalid" }]);
    const placed = await placement(d.db, input.org_id, input.contact_email);
    if (!placed.ok) throw fieldErrors([{ field: "org_id", code: "field.invalid" }]);
    existing = placed.org;
  }
  const id = newId();
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await tx.insert(schema.account_demo).values({
      id,
      status: "queued",
      input: { ...input, existing_organisation: existing },
      steps: freshSteps(),
      createdBy: who.directusUserId,
      createdAt: now,
      updatedAt: now,
    });
    await d.jobs.enqueue(
      demoBuild,
      { demoId: id, attempt: 1 },
      { tx, workflowId: demoWorkflowId(id, 1) },
    );
  });
  return demoView(d, await load(d, id));
}

export async function demoStatus(d: AccountsDeps, id: string) {
  return demoView(d, await load(d, id));
}

export async function listDemos(d: AccountsDeps) {
  const rows = await d.db
    .select()
    .from(schema.account_demo)
    .orderBy(desc(schema.account_demo.createdAt))
    .limit(50);
  const settled = await Promise.all(rows.map((r) => settle(d, r)));
  return { demos: settled.map((r) => demoView(d, r)) };
}

/**
 * What the new demo form shows once staff typed a contact and a name (POST .../demos/check):
 * whether the contact has an account and the organisations a demo could go to, other live
 * organisations of that name, and earlier demos for either. Emails and names are compared
 * trimmed and case-insensitive. It blocks nothing; it only reads.
 */
export async function checkDemo(
  d: AccountsDeps,
  q: { contact_email?: string | null; organisation_name?: string | null },
) {
  const email = q.contact_email?.trim().toLowerCase() || null;
  const name = q.organisation_name?.trim() || null;
  let contact: {
    has_account: boolean;
    name: string | null;
    organisations: { id: string; name: string; account_stage: string | null; role: string }[];
  } | null = null;
  if (email) {
    const identity = await store.identityByEmail(d.db, email);
    const app = identity ? await store.appUserByDirectusId(d.db, identity.id) : null;
    const known = identity ? await store.identity(d.db, identity.id) : null;
    const organisations = app ? await store.liveOrganisationsOf(d.db, app.id) : [];
    // Real organisations (customers, no stage yet) before prospects, each group by name.
    const prospect = (o: { account_stage: string | null }) =>
      o.account_stage === "prospect" ? 1 : 0;
    contact = {
      has_account: Boolean(identity),
      name: known?.name?.trim() || app?.display_name?.trim() || null,
      organisations: [...organisations]
        .sort((a, b) => prospect(a) - prospect(b))
        .map((o) => ({
          id: o.id,
          name: o.name ?? "",
          account_stage: o.account_stage,
          role: o.role,
        })),
    };
  }
  const theirs = new Set(contact?.organisations.map((o) => o.id));
  const named = name ? await store.organisationsNamed(d.db, name) : [];
  const demos = await store.demosLike(d.db, email, name, 5);
  const norm = (v: unknown) =>
    String(v ?? "")
      .trim()
      .toLowerCase();
  return {
    contact,
    organisations_named: named
      .filter((o) => !theirs.has(o.id))
      .map((o) => ({ id: o.id, name: o.name ?? "", account_stage: o.account_stage })),
    demos: demos.map((r) => {
      const input = r.input as DemoInput;
      return {
        id: r.id,
        organisation_name: input.organisation_name,
        contact_email: input.contact_email,
        status: r.status as ReturnType<typeof demoView>["status"],
        created_at: r.createdAt.toISOString(),
        same_contact: email !== null && norm(input.contact_email) === email,
        same_organisation: name !== null && norm(input.organisation_name) === norm(name),
      };
    }),
  };
}

/** A failed demo runs again from the step that failed; the steps before it are kept. */
export async function retryDemo(d: AccountsDeps, id: string) {
  const row = await load(d, id);
  if (row.status !== "failed") throw new ConflictError("demo.retry_not_failed");
  const steps = row.steps as Steps;
  for (const name of DEMO_STEPS)
    if (steps[name].status !== "done")
      steps[name] = { status: "pending", started_at: null, finished_at: null, error: null };
  const attempt = row.attempt + 1;
  await d.db.transaction(async (tx) => {
    await tx
      .update(schema.account_demo)
      .set({ status: "queued", steps, attempt, updatedAt: d.now() })
      .where(eq(schema.account_demo.id, id));
    await d.jobs.enqueue(
      demoBuild,
      { demoId: id, attempt },
      { tx, workflowId: demoWorkflowId(id, attempt) },
    );
  });
  return demoView(d, await load(d, id));
}

/**
 * Makes the draft public: each session's public setting goes on, so its link serves. With
 * sign-in on, the contact is released (they become the organisation's admin, and codes may
 * now reach someone new), the page gets its "Continue in dembrane" link, and the invitation
 * email goes out: at publish, never before. Publishing twice changes nothing.
 *
 * A demo placed in an organisation the contact already works in is handed over instead
 * (its workspace shows, the contact joins it) and its email says the demo is ready; with
 * the email off it stays held back and only the public link goes live.
 */
export async function publishDemo(
  d: AccountsDeps,
  who: Signed,
  id: string,
  opts: { sign_in: boolean | null },
) {
  const row = await load(d, id);
  if (row.status === "published") return demoView(d, row);
  if (row.status !== "draft") throw new ConflictError("demo.publish_not_draft");
  const input = row.input as DemoInput;
  const seed = row.seed as SeedOutput;
  const signIn = opts.sign_in ?? input.sign_in;
  const placed = Boolean(input.org_id);
  // The invitation goes out once: a demo published again after an unpublish sends none. Only
  // a signed-in person may cause the email.
  const invite = signIn && !row.invitedAt;
  if (invite) assertPersonSends(who);
  const now = d.now();
  await d.db.transaction(async (tx) => {
    // The organisation or the contact may have changed since the build: a hand-over then
    // would put a workspace in a deleted organisation, or give it to someone who left. An
    // organisation deleted outright took the workspace with it and left the demo no org_id.
    if (placed && signIn) {
      const still = row.orgId
        ? await placement(tx, row.orgId, input.contact_email)
        : ({ ok: false, problem: "organisation_missing" } as const);
      if (!still.ok)
        throw new ConflictError(publishRefusal(still.problem), {
          message: PUBLISH_PROBLEM[still.problem],
        });
    }
    for (const p of seed.projects) {
      await setDeckPublic(tx, p.config_id, true);
      if (signIn) {
        const [loop] = await tx
          .select({ state: schema.agent_loop.popcorn_state })
          .from(schema.agent_loop)
          .where(eq(schema.agent_loop.id, p.loop_id));
        const state = (loop?.state ?? {}) as { demo?: Record<string, unknown> };
        await tx
          .update(schema.agent_loop)
          .set({
            popcorn_state: {
              ...state,
              demo: { ...(state.demo ?? {}), continue_url: seed.continue_url },
            },
          })
          .where(eq(schema.agent_loop.id, p.loop_id));
      }
    }
    if (signIn && row.orgId) {
      if (placed) await handOverDemo(tx, row.orgId, seed, now);
      else await releaseHeldContacts(tx, row.orgId, now);
    }
    if (invite) {
      // The contact's own language when they already had an account, else the demo's.
      const language =
        (await localeOfEmail(tx, input.contact_email)) ?? resolveLocale(input.language);
      // In an organisation they already work in the demo is ready, not an account: the
      // email names the organisation as it is called now and opens the project.
      const org = placed && row.orgId ? await store.org(tx, row.orgId) : null;
      const email = placed
        ? {
            subject: `Your demo is ready: ${input.organisation_name}`,
            template: "account_demo_ready",
            data: {
              demo_name: input.organisation_name,
              org_name: org?.name || input.existing_organisation?.name || "",
              demo_url: seed.continue_url,
            },
            context: `account demo ready ${id}`,
          }
        : {
            subject: `Your dembrane account for ${input.organisation_name}`,
            template: "account_invite",
            data: { org_name: input.organisation_name, sign_in_url: seed.continue_url },
            context: `account demo invite ${id}`,
          };
      await d.jobs.enqueue(sendEmail, { language, to: input.contact_email, ...email }, { tx });
    }
    await tx
      .update(schema.account_demo)
      .set({
        status: "published",
        publishedAt: now,
        ...(invite && { invitedAt: now }),
        input: { ...input, sign_in: signIn },
        updatedAt: now,
      })
      .where(eq(schema.account_demo.id, id));
    if (row.orgId)
      await emit(d, tx, {
        orgId: row.orgId,
        actor: { kind: "staff", userId: who.directusUserId },
        type: "demo.published",
        detail: { demo_id: id, invited: invite },
      });
  });
  return demoView(d, await load(d, id));
}

/** Whether a seeded deck answers on its public link. */
async function setDeckPublic(tx: Tx, configId: string, isPublic: boolean): Promise<void> {
  const [config] = await tx
    .select({ settings: schema.canvas_config_revision.popcorn_settings })
    .from(schema.canvas_config_revision)
    .where(eq(schema.canvas_config_revision.id, configId));
  await tx
    .update(schema.canvas_config_revision)
    .set({ popcorn_settings: { ...((config?.settings ?? {}) as object), public: isPublic } })
    .where(eq(schema.canvas_config_revision.id, configId));
}

/**
 * Takes a published demo back to a draft: its public link stops answering until staff
 * publish again, and the same link comes back then. The contact keeps the sign-in they
 * were given.
 */
export async function unpublishDemo(d: AccountsDeps, who: Signed, id: string) {
  const row = await load(d, id);
  if (row.status === "draft") return demoView(d, row);
  if (row.status !== "published") throw new ConflictError("demo.unpublish_not_published");
  const seed = row.seed as SeedOutput;
  const now = d.now();
  await d.db.transaction(async (tx) => {
    for (const p of seed.projects) await setDeckPublic(tx, p.config_id, false);
    await tx
      .update(schema.account_demo)
      .set({ status: "draft", publishedAt: null, updatedAt: now })
      .where(eq(schema.account_demo.id, id));
    if (row.orgId)
      await emit(d, tx, {
        orgId: row.orgId,
        actor: { kind: "staff", userId: who.directusUserId },
        type: "demo.unpublished",
        detail: { demo_id: id },
      });
  });
  return demoView(d, await load(d, id));
}

// The deck asks for its data again every few seconds, and faster while its stage is empty.
const DECK_DATA_AUDIT_MS = 60_000;
const deckDataAudited = new Map<string, number>();

/**
 * The session of a demo's deck that staff open before it is public, so a draft is read
 * before it is published. Staff rights do not open customers' projects; this opens one
 * thing only: the session the demo build seeded for that language, while the demo is a
 * finished draft or published. What is served from it is the room's deck, the same the
 * public link shows once the demo is published.
 *
 * Opening the page is a staff action on the audit trail and on the account's timeline.
 * Reading its data is on the audit trail once a minute per staff member, demo and
 * language, so an open page does not write a row per poll. The drawings and the stream
 * carry nothing of the demo and are only checked.
 */
export async function demoDeck(
  d: AccountsDeps,
  who: Signed,
  id: string,
  language: string,
  part: "page" | "data" | "asset",
  requestId?: string,
): Promise<{ reportId: string }> {
  const target = { type: "demo", id };
  const read = `${who.directusUserId}:${id}:${language}`;
  const now = d.now().getTime();
  const due = now - (deckDataAudited.get(read) ?? 0) >= DECK_DATA_AUDIT_MS;
  if (part === "page" || (part === "data" && due)) {
    await staffCan(d, who, `accounts.demo.deck.${part}`, target, requestId, { language });
    if (part === "data") {
      if (deckDataAudited.size > 10_000) deckDataAudited.clear();
      deckDataAudited.set(read, now);
    }
  } else if (!hasStaffPolicy(who, "staff:accounts")) {
    throw new ForbiddenError("access.staff_only");
  }
  const row = await load(d, id);
  if (row.status !== "draft" && row.status !== "published")
    throw new ConflictError("demo.deck_not_ready");
  const project = (row.seed as SeedOutput | null)?.projects.find((p) => p.language === language);
  if (!project) throw new NotFoundError("demo.not_found");
  if (part === "page" && row.orgId)
    await emit(d, d.db, {
      orgId: row.orgId,
      actor: { kind: "staff", userId: who.directusUserId },
      type: "demo.opened",
      detail: { demo_id: id, language, status: row.status },
    });
  return { reportId: project.report_id };
}
