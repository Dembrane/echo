import { ROLE_RANK } from "@dembrane/access";
import { BadRequestError } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type { InviteStorage } from "./storage";

/**
 * Outsider roles hold no org membership in the workspace's org (ADR-0003, observer since
 * Wave G). Every send and accept path classifies them the same way, or accepting an
 * observer invite would make someone a full org member.
 */
export function isOutsider(role: string | null | undefined): boolean {
  return role === "external" || role === "observer";
}

/** The old ROLE_HIERARCHY lookups: unknown roles rank 0, or `fallback` where the caller said so. */
export function rank(role: string | null | undefined, fallback = 0): number {
  return role && role in ROLE_RANK ? ROLE_RANK[role as keyof typeof ROLE_RANK] : fallback;
}

export type EnsureStatus = "created" | "reactivated" | "already_active" | "upgraded";

/** First active row wins, else the first soft-deleted one is revived, else a new row. */
export async function ensureActiveOrgMembership(
  store: InviteStorage,
  orgId: string,
  userId: string,
  role: string,
  now: Date,
): Promise<EnsureStatus> {
  const rows = await store.orgMemberships(orgId, userId, { activeOnly: false });
  const active = rows.find((r) => r.deleted_at === null);
  if (active) return "already_active";
  const deleted = rows.find((r) => r.deleted_at !== null);
  if (deleted) {
    return (await store.updateMembership("org", deleted.id, { deleted_at: null, role }, now))
      ? "reactivated"
      : "already_active";
  }
  return (await store.createMembership("org", { orgId, userId, role }, now))
    ? "created"
    : "already_active";
}

/**
 * Keeps insider XOR outsider when someone is about to become an outsider in an org. Call
 * before writing the outsider workspace row, so the roles read are their other rows.
 */
export async function reconcileOutsider(
  store: InviteStorage,
  orgId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const roles = await store.workspaceRolesInOrg(orgId, userId);
  if (roles.some((r) => ["member", "billing", "admin", "owner"].includes(r))) {
    throw new BadRequestError(
      "This person is already a member of the organisation and cannot also be added as an outside collaborator. Remove them from the organisation first.",
    );
  }
  const rows = await store.orgMemberships(orgId, userId, { activeOnly: true });
  // A privileged org member is never demoted silently; only a stale plain member row goes.
  if (rows.some((r) => ["admin", "owner", "billing"].includes(r.role))) {
    throw new BadRequestError(
      "This person is an organisation admin, owner, or billing member and cannot be added as an outside collaborator. Change their organisation role first.",
    );
  }
  for (const r of rows)
    await store.updateMembership("org", r.id, { deleted_at: now.toISOString() }, now);
}

/**
 * The project share an invite carries (sharing modal), granted once the workspace row
 * exists. Best effort: a moved or deleted project only logs.
 */
export async function grantInviteProjectShare(
  store: InviteStorage,
  invite: {
    id: string;
    project_id: string | null;
    workspace_id: string;
    invited_by: string | null;
  },
  userId: string,
  now: Date,
  logger?: Logger,
): Promise<boolean> {
  if (!invite.project_id) return false;
  try {
    const project = await store.project(invite.project_id);
    if (!project || project.deletedAt || project.workspaceId !== invite.workspace_id) return false;
    await store.upsertProjectShare(invite.project_id, userId, invite.invited_by, now);
    return true;
  } catch (err) {
    logger?.error({ err, inviteId: invite.id }, "project share from invite failed");
    return false;
  }
}
