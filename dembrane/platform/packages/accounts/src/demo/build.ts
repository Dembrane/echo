import { ValidationError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import type { Completer } from "@dembrane/llm";
import { defaultSettings, demoIdentity, freshState, type Json, seedDemo } from "@dembrane/popcorn";
import { eq } from "drizzle-orm";
import type { AccountsDeps } from "../deps";
import { emit } from "../events";
import type { Language, OfferItem, OfferTemplate } from "../offer";
import { createAccount } from "../prospect";
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
  /** This deployment's own addresses, refused like the seed route refuses them on production. */
  readonly ownUrls: readonly string[];
  /** Staff's workspace for demo projects, so staff can review them; null puts them in the prospect's organisation. */
  readonly workspaceId: string | null;
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
  readonly continue_url: string;
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
        const out = await fn(row);
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
    return { seed: { ...out, extraction: statuses } as never };
  });
  await step("review", async () => ({ status: "draft" }));
  row = await load(d, demoId);
  if (row.status === "running") await save(d, demoId, { status: "draft" });
}

/** The seed step: organisation, held contact, workspace, synthetic projects, offer draft. */
async function seed(d: DemoBuildDeps, row: Row, input: DemoInput) {
  const staffApp = await store.appUserByDirectusId(d.db, row.createdBy);
  const staff: Signed = {
    appUserId: staffApp?.id ?? null,
    directusUserId: row.createdBy,
    isStaff: true,
  };
  const slug = row.slug ?? demoSlug(input.organisation_name, row.id);
  const account = await createAccount(
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
    { holdSignIn: true },
  );
  const workspaceId = d.demo.workspaceId ?? (await prospectWorkspace(d, account.org_id, slug));
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
      workspaceId,
      ownerId: row.createdBy,
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
  if (input.offer && !offerDocumentId) {
    const offerId = demoIdentity(slug, "offer");
    const existing = await store.document(d.db, account.org_id, offerId);
    if (!existing)
      await pushOffer(
        d,
        staff,
        account.org_id,
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
  await d.db.transaction((tx) =>
    emit(d, tx, {
      orgId: account.org_id,
      actor: { kind: "staff", userId: row.createdBy },
      type: "demo.seeded",
      detail: { slug, demo_id: row.id, links: seeded.result, published: false },
    }),
  );
  const out: SeedOutput = {
    workspace_id: workspaceId,
    projects,
    links: seeded.result,
    contact_user_id: contact.id,
    continue_url: account.continue_url,
  };
  return { orgId: account.org_id, slug, seed: out, offerDocumentId };
}

/** Without a staff demo workspace, the demo lives in a workspace of the prospect's organisation. */
async function prospectWorkspace(d: AccountsDeps, orgId: string, slug: string): Promise<string> {
  const id = demoIdentity(slug, "workspace");
  const billing = await store.billing(d.db, orgId);
  if (!billing) throw new Error("the demo organisation has no billing account");
  await d.db
    .insert(schema.workspace)
    .values({
      id,
      org_id: orgId,
      name: "dembrane demo",
      billing_account_id: billing.id,
      visibility: "open_to_organisation",
    })
    .onConflictDoNothing();
  return id;
}
