import { HELD_FOR_DEMO, MADE_FOR_DEMO } from "@dembrane/access";
import { newId, ValidationError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import type { Completer } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { defaultSettings, demoIdentity, freshState, type Json, seedDemo } from "@dembrane/popcorn";
import { and, eq, isNull } from "drizzle-orm";
import { type AccountsDeps, isStaffEmail } from "../deps";
import { emit } from "../events";
import type { Language, OfferItem, OfferTemplate } from "../offer";
import { ensureOnboardingTasks } from "../onboarding";
import { createAccount, joinDemoWorkspace, signInUrl } from "../prospect";
import { pushOffer } from "../staff";
import { store } from "../storage";
import {
  type Authored,
  author,
  type DemoBrief,
  type Research,
  research,
  researchMarkdown,
  STANDARD_COPY,
} from "./author";
import { type FetchedPage, fetchSite, type HttpGet } from "./fetch";
import { demoWorkflowId } from "./job";
import { PLACEMENT_PROBLEM, placement } from "./placement";
import { SALES_PORTAL } from "./sales-portal";

/**
 * A synthetic demo made by echo, as a durable workflow in the worker: fetch the website,
 * research, author the fictional corpus, seed it (creating the organisation and its held
 * contact), run the normal popcorn read, and leave a draft for staff to review and
 * publish. Every step records its progress and output on the account_demo row, and a step
 * already done is never run again, so a retry (a new run of the workflow) resumes at the
 * failed step and a crash mid-step reruns only that step.
 */

export const DEMO_STEPS = ["fetch", "research", "author", "seed", "extract", "review"] as const;
export type DemoStep = (typeof DEMO_STEPS)[number];

export interface DemoInput extends DemoBrief {
  readonly contact_name: string;
  readonly contact_email: string;
  /** The existing organisation staff chose; absent on demos made before the choice. */
  readonly org_id?: string | null;
  /** That organisation as it was when staff started the demo, stored by createDemo. */
  readonly existing_organisation?: { readonly id: string; readonly name: string } | null;
  readonly sign_in: boolean;
  readonly offer: {
    template: OfferTemplate;
    language: Language;
    person_name: string | null;
    attention: string | null;
    items: OfferItem[];
    external_ref: string | null;
  } | null;
}

export interface StepState {
  status: "pending" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}
export type Steps = Record<DemoStep, StepState>;

export function freshSteps(): Steps {
  return Object.fromEntries(
    DEMO_STEPS.map((s) => [
      s,
      { status: "pending", started_at: null, finished_at: null, error: null },
    ]),
  ) as Steps;
}

export interface DemoSettings {
  readonly portalUrl: string;
  readonly apiUrl: string;
  /** Staff's workspace for demo projects, so staff can review them; null puts them in the prospect's organisation. */
  readonly workspaceId: string | null;
  /** Where the QR leads: dembrane's Product Feedback portal on production. */
  readonly feedbackUrl: string;
}

export interface DemoBuildDeps extends AccountsDeps {
  readonly completer: Completer;
  readonly get: HttpGet;
  /** Runs the popcorn read of one session (the tick, on request) and returns its status. */
  readonly extract: (loopId: string, runId: string) => Promise<string>;
  readonly demo: DemoSettings;
}

export interface SeedOutput {
  readonly workspace_id: string;
  readonly projects: {
    language: Language;
    project_id: string;
    report_id: string;
    loop_id: string;
    config_id: string;
  }[];
  readonly links: Json;
  readonly contact_user_id: string;
  /**
   * The contact has nothing of the organisation yet: no membership, and no sign-in for
   * someone new. releaseHeldContacts lets them in and turns this off. Never set on a demo
   * placed in an organisation the contact already works in: publishing hands that one over.
   */
  readonly contact_held?: boolean;
  /** Where "Continue in dembrane" and the email lead: through the sign-in to the demo. */
  readonly continue_url: string;
}

const LOCALE = { en: "en-US", nl: "nl-NL" } as const;

/** A demo project's overview in the dashboard, in the demo's language. */
export function demoProjectPath(language: Language, workspaceId: string, projectId: string) {
  return `/${LOCALE[language]}/w/${workspaceId}/projects/${projectId}/overview`;
}

/** A readable, unique slug: the organisation's name and the demo's id. */
export function demoSlug(name: string, demoId: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${words || "demo"}-${demoId.replace(/-/g, "").slice(-6)}`;
}

type Row = typeof schema.account_demo.$inferSelect;

async function load(d: AccountsDeps, id: string): Promise<Row> {
  const [row] = await d.db
    .select()
    .from(schema.account_demo)
    .where(eq(schema.account_demo.id, id))
    .limit(1);
  if (!row) throw new Error(`demo ${id} not found`);
  return row;
}

async function save(
  d: AccountsDeps,
  id: string,
  patch: Partial<typeof schema.account_demo.$inferInsert>,
) {
  await d.db
    .update(schema.account_demo)
    .set({ ...patch, updatedAt: d.now() })
    .where(eq(schema.account_demo.id, id));
}

/** A model answer that did not parse or arrive gets one more try before the step fails. */
async function twice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

/**
 * The workflow body. `runStep` is the queue's checkpointed step in the worker and a plain
 * call in tests; either way each step is skipped when the row says it is done.
 */
export async function buildDemo(
  d: DemoBuildDeps,
  demoId: string,
  attempt: number,
  runStep: <T>(name: string, fn: () => Promise<T>) => Promise<T> = (_n, fn) => fn(),
): Promise<void> {
  let row = await load(d, demoId);
  if (row.status === "published" || row.status === "draft") return;
  const input = row.input as DemoInput;
  await save(d, demoId, { status: "running" });

  const step = async (
    name: DemoStep,
    fn: (row: Row) => Promise<Partial<typeof schema.account_demo.$inferInsert>>,
  ) => {
    row = await load(d, demoId);
    const steps = row.steps as Steps;
    if (steps[name].status === "done") return;
    await runStep(name, async () => {
      const started = d.now().toISOString();
      await save(d, demoId, {
        steps: {
          ...steps,
          [name]: { status: "running", started_at: started, finished_at: null, error: null },
        },
      });
      try {
        // A demo is dembrane's own spend, whichever step makes the call.
        const out = await withPayer({ internal: "demo_build" }, () => fn(row));
        const latest = (await load(d, demoId)).steps as Steps;
        await save(d, demoId, {
          ...out,
          steps: {
            ...latest,
            [name]: {
              status: "done",
              started_at: started,
              finished_at: d.now().toISOString(),
              error: null,
            },
          },
        });
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        const latest = (await load(d, demoId)).steps as Steps;
        await save(d, demoId, {
          status: "failed",
          steps: {
            ...latest,
            [name]: {
              status: "failed",
              started_at: started,
              finished_at: d.now().toISOString(),
              error: message,
            },
          },
        });
        d.logger.warn(
          { demo_id: demoId, step: name, err: { message }, signal: "accounts.demo_step_failed" },
          "demo step failed",
        );
        throw err;
      }
      return null;
    });
  };

  await step("fetch", async () => ({ pages: await fetchSite(input.website_url, d.get, d.now) }));
  await step("research", async (r) => {
    const pages = r.pages as FetchedPage[];
    const found = await twice(() => research(d.completer, input, pages));
    return {
      research: found,
      researchMarkdown: researchMarkdown(input, pages, found, d.now().toISOString().slice(0, 10)),
    };
  });
  await step("author", async (r) => ({
    corpus: await twice(() => author(d.completer, input, r.research as Research)),
  }));
  await step("seed", async (r) => seed(d, r, input));
  await step("extract", async (r) => {
    const out = r.seed as SeedOutput;
    const statuses: string[] = [];
    for (const p of out.projects) {
      // The popcorn run's request id is a uuid column: derive a stable one per attempt and
      // language, so a retry is its own run and the same attempt never reads twice.
      const runId = demoIdentity(demoId, `${demoWorkflowId(demoId, attempt)}:${p.language}`);
      const status = await d.extract(p.loop_id, runId);
      if (status === "disabled") throw new Error("Popcorn is switched off for the demo project");
      // A draft with an empty presentation looks finished and is not: fail the step so staff
      // see it and retry instead of sending it.
      if (status !== "ok") throw new Error(`The popcorn read ended with status ${status}`);
      statuses.push(status);
    }
    // Read again: staff may have released the contact while the read ran.
    const seeded = (await load(d, r.id)).seed as SeedOutput;
    return { seed: { ...seeded, extraction: statuses } as never };
  });
  await step("review", async () => ({ status: "draft" }));
  row = await load(d, demoId);
  if (row.status === "running") await save(d, demoId, { status: "draft" });
}

/**
 * The seed step. For a new organisation: the organisation, its held contact, the workspace,
 * the synthetic projects, the offer draft and the prospect's onboarding tasks. For an
 * organisation the contact already works in: only a workspace of its own there, held back
 * until publishing hands it over, with the project owned by the contact; the organisation,
 * its billing and the contact's role stay as they are. Either way the @dembrane.com staff
 * member who made the demo becomes an admin of the demo's own workspace (never of the
 * organisation), so they can open and tune the draft in the dashboard; a shared staff demo
 * workspace is staff's already and gets no row, and a maker who is the demo's contact waits
 * for the hand-over or release like any contact.
 */
async function seed(d: DemoBuildDeps, row: Row, input: DemoInput) {
  const staffApp = await store.appUserByDirectusId(d.db, row.createdBy);
  const staff: Signed = {
    appUserId: staffApp?.id ?? null,
    directusUserId: row.createdBy,
    isStaff: true,
  };
  const slug = row.slug ?? demoSlug(input.organisation_name, row.id);
  const placed = input.org_id ? await placement(d.db, input.org_id, input.contact_email) : null;
  // Checked again: the organisation or the contact may have changed since staff started.
  // The sentence is what staff read on the demo's page; a retry once it is fixed goes on.
  if (placed && !placed.ok) throw new Error(PLACEMENT_PROBLEM[placed.problem]);
  const account = placed?.ok
    ? null
    : await createAccount(
        d,
        staff,
        {
          organisation_name: input.organisation_name,
          contact_email: input.contact_email,
          contact_name: input.contact_name,
          pricing_configuration_reference: null,
          stage: "prospect",
          language: input.language,
          org_id: demoIdentity(slug, "prospect-org"),
        },
        { hold: true },
      );
  const orgId = placed?.ok ? placed.org.id : (account?.org_id as string);
  if (account) await defaultManager(d, orgId, staffApp);
  // An organisation staff chose wins over the shared staff demo workspace.
  const sharedWorkspace = placed?.ok ? null : d.demo.workspaceId;
  const workspaceId =
    sharedWorkspace ??
    (await demoWorkspace(
      d,
      orgId,
      slug,
      placed?.ok
        ? { name: input.organisation_name, heldFor: row.id, createdBy: staffApp?.id ?? null }
        : undefined,
    ));
  const authored = row.corpus as Authored;
  const language = input.language;
  const label = STANDARD_COPY[language].label;
  const corpus = authored.conversations.map((c, i) => ({
    id: `c${i + 1}`,
    label: `${c.role} (${label})`,
    start: `${d.now().toISOString().slice(0, 10)}T10:${String(i + 1).padStart(2, "0")}:00+00:00`,
    chunks: c.lines.map((l) => `${l.speaker}: ${l.text}`),
  }));
  // A fresh state: the popcorn read fills it in the next step, as it does for a real session.
  const state = freshState();
  state.demo = {
    synthetic: true,
    public_sources_only: false,
    language,
    disclosure: {
      text: authored.disclosure,
      invitation_title: authored.invitation_title,
      invitation_text: authored.invitation_text,
    },
    notice: { text: authored.notice },
  };
  const settings = defaultSettings(authored.title, input.organisation_name);
  Object.assign(settings, {
    show_qr: true,
    public_labels: "names",
    // A draft: the public link goes live only when staff publish.
    public: false,
    intro: { enabled: true, title: authored.title, subtitle: authored.subtitle },
    data: { enabled: true },
  });
  const seeded = await seedDemo(
    d.db,
    {
      session: {
        slug,
        organisation: input.organisation_name,
        synthetic: true,
        public_sources_only: false,
        title: { [language]: authored.title },
        subtitle: { [language]: authored.subtitle },
      },
      research: row.researchMarkdown ?? "",
      corpus,
      out: { [language]: { state, settings } },
      salesPortal: SALES_PORTAL,
      feedbackUrl: d.demo.feedbackUrl,
      // The same exemptions a seeded sample has: no audio usage, out of the public and staff
      // numbers; its AI use still spends the AI budget. Its sample_version stays empty, which
      // is what keeps the best-practices updater (it selects by that stamp) away from it.
      sample: true,
      // Pinned in the demo's own workspace, so the contact opens it from the workspace's
      // card on every visit, long after the onboarding step that led there is done. A shared
      // staff workspace is not theirs, and staff's pins there are left alone.
      ...(!sharedWorkspace && { pinOrder: 1 }),
      workspaceId,
      // The popcorn read acts as the project's owner and must reach the project. In the
      // demo's own workspace that is the contact (its admin once released or handed over;
      // the build reads through demoBuildAccess until then): the project is theirs, though
      // the staff member who made the demo is an admin of that workspace too. A shared demo
      // workspace stays with staff.
      ownerId: sharedWorkspace
        ? row.createdBy
        : placed?.ok
          ? placed.contact.directusUserId
          : (account?.contact.user_id as string),
      portalBaseUrl: d.demo.portalUrl,
      apiBaseUrl: d.demo.apiUrl,
      dryRun: false,
    },
    d.now(),
  );
  const result = seeded.result as Record<string, { project_id: string; report_id: string }>;
  const projects = [
    {
      language,
      project_id: result[language]?.project_id as string,
      report_id: String(result[language]?.report_id),
      loop_id: demoIdentity(slug, `loop-${language}`),
      config_id: demoIdentity(slug, `config-${language}`),
    },
  ];
  let offerDocumentId = row.offerDocumentId;
  // createDemo refuses an offer together with an existing organisation.
  if (input.offer && account && !offerDocumentId) {
    const offerId = demoIdentity(slug, "offer");
    const existing = await store.document(d.db, orgId, offerId);
    if (!existing)
      await pushOffer(
        d,
        staff,
        orgId,
        {
          template: input.offer.template,
          language: input.offer.language,
          offer_name: input.organisation_name,
          person_name: input.offer.person_name,
          attention: input.offer.attention,
          reference: null,
          title: null,
          currency: "EUR",
          date: null,
          items: input.offer.items,
          external_ref: input.offer.external_ref,
          supersedes_id: null,
          send: false,
        },
        { document: offerId },
      );
    offerDocumentId = offerId;
  }
  const contact = await store.identityByEmail(d.db, input.contact_email);
  if (!contact) throw new ValidationError("demo.contact_not_created");
  await d.db.transaction(async (tx) => {
    // The staff member who made the demo, as an admin of its own workspace from the draft
    // on, under joinDemoWorkspace's rule (any row of theirs there is left as it is). Only a
    // @dembrane.com user, as for defaultManager. A held workspace stays held: a direct row
    // opens it to them alone, and it takes no seat (MADE_FOR_DEMO). A maker who is also the
    // demo's contact is held like any contact and gets their place at hand-over or release.
    const staffAdded =
      !sharedWorkspace &&
      staffApp !== null &&
      isStaffEmail(staffApp.email) &&
      row.createdBy !== contact.id &&
      (await joinDemoWorkspace(tx, orgId, workspaceId, staffApp.id, d.now().toISOString()));
    // The prospect's way from the demo into the product. Only a demo in their own
    // workspace can be opened by them; one in staff's workspace has no "Explore" step. An
    // organisation people already work in is no newcomer and gets no onboarding.
    if (account)
      await ensureOnboardingTasks(d, tx, orgId, {
        demo: sharedWorkspace
          ? null
          : { projectId: projects[0]?.project_id as string, workspaceId },
        createdBy: row.createdBy,
      });
    await emit(d, tx, {
      orgId,
      actor: { kind: "staff", userId: row.createdBy },
      type: "demo.seeded",
      detail: {
        slug,
        demo_id: row.id,
        links: seeded.result,
        published: false,
        // Who from dembrane joined the customer's workspace, when this seed added them.
        ...(staffAdded && { staff_member_added_to_workspace: staffApp?.id }),
      },
    });
  });
  const out: SeedOutput = {
    workspace_id: workspaceId,
    projects,
    links: seeded.result,
    contact_user_id: contact.id,
    ...(account
      ? { contact_held: true, continue_url: account.continue_url }
      : {
          continue_url: signInUrl(
            d.settings.dashboardUrl,
            demoProjectPath(language, workspaceId, projects[0]?.project_id as string),
          ),
        }),
  };
  return { orgId, slug, seed: out, offerDocumentId };
}

/**
 * The staff member who started the demo owns the prospect until someone says otherwise, so
 * sam's messages about it name a person from the first signature on. Only an unset manager
 * is filled, and only with a @dembrane.com user, the same rule the staff routes enforce.
 */
async function defaultManager(
  d: AccountsDeps,
  orgId: string,
  staffApp: { id: string; email: string | null } | null,
): Promise<void> {
  if (!staffApp || !isStaffEmail(staffApp.email)) return;
  const billing = await store.billing(d.db, orgId);
  if (!billing || billing.account_manager_id) return;
  // Guarded on null again in the write, so a manager set by staff meanwhile is kept.
  await d.db
    .update(schema.billing_account)
    .set({ account_manager_id: staffApp.id, updated_at: d.now().toISOString() })
    .where(
      and(
        eq(schema.billing_account.id, billing.id),
        isNull(schema.billing_account.account_manager_id),
      ),
    );
}

/**
 * Without a staff demo workspace, the demo lives in a workspace of the organisation: the
 * prospect's "dembrane demo", open to it. `held`: a workspace in an organisation people
 * already work in, named after the demo and held back from them (private, and marked with
 * HELD_FOR_DEMO for this demo) until publishing hands it over, and marked for good with
 * MADE_FOR_DEMO, so it takes no seats. Inserted directly with the
 * organisation's billing account, outside the free tier's workspace limit, as the
 * prospect's is. An organisation people work in may have no pooled billing account yet
 * (each of its workspaces billed on its own); it gets the one a workspace made there would
 * get (tenancy's orgAccountForNewWorkspace).
 */
async function demoWorkspace(
  d: AccountsDeps,
  orgId: string,
  slug: string,
  held?: { name: string; heldFor: string; createdBy: string | null },
): Promise<string> {
  const id = demoIdentity(slug, "workspace");
  let billing = (await store.billing(d.db, orgId))?.id ?? null;
  if (!billing && held) {
    billing = newId();
    const at = d.now().toISOString();
    await store.insertBilling(d.db, {
      id: billing,
      org_id: orgId,
      tier: "free",
      payment_mode: "none",
      created_by: held.createdBy,
      label: "Org billing",
      created_at: at,
      updated_at: at,
    });
  }
  if (!billing) throw new Error("the demo organisation has no billing account");
  await d.db
    .insert(schema.workspace)
    .values({
      id,
      org_id: orgId,
      name: held?.name ?? "dembrane demo",
      billing_account_id: billing,
      visibility: held ? "private" : "open_to_organisation",
      ...(held && { settings: { [HELD_FOR_DEMO]: held.heldFor, [MADE_FOR_DEMO]: held.heldFor } }),
    })
    .onConflictDoNothing();
  return id;
}
