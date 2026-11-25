import type { Access, Principal } from "@dembrane/access";
import { BadRequestError, ForbiddenError, isUuid, NotFoundError, newId } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import {
  accountProviders,
  allowedAmong,
  isProviderId,
  type ProviderId,
  type RoutingPolicy,
} from "@dembrane/llm";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

const refused = (message: string) => new BadRequestError("request.invalid", { message });

const { account_event, account_ticket, directus_users, org, project, workspace } = schema;

export interface AiProvidersDeps {
  readonly db: Db;
  readonly access: Access;
  /** What the deployment has and its default: the database only chooses among it. */
  readonly policy: RoutingPolicy;
  /** The model ids each provider uses here for speech and analysis, from the deployment's config. */
  readonly models?: Partial<Record<ProviderId, readonly string[]>>;
  readonly now: () => Date;
}

export const ORG_EVENT = "ai_providers.changed";
export const PROJECT_EVENT = "project.ai_provider.changed";

/** One account setting as the screens read it. */
export interface OrgProviders {
  /** The providers this deployment has. */
  readonly available: ProviderId[];
  /** What projects use unless the account says otherwise. */
  readonly environment_default: ProviderId;
  readonly allowed: ProviderId[];
  /** The provider projects follow unless they choose another. */
  readonly default: ProviderId;
  /** The models each provider uses on this deployment, for the cards that name them. */
  readonly models: Partial<Record<ProviderId, readonly string[]>>;
}

interface Setting {
  readonly allowed: ProviderId[];
  readonly default: ProviderId;
}

/** A change of the account's setting, as one line of its history. */
export interface HistoryLine {
  readonly at: string;
  readonly kind: "added" | "removed" | "default";
  readonly provider: ProviderId;
  /** When the written request that asked for it was made. */
  readonly request_at: string | null;
  /** Who made the change; read by staff only. */
  readonly by?: string | null;
}

const isSetting = (v: unknown): v is Setting =>
  typeof v === "object" &&
  v !== null &&
  Array.isArray((v as Setting).allowed) &&
  isProviderId((v as Setting).default);

export function describe(
  d: Pick<AiProvidersDeps, "policy" | "models">,
  row: {
    ai_providers: string[] | null;
    ai_default_provider: string | null;
  },
): OrgProviders {
  const a = accountProviders(d.policy, {
    allowed: row.ai_providers,
    accountDefault: row.ai_default_provider,
  });
  return {
    available: [...d.policy.providers],
    environment_default: d.policy.default,
    allowed: a.allowed.length ? a.allowed : [d.policy.default],
    default: a.default ?? d.policy.default,
    models: d.models ?? {},
  };
}

async function liveOrg(db: Db, orgId: string) {
  const [row] = isUuid(orgId)
    ? await db
        .select({
          id: org.id,
          ai_providers: org.ai_providers,
          ai_default_provider: org.ai_default_provider,
        })
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
      by: directus_users.email,
    })
    .from(account_event)
    .leftJoin(directus_users, eq(directus_users.id, account_event.actorUserId))
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
    const had = new Set(before?.allowed ?? []);
    const has = new Set(detail.after.allowed);
    for (const p of detail.after.allowed)
      if (isProviderId(p) && !had.has(p))
        out.push({ at, kind: "added", provider: p, request_at, ...who });
    for (const p of before?.allowed ?? [])
      if (isProviderId(p) && !has.has(p))
        out.push({ at, kind: "removed", provider: p, request_at, ...who });
    if (before && before.default !== detail.after.default)
      out.push({ at, kind: "default", provider: detail.after.default, request_at, ...who });
  }
  return out;
}

/** What an owner or admin reads: the setting and its history. Only they see it. */
export async function readOrg(d: AiProvidersDeps, who: Principal, orgId: string) {
  const { role } = await d.access.org(who, orgId, "account:read");
  if (role !== "owner" && role !== "admin") throw new ForbiddenError("organisation.admin_only");
  const row = await liveOrg(d.db, orgId);
  return { ...describe(d, row), history: await orgHistory(d.db, orgId) };
}

/** What staff read: the setting, its history and the account's tickets to cite as the request. */
export async function readOrgForStaff(
  d: Pick<AiProvidersDeps, "db" | "policy" | "models">,
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
  return {
    ...describe(d, row),
    history: await orgHistory(d.db, orgId, { withActor: true }),
    tickets: tickets.map((t) => ({ ...t, created_at: t.created_at.toISOString() })),
  };
}

export interface SetOrgInput {
  readonly allowed: readonly string[];
  readonly default: string;
  readonly requestTicketId: string;
}

/**
 * Staff set what an account may use and its default, after a written request: the ticket
 * it was made in must be one of the account's. The change and its account_event commit
 * together. A provider taken away also clears the projects that chose it, so giving it back
 * later does not send them there again without a project admin choosing it.
 */
export async function setOrg(
  d: Pick<AiProvidersDeps, "db" | "policy" | "models" | "now">,
  staffUserId: string | null,
  orgId: string,
  input: SetOrgInput,
) {
  const wanted = [...new Set(input.allowed)];
  const bad = wanted.filter((p) => !isProviderId(p));
  if (bad.length || !wanted.length)
    throw refused(`Not an AI provider: ${bad.join(", ") || "none given"}`);
  const missing = wanted.filter((p) => !d.policy.providers.includes(p as ProviderId));
  if (missing.length) throw refused(`This deployment has no provider ${missing.join(", ")}`);
  if (!isProviderId(input.default) || !wanted.includes(input.default))
    throw refused("The default must be one of the allowed providers");
  if (!isUuid(input.requestTicketId)) throw refused("Name the request ticket this change answers");
  const allowed = allowedAmong(d.policy, wanted);
  const next: Setting = { allowed, default: input.default };

  return d.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const row = await liveOrg(db, orgId);
    const [ticket] = await db
      .select({ id: account_ticket.id, createdAt: account_ticket.createdAt })
      .from(account_ticket)
      .where(and(eq(account_ticket.id, input.requestTicketId), eq(account_ticket.orgId, orgId)))
      .limit(1);
    if (!ticket) throw refused("The request ticket is not one of this account's");
    const was = describe(d, row);
    const before: Setting = { allowed: was.allowed, default: was.default };
    const removed = before.allowed.filter((p) => !allowed.includes(p));
    await db
      .update(org)
      .set({ ai_providers: allowed, ai_default_provider: next.default })
      .where(eq(org.id, orgId));
    let reset = 0;
    if (removed.length) {
      const cleared = await db
        .update(project)
        .set({ ai_provider: null })
        .where(
          and(
            inArray(project.ai_provider, removed),
            inArray(
              project.workspace_id,
              db.select({ id: workspace.id }).from(workspace).where(eq(workspace.org_id, orgId)),
            ),
          ),
        )
        .returning({ id: project.id });
      reset = cleared.length;
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
        before,
        after: next,
        request_ticket_id: ticket.id,
        request_at: ticket.createdAt.toISOString(),
        projects_reset: reset,
      },
      createdAt: d.now(),
    });
    return describe(d, { ai_providers: allowed, ai_default_provider: next.default });
  });
}

// ── Projects ────────────────────────────────────────────────────────

/** What a project admin sees of the choice: the options the account allows, and where the project is now. */
export interface ProjectProviders {
  /** What the account allows here; the field is shown only when there are two or more. */
  readonly options: ProviderId[];
  readonly account_default: ProviderId;
  /** The project's own choice; null follows the account default. */
  readonly current: ProviderId | null;
  readonly effective: ProviderId;
  readonly can_change: boolean;
  /** The models each provider uses on this deployment, for the cards that name them. */
  readonly models: Partial<Record<ProviderId, readonly string[]>>;
}

async function projectContext(db: Db, projectId: string) {
  const [row] = isUuid(projectId)
    ? await db
        .select({
          id: project.id,
          ai_provider: project.ai_provider,
          workspace_id: project.workspace_id,
          org_id: workspace.org_id,
          ai_providers: org.ai_providers,
          ai_default_provider: org.ai_default_provider,
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

function projectView(
  d: Pick<AiProvidersDeps, "policy" | "models">,
  row: Awaited<ReturnType<typeof projectContext>>,
  canChange: boolean,
): ProjectProviders {
  const account = describe(d, row);
  const own = allowedAmong(d.policy, [row.ai_provider])[0];
  const current = own && account.allowed.includes(own) ? own : null;
  return {
    options: account.allowed,
    account_default: account.default,
    current,
    effective: current ?? account.default,
    can_change: canChange,
    models: account.models,
  };
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
  return projectView(d, row, canChange);
}

/**
 * A project admin picks among what the account allows, or null to follow the account's
 * default. Going back to Scaleway applies to the project's very next model call.
 */
export async function setProject(
  d: AiProvidersDeps,
  who: Principal,
  projectId: string,
  provider: string | null,
) {
  await d.access.project(who, projectId, "settings:manage");
  if (provider !== null && !isProviderId(provider))
    throw refused(`Not an AI provider: ${provider}`);
  return d.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const context = await projectContext(db, projectId);
    // The allowance is read under the organisation's row lock, so staff taking Google away
    // either finish first (and this refuses) or wait for this to commit (and then clear the project).
    const [locked] = await db
      .select({ ai_providers: org.ai_providers, ai_default_provider: org.ai_default_provider })
      .from(org)
      .where(eq(org.id, context.org_id))
      .for("update");
    const row = { ...context, ...(locked ?? {}) };
    const account = describe(d, row);
    if (provider !== null && !account.allowed.includes(provider as ProviderId))
      throw refused(`The account does not allow ${provider}`);
    const before = projectView(d, row, true).current;
    if (before !== provider) {
      await db.update(project).set({ ai_provider: provider }).where(eq(project.id, projectId));
      await db.insert(account_event).values({
        id: newId(),
        orgId: row.org_id,
        actorKind: "customer",
        actorUserId: who.directusUserId,
        type: PROJECT_EVENT,
        subjectType: "project",
        subjectId: projectId,
        detail: { before, after: provider },
        createdAt: d.now(),
      });
    }
    return projectView(d, { ...row, ai_provider: provider }, true);
  });
}
