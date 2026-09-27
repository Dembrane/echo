import type { Access, Policy, WorkspaceAccess } from "@echo/access";
import { ForbiddenError, NotFoundError, PlatformError } from "@echo/core";
import type { Db } from "@echo/db";
import type { Signed } from "@echo/http";
import { directusRow } from "@echo/legacy-shape";
import type postgres from "postgres";

export type Row = Record<string, unknown>;

/** What the assistant's data operations need; built once per route app or agent turn. */
export interface DataDeps {
  readonly db: Db;
  readonly access: Access;
  readonly now: () => Date;
}

export const sqlOf = (d: DataDeps): postgres.Sql =>
  (d.db as unknown as { $client: postgres.Sql }).$client;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id names nothing; Directus answered such lookups as not found. */
export const isUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);

/** Python's _to_non_empty_string: stripped text, or null for empty and structured values. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  const s = String(value).trim();
  return s || null;
}

export const row = (r: Row): Row => directusRow(r);

/** The project row, or null when missing; deleted projects are returned (callers decide). */
export async function projectRow(d: DataDeps, projectId: string): Promise<Row | null> {
  if (!isUuid(projectId)) return null;
  const [r] = await sqlOf(d)`select * from project where id = ${projectId}`;
  return r ? row(r as Row) : null;
}

/** The workspace a project belongs to, derived server-side, never taken from the caller. */
export async function projectWorkspaceId(d: DataDeps, projectId: string): Promise<string | null> {
  const p = await projectRow(d, projectId);
  return p ? text(p.workspace_id) : null;
}

/**
 * The v2 workspace middleware in its own words: 403 before onboarding, 404 for a gone
 * workspace, 403 "No access to this workspace" without a role, 403 "Access denied"
 * without the policy.
 */
export async function workspaceGate(
  d: DataDeps,
  who: Signed,
  workspaceId: string,
  policy: Policy,
): Promise<WorkspaceAccess> {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  if (!isUuid(workspaceId)) throw new NotFoundError("Workspace not found");
  const [ws] = await sqlOf(d)`
    select id from workspace where id = ${workspaceId} and deleted_at is null`;
  if (!ws) throw new NotFoundError("Workspace not found");
  try {
    return await d.access.workspace(who, workspaceId, policy);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ForbiddenError("No access to this workspace");
    if (err instanceof ForbiddenError) throw new ForbiddenError("Access denied");
    throw err;
  }
}

/** A 500 that carries its detail to the client, as the Python API raised these. */
export class ServerError extends PlatformError {
  readonly status = 500;
  readonly code = "internal";
}
