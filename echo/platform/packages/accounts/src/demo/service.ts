import { sendEmail } from "@dembrane/account";
import { ConflictError, NotFoundError, newId, ValidationError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { localeOfEmail, resolveLocale } from "@dembrane/i18n";
import { refuseProduction } from "@dembrane/popcorn";
import { desc, eq } from "drizzle-orm";
import type { AccountsDeps } from "../deps";
import { isUuid } from "../deps";
import { emit } from "../events";
import { releaseSignIn } from "../prospect";
import { staffBase } from "../views";
import {
  DEMO_STEPS,
  type DemoInput,
  type DemoSettings,
  freshSteps,
  type SeedOutput,
  type Steps,
} from "./build";
import { demoBuild, demoWorkflowId } from "./job";

type Row = typeof schema.account_demo.$inferSelect;

const LOCALE = { en: "en-US", nl: "nl-NL" } as const;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function demoView(d: Pick<AccountsDeps, "settings">, row: Row) {
  const input = row.input as DemoInput;
  const steps = row.steps as Steps;
  const seed = row.seed as SeedOutput | null;
  const dash = d.settings.dashboardUrl.replace(/\/+$/, "");
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
        url: `${dash}/${LOCALE[p.language]}/w/${seed?.workspace_id}/projects/${p.project_id}/overview`,
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

async function load(d: AccountsDeps, id: string): Promise<Row> {
  const [row] = isUuid(id)
    ? await d.db.select().from(schema.account_demo).where(eq(schema.account_demo.id, id)).limit(1)
    : [];
  if (!row) throw new NotFoundError("demo.not_found");
  return row;
}

/**
 * Starts a demo. Refused on production like the seed route. The row and the workflow's
 * first run commit together, so a demo never waits for a run that was not queued.
 */
export async function createDemo(
  d: AccountsDeps,
  demo: Pick<DemoSettings, "ownUrls" | "portalUrl" | "apiUrl">,
  who: Signed,
  input: DemoInput,
) {
  refuseProduction([...demo.ownUrls, demo.portalUrl, demo.apiUrl]);
  if (!/^https?:\/\//i.test(input.website_url)) throw new ValidationError("demo.website_invalid");
  const id = newId();
  const now = d.now();
  await d.db.transaction(async (tx) => {
    await tx.insert(schema.account_demo).values({
      id,
      status: "queued",
      input,
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
  return { demos: rows.map((r) => demoView(d, r)) };
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
 * sign-in on, the contact is released (codes may now reach them), the page gets its
 * "Continue in dembrane" link, and the invitation email goes out: at publish, never before.
 * Publishing twice changes nothing.
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
  const now = d.now();
  await d.db.transaction(async (tx) => {
    for (const p of seed.projects) {
      const [config] = await tx
        .select({ settings: schema.canvas_config_revision.popcorn_settings })
        .from(schema.canvas_config_revision)
        .where(eq(schema.canvas_config_revision.id, p.config_id));
      await tx
        .update(schema.canvas_config_revision)
        .set({ popcorn_settings: { ...((config?.settings ?? {}) as object), public: true } })
        .where(eq(schema.canvas_config_revision.id, p.config_id));
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
    if (signIn) {
      await releaseSignIn(tx, seed.contact_user_id);
      // The contact's own language when they already had an account, else the demo's.
      const language =
        (await localeOfEmail(tx, input.contact_email)) ?? resolveLocale(input.language);
      await d.jobs.enqueue(
        sendEmail,
        {
          language,
          to: input.contact_email,
          subject: `Your dembrane account for ${input.organisation_name}`,
          template: "account_invite",
          data: { org_name: input.organisation_name, sign_in_url: seed.continue_url },
          context: `account demo invite ${id}`,
        },
        { tx },
      );
    }
    await tx
      .update(schema.account_demo)
      .set({
        status: "published",
        publishedAt: now,
        ...(signIn && { invitedAt: now }),
        input: { ...input, sign_in: signIn },
        updatedAt: now,
      })
      .where(eq(schema.account_demo.id, id));
    if (row.orgId)
      await emit(d, tx, {
        orgId: row.orgId,
        actor: { kind: "staff", userId: who.directusUserId },
        type: "demo.published",
        detail: { demo_id: id, invited: signIn },
      });
  });
  return demoView(d, await load(d, id));
}
