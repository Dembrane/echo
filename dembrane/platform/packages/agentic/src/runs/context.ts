import { PaymentRequiredError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import type postgres from "postgres";
import { isUuid } from "./storage";

const STAFF_ROLE = "Administrator";

/**
 * The caller a turn acts as, rebuilt in the worker from the run's creator: the same
 * app_user and staff lookup the API's session middleware does. Null when the user is gone,
 * which ends the turn instead of running it with no identity.
 */
export async function principalFor(
  sql: postgres.Sql,
  directusUserId: string,
): Promise<Signed | null> {
  if (!isUuid(directusUserId)) return null;
  const [row] = await sql`
    select au.id as app_user_id, r.name as role_name
    from directus_users du
    left join app_user au on au.directus_user_id = du.id
    left join directus_roles r on r.id = du.role
    where du.id = ${directusUserId} limit 1`;
  if (!row) return null;
  return {
    appUserId: (row.app_user_id as string | null) ?? null,
    directusUserId,
    isStaff: row.role_name === STAFF_ROLE,
  };
}

/** PostHog distinct id: the app user's email so server events merge with the browser's person. */
export async function distinctIdFor(
  sql: postgres.Sql,
  directusUserId: string | null,
  fallback: string,
): Promise<string> {
  if (!directusUserId) return fallback;
  if (!isUuid(directusUserId)) return directusUserId;
  try {
    const [row] = await sql`
      select email from app_user where directus_user_id = ${directusUserId} limit 1`;
    const email = typeof row?.email === "string" ? row.email.toLowerCase() : "";
    return email || directusUserId;
  } catch {
    return directusUserId;
  }
}

export interface ProjectFacts {
  readonly id: string;
  readonly name: string | null;
  readonly context: string | null;
  readonly workspaceId: string | null;
  readonly isCanvasEnabled: boolean;
}

/** A live project, as project_service.get_by_id_or_raise found it. */
export async function liveProject(sql: postgres.Sql, id: string): Promise<ProjectFacts | null> {
  if (!isUuid(id)) return null;
  const [row] = await sql`
    select id, name, context, workspace_id, is_canvas_enabled from project
    where id = ${id} and deleted_at is null`;
  if (!row) return null;
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    context: (row.context as string | null) ?? null,
    workspaceId: (row.workspace_id as string | null) ?? null,
    isCanvasEnabled: Boolean(row.is_canvas_enabled),
  };
}

/** The workspace's host-written context. Best effort: a read failure never blocks a chat. */
export async function workspaceContext(
  sql: postgres.Sql,
  workspaceId: string | null,
): Promise<string | null> {
  if (!workspaceId || !isUuid(workspaceId)) return null;
  try {
    const [row] = await sql`select context from workspace where id = ${workspaceId}`;
    return typeof row?.context === "string" && row.context.trim() ? row.context.trim() : null;
  } catch {
    return null;
  }
}

export async function currentGoal(sql: postgres.Sql, projectId: string): Promise<string | null> {
  const [row] = await sql`
    select content from project_goal_revision where project_id = ${projectId}
    order by created_at desc nulls last limit 1`;
  return typeof row?.content === "string" && row.content.trim() ? row.content.trim() : null;
}

/** The project's tier through its workspace's billing account; null for legacy projects. */
export async function projectTier(sql: postgres.Sql, projectId: string): Promise<string | null> {
  if (!isUuid(projectId)) return null;
  const [row] = await sql`
    select ba.tier from project p
    join workspace w on w.id = p.workspace_id
    join billing_account ba on ba.id = w.billing_account_id
    where p.id = ${projectId}`;
  return (row?.tier as string | null) ?? null;
}

/** A seeded sample copy (project.is_sample), which free-tier limits leave alone. */
export async function isSampleProject(sql: postgres.Sql, projectId: string): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const [row] = await sql`select is_sample from project where id = ${projectId}`;
  return row?.is_sample === true;
}

export const FREE_TIER_MAX_CHAT_USER_TURNS = 3;
// User turns across all of a sample copy's chats, the seeded opening question included.
export const FREE_TIER_MAX_SAMPLE_USER_TURNS = 10;

/** The shared 402 the frontend keys on (error FREE_TIER_LIMIT) to offer the upgrade. */
export function freeTierLimitError(limit: string): PaymentRequiredError {
  return new PaymentRequiredError("billing.tier_limit", {
    message: "FREE_TIER_LIMIT",
    params: { limit },
    details: { error: "FREE_TIER_LIMIT", limit, upgrade_cta_tier: "changemaker" },
  });
}

/** The global canvas flag and the project's beta toggle, as project_canvas_enabled. */
export async function canvasEnabled(
  sql: postgres.Sql,
  projectId: string,
  globalFlag: boolean,
): Promise<boolean> {
  if (!globalFlag) return false;
  try {
    const p = await liveProjectAnyState(sql, projectId);
    return Boolean(p?.is_canvas_enabled);
  } catch {
    return false;
  }
}

async function liveProjectAnyState(sql: postgres.Sql, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await sql`select is_canvas_enabled from project where id = ${id}`;
  return row ?? null;
}
