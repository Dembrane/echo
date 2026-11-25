import type { Access, Principal } from "@dembrane/access";
import { BadRequestError, ForbiddenError, isUuid, NotFoundError, newId } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import {
  accountProviders,
  allowedAmong,
  isJob,
  isProviderId,
  JOBS,
  type Job,
  type PerJob,
  type ProviderId,
  providersFor,
  type RoutingPolicy,
  type StoredAccountProviders,
  serves,
} from "@dembrane/llm";
import {
  accountVolume,
  type CostLine,
  costLine,
  loggedUnitCosts,
  mergeUnitCosts,
  monthSpend,
  monthStart,
  type UnitCosts,
} from "@dembrane/metering";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

const refused = (message: string) => new BadRequestError("request.invalid", { message });

const { account_event, account_ticket, app_user, auth_user, org, project, workspace } = schema;

export interface AiProvidersDeps {
  readonly db: Db;
  readonly access: Access;
  /** What the deployment has and its default: the database only chooses among it. */
  readonly policy: RoutingPolicy;
  /** The model ids each provider uses here for speech and analysis, from the deployment's config. */
  readonly models?: Partial<Record<ProviderId, readonly string[]>>;
  /** Unit costs from the price list, for a provider the call log has no history for yet. */
  readonly priceList?: () => UnitCosts | null;
  /** How long the log's average costs are kept in the process; ten minutes unless a test says otherwise. */
  readonly unitCostTtlMs?: number;
  readonly now: () => Date;
}

export const ORG_EVENT = "ai_providers.changed";
export const PROJECT_EVENT = "project.ai_provider.changed";

/** The cost of each provider for each job, as the screens' cost lines read it. */
export type CostLines = Record<Job, Partial<Record<ProviderId, CostLine>>>;

/** The account's setting: what it has enabled for each job, and its default for each. */
export interface Setting {
  readonly enabled: Record<Job, ProviderId[]>;
  readonly defaults: Record<Job, ProviderId>;
}

/** One account setting as the screens read it. */
export interface OrgProviders extends Setting {
  readonly jobs: readonly Job[];
  /** The providers this deployment has. */
  readonly available: ProviderId[];
  /** The jobs each of them serves. */
  readonly serves: Record<ProviderId, Job[]>;
  /** What projects use unless the account says otherwise. */
  readonly environment_default: ProviderId;
  /** The models each provider uses on this deployment, for the cards that name them. */
  readonly models: Partial<Record<ProviderId, readonly string[]>>;
}

/** A change of the account's setting, as one line of its history. */
export interface HistoryLine {
  readonly at: string;
  readonly kind: "enabled" | "disabled" | "default";
  readonly provider: ProviderId;
  readonly job: Job;
  /** When the written request that asked for it was made. */
  readonly request_at: string | null;
  /** Who made the change; read by staff only. */
  readonly by?: string | null;
}

/** What the account has spent this calendar month, per provider, in euros. */
export interface MonthSpend {
  readonly from: string;
  readonly spent: Record<ProviderId, number>;
}

const isSetting = (v: unknown): v is Setting => {
  const s = v as Setting | null;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.enabled === "object" &&
    s.enabled !== null &&
    typeof s.defaults === "object" &&
    s.defaults !== null &&
    JOBS.every((j) => Array.isArray(s.enabled[j]) && isProviderId(s.defaults[j]))
  );
};

/** What an organisation row holds of the account's setting. */
export interface OrgRow {
  ai_transcription_providers: string[] | null;
  ai_analysis_providers: string[] | null;
  ai_transcription_default: string | null;
  ai_analysis_default: string | null;
}

const orgColumns = {
  ai_transcription_providers: org.ai_transcription_providers,
  ai_analysis_providers: org.ai_analysis_providers,
  ai_transcription_default: org.ai_transcription_default,
  ai_analysis_default: org.ai_analysis_default,
};

const storedOf = (row: OrgRow): StoredAccountProviders => ({
  enabled: {
    transcription: row.ai_transcription_providers,
    analysis: row.ai_analysis_providers,
  },
  defaults: {
    transcription: row.ai_transcription_default,
    analysis: row.ai_analysis_default,
  },
});

/** The setting an account has: what it stored, over the deployment's policy. */
export function settingOf(policy: RoutingPolicy, row: OrgRow): Setting {
  const stored = storedOf(row);
  const per = (job: Job) => accountProviders(policy, stored, job);
  const pick = <T>(f: (a: ReturnType<typeof per>) => T): PerJob<T> => ({
    transcription: f(per("transcription")),
    analysis: f(per("analysis")),
  });
  const enabled = pick((a) => (a.enabled.length ? a.enabled : [policy.default]));
  const defaults = pick((a) => a.default ?? policy.default);
  return { enabled: { ...enabled }, defaults: { ...defaults } };
}

export function describe(d: Pick<AiProvidersDeps, "policy" | "models">, row: OrgRow): OrgProviders {
  return {
    ...settingOf(d.policy, row),
    jobs: JOBS,
    available: [...d.policy.providers],
    serves: Object.fromEntries(
      d.policy.providers.map((id) => [id, JOBS.filter((j) => serves(id, j))]),
    ) as Record<ProviderId, Job[]>,
    environment_default: d.policy.default,
    models: d.models ?? {},
  };
}

async function liveOrg(db: Db, orgId: string) {
  const [row] = isUuid(orgId)
    ? await db
        .select({ id: org.id, ...orgColumns })
        .from(org)
        .where(and(eq(org.id, orgId), isNull(org.deleted_at)))
        .limit(1)
    : [];
  if (!row) throw new NotFoundError("organisation.not_found");
  return row;
}

/** The lines of an account's history, newest first, from the events its changes wrote. */
export async function orgHistory(
  db: Db,
  orgId: string,
  opts: { limit?: number; withActor?: boolean } = {},
): Promise<HistoryLine[]> {
  const rows = await db
    .select({
      createdAt: account_event.createdAt,
      detail: account_event.detail,
      by: sql<
        string | null
      >`nullif(trim(coalesce(${app_user.display_name}, ${auth_user.name})), '')`,
    })
    .from(account_event)
    .leftJoin(auth_user, eq(auth_user.id, account_event.actorUserId))
    .leftJoin(app_user, eq(app_user.directus_user_id, auth_user.id))
    .where(and(eq(account_event.orgId, orgId), eq(account_event.type, ORG_EVENT)))
    .orderBy(desc(account_event.createdAt))
    .limit(opts.limit ?? 50);
  const out: HistoryLine[] = [];
  for (const r of rows) {
    const detail = (r.detail ?? {}) as { before?: unknown; after?: unknown; request_at?: unknown };
    if (!isSetting(detail.after)) continue;
    const before = isSetting(detail.before) ? detail.before : null;
    const at = r.createdAt.toISOString();
    const request_at = typeof detail.request_at === "string" ? detail.request_at : null;
    const who = opts.withActor ? { by: r.by } : {};
    for (const job of JOBS) {
      const had = new Set(before?.enabled[job] ?? []);
      const has = new Set(detail.after.enabled[job]);
      for (const p of detail.after.enabled[job])
        if (isProviderId(p) && !had.has(p))
          out.push({ at, kind: "enabled", provider: p, job, request_at, ...who });
      for (const p of before?.enabled[job] ?? [])
        if (isProviderId(p) && !has.has(p))
          out.push({ at, kind: "disabled", provider: p, job, request_at, ...who });
      if (before && before.defaults[job] !== detail.after.defaults[job])
        out.push({
          at,
          kind: "default",
          provider: detail.after.defaults[job],
          job,
          request_at,
          ...who,
        });
    }
  }
  return out;
}

// ── Cost ────────────────────────────────────────────────────────────

const LOGGED_TTL_MS = 10 * 60_000;
const logged = new WeakMap<Db, { at: number; value: Promise<UnitCosts> }>();

/**
 * Each provider's average cost per unit across every account over the last 30 days. It is the
 * same for everyone who asks, so a process keeps it for a few minutes instead of reading the
 * call log on every page view.
 */
function loggedCosts(d: Pick<AiProvidersDeps, "db" | "now" | "unitCostTtlMs">): Promise<UnitCosts> {
  const now = d.now();
  const hit = logged.get(d.db);
  if (hit && now.getTime() - hit.at < (d.unitCostTtlMs ?? LOGGED_TTL_MS)) return hit.value;
  const value = loggedUnitCosts(d.db, now);
  logged.set(d.db, { at: now.getTime(), value });
  value.catch(() => logged.delete(d.db));
  return value;
}

/** What each provider would cost an account (or one of its projects) for each job. */
export async function costLines(
  d: Pick<AiProvidersDeps, "db" | "policy" | "now" | "priceList" | "unitCostTtlMs">,
  who: { organisationId: string; projectId?: string },
): Promise<CostLines> {
  const [volume, history] = await Promise.all([accountVolume(d.db, who, d.now()), loggedCosts(d)]);
  const unit = mergeUnitCosts(history, d.priceList?.() ?? null);
  const lines = {} as CostLines;
  for (const job of JOBS) {
    lines[job] = Object.fromEntries(
      providersFor(d.policy, job).map((id) => [id, costLine(id, job, volume, unit[id])]),
    );
  }
  return lines;
}

/** What the account has spent this month per provider. */
export async function monthOf(
  d: Pick<AiProvidersDeps, "db" | "now">,
  orgId: string,
): Promise<MonthSpend> {
  const now = d.now();
  return { from: monthStart(now).toISOString(), spent: await monthSpend(d.db, orgId, now) };
}

// ── Accounts ────────────────────────────────────────────────────────

/** What an owner or admin reads: the setting, its cost, this month's spend and its history. Only they see it. */
export async function readOrg(d: AiProvidersDeps, who: Principal, orgId: string) {
  const { role } = await d.access.org(who, orgId, "account:read");
  if (role !== "owner" && role !== "admin") throw new ForbiddenError("organisation.admin_only");
  const row = await liveOrg(d.db, orgId);
  const [cost, month, history] = await Promise.all([
    costLines(d, { organisationId: orgId }),
    monthOf(d, orgId),
    orgHistory(d.db, orgId),
  ]);
  return { ...describe(d, row), cost, month, history };
}

/** What staff read: the setting, its history, its cost and spend, and the account's tickets to cite as the request. */
export async function readOrgForStaff(
  d: Pick<AiProvidersDeps, "db" | "policy" | "models" | "now" | "priceList" | "unitCostTtlMs">,
  orgId: string,
) {
  const row = await liveOrg(d.db, orgId);
  const tickets = await d.db
    .select({
      id: account_ticket.id,
      subject: account_ticket.subject,
      created_at: account_ticket.createdAt,
    })
    .from(account_ticket)
    .where(eq(account_ticket.orgId, orgId))
    .orderBy(desc(account_ticket.createdAt))
    .limit(50);
  const [cost, month] = await Promise.all([
    costLines(d, { organisationId: orgId }),
    monthOf(d, orgId),
  ]);
  return {
    ...describe(d, row),
    cost,
    month,
    history: await orgHistory(d.db, orgId, { withActor: true }),
    tickets: tickets.map((t) => ({ ...t, created_at: t.created_at.toISOString() })),
  };
}

export interface SetOrgInput {
  /** The providers enabled for each job. */
  readonly enabled: Readonly<Record<Job, readonly string[]>>;
  /** The default for each job: one of the providers enabled for it. */
  readonly defaults: Readonly<Record<Job, string>>;
  readonly requestTicketId: string;
}

/**
 * Staff set what an account has enabled for each job and its default for each, after a written
 * request: the ticket it was made in must be one of the account's. The change and its
 * account_event commit together. A provider taken away from a job also clears the projects that
 * chose it for that job, so giving it back later does not send them there again without a
 * project admin choosing it.
 */
export async function setOrg(
  d: Pick<AiProvidersDeps, "db" | "policy" | "models" | "now">,
  staffUserId: string | null,
  orgId: string,
  input: SetOrgInput,
) {
  const enabled = {} as Record<Job, ProviderId[]>;
  const defaults = {} as Record<Job, ProviderId>;
  for (const job of JOBS) {
    const wanted = [...new Set(input.enabled[job] ?? [])];
    const bad = wanted.filter((p) => !isProviderId(p));
    if (bad.length || !wanted.length)
      throw refused(`Not an AI provider for ${job}: ${bad.join(", ") || "none given"}`);
    const missing = wanted.filter((p) => !d.policy.providers.includes(p as ProviderId));
    if (missing.length) throw refused(`This deployment has no provider ${missing.join(", ")}`);
    const silent = wanted.filter((p) => !serves(p as ProviderId, job));
    if (silent.length) throw refused(`${silent.join(", ")} does not serve ${job}`);
    const chosen = input.defaults[job];
    if (!isProviderId(chosen) || !wanted.includes(chosen))
      throw refused(`The ${job} default must be one of the providers enabled for ${job}`);
    enabled[job] = allowedAmong(d.policy, wanted);
    defaults[job] = chosen;
  }
  if (!isUuid(input.requestTicketId)) throw refused("Name the request ticket this change answers");
  const next: Setting = { enabled, defaults };

  return d.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const row = await liveOrg(db, orgId);
    const [ticket] = await db
      .select({ id: account_ticket.id, createdAt: account_ticket.createdAt })
      .from(account_ticket)
      .where(and(eq(account_ticket.id, input.requestTicketId), eq(account_ticket.orgId, orgId)))
      .limit(1);
    if (!ticket) throw refused("The request ticket is not one of this account's");
    const was = settingOf(d.policy, row);
    const removed = (job: Job) => was.enabled[job].filter((p) => !enabled[job].includes(p));
    await db
      .update(org)
      .set({
        ai_transcription_providers: enabled.transcription,
        ai_analysis_providers: enabled.analysis,
        ai_transcription_default: defaults.transcription,
        ai_analysis_default: defaults.analysis,
      })
      .where(eq(org.id, orgId));
    const inAccount = db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.org_id, orgId));
    let reset = 0;
    const gone = { transcription: removed("transcription"), analysis: removed("analysis") };
    if (gone.transcription.length) {
      const cleared = await db
        .update(project)
        .set({ ai_transcription_provider: null })
        .where(
          and(
            inArray(project.ai_transcription_provider, gone.transcription),
            inArray(project.workspace_id, inAccount),
          ),
        )
        .returning({ id: project.id });
      reset += cleared.length;
    }
    if (gone.analysis.length) {
      const cleared = await db
        .update(project)
        .set({ ai_analysis_provider: null })
        .where(
          and(
            inArray(project.ai_analysis_provider, gone.analysis),
            inArray(project.workspace_id, inAccount),
          ),
        )
        .returning({ id: project.id });
      reset += cleared.length;
    }
    await db.insert(account_event).values({
      id: newId(),
      orgId,
      actorKind: "staff",
      actorUserId: staffUserId,
      type: ORG_EVENT,
      subjectType: "org",
      subjectId: orgId,
      detail: {
        before: was,
        after: next,
        request_ticket_id: ticket.id,
        request_at: ticket.createdAt.toISOString(),
        projects_reset: reset,
      },
      createdAt: d.now(),
    });
    return describe(d, {
      ai_transcription_providers: enabled.transcription,
      ai_analysis_providers: enabled.analysis,
      ai_transcription_default: defaults.transcription,
      ai_analysis_default: defaults.analysis,
    });
  });
}

// ── Projects ────────────────────────────────────────────────────────

/** What a project admin sees of one job's choice: the options the account enabled, and where the project is now. */
export interface JobChoice {
  /** What the account has enabled for the job; the field is shown only when there are two or more. */
  readonly options: ProviderId[];
  readonly account_default: ProviderId;
  /** The project's own choice; null follows the account default. */
  readonly current: ProviderId | null;
  readonly effective: ProviderId;
}

export interface ProjectProviders {
  readonly jobs: Record<Job, JobChoice>;
  readonly can_change: boolean;
  /** The models each provider uses on this deployment, for the cards that name them. */
  readonly models: Partial<Record<ProviderId, readonly string[]>>;
  /** What each provider would cost this project, from its own last 30 days. */
  readonly cost: CostLines;
}

type ProjectContext = Awaited<ReturnType<typeof projectContext>>;

async function projectContext(db: Db, projectId: string) {
  const [row] = isUuid(projectId)
    ? await db
        .select({
          id: project.id,
          ai_transcription_provider: project.ai_transcription_provider,
          ai_analysis_provider: project.ai_analysis_provider,
          workspace_id: project.workspace_id,
          org_id: workspace.org_id,
          ...orgColumns,
        })
        .from(project)
        .innerJoin(workspace, eq(workspace.id, project.workspace_id))
        .innerJoin(org, eq(org.id, workspace.org_id))
        .where(and(eq(project.id, projectId), isNull(project.deleted_at)))
        .limit(1)
    : [];
  if (!row) throw new NotFoundError("project.not_found");
  return row;
}

const choiceOf = (row: ProjectContext, job: Job) =>
  job === "transcription" ? row.ai_transcription_provider : row.ai_analysis_provider;

function projectView(
  d: Pick<AiProvidersDeps, "policy" | "models">,
  row: ProjectContext,
  canChange: boolean,
  cost: CostLines,
): ProjectProviders {
  const account = settingOf(d.policy, row);
  const jobs = {} as Record<Job, JobChoice>;
  for (const job of JOBS) {
    const own = allowedAmong(d.policy, [choiceOf(row, job)])[0];
    const current = own && account.enabled[job].includes(own) ? own : null;
    jobs[job] = {
      options: account.enabled[job],
      account_default: account.defaults[job],
      current,
      effective: current ?? account.defaults[job],
    };
  }
  return { jobs, can_change: canChange, models: d.models ?? {}, cost };
}

export async function readProject(d: AiProvidersDeps, who: Principal, projectId: string) {
  await d.access.project(who, projectId, "project:read");
  const row = await projectContext(d.db, projectId);
  let canChange = true;
  try {
    await d.access.project(who, projectId, "settings:manage");
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    canChange = false;
  }
  const cost = await costLines(d, { organisationId: row.org_id, projectId });
  return projectView(d, row, canChange, cost);
}

/**
 * A project admin picks, for one job, among what the account has enabled for it, or null to
 * follow the account's default. Going back to Scaleway applies to the project's very next call.
 */
export async function setProject(
  d: AiProvidersDeps,
  who: Principal,
  projectId: string,
  job: string,
  provider: string | null,
) {
  await d.access.project(who, projectId, "settings:manage");
  if (!isJob(job)) throw refused(`Not a job: ${job}`);
  if (provider !== null && !isProviderId(provider))
    throw refused(`Not an AI provider: ${provider}`);
  const done = await d.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const context = await projectContext(db, projectId);
    // The setting is read under the organisation's row lock, so staff taking Google away
    // either finish first (and this refuses) or wait for this to commit (and then clear the project).
    const [locked] = await db
      .select(orgColumns)
      .from(org)
      .where(eq(org.id, context.org_id))
      .for("update");
    const row = { ...context, ...(locked ?? {}) };
    const account = settingOf(d.policy, row);
    if (provider !== null && !account.enabled[job].includes(provider as ProviderId))
      throw refused(`The account has not enabled ${provider} for ${job}`);
    const before = projectView(d, row, true, emptyCost).jobs[job].current;
    if (before !== provider) {
      await db
        .update(project)
        .set(
          job === "transcription"
            ? { ai_transcription_provider: provider }
            : { ai_analysis_provider: provider },
        )
        .where(eq(project.id, projectId));
      await db.insert(account_event).values({
        id: newId(),
        orgId: row.org_id,
        actorKind: "customer",
        actorUserId: who.directusUserId,
        type: PROJECT_EVENT,
        subjectType: "project",
        subjectId: projectId,
        detail: { job, before, after: provider },
        createdAt: d.now(),
      });
    }
    return {
      ...row,
      ...(job === "transcription"
        ? { ai_transcription_provider: provider }
        : { ai_analysis_provider: provider }),
    };
  });
  return projectView(d, done, true, await costLines(d, { organisationId: done.org_id, projectId }));
}

const emptyCost: CostLines = { transcription: {}, analysis: {} };
