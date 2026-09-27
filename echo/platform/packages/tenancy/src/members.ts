import { deriveWorkspaceRole, stickyRemovedIds } from "@echo/access";
import type { Conn } from "./db";
import {
  orgMembers,
  type WorkspaceRowFull,
  workspaceById,
  workspaceMembers,
} from "./storage/tenancy";

/** One person who can reach a workspace: a stored direct row, or access derived from the org. */
export interface EffectiveMember {
  readonly user_id: string;
  readonly role: string;
  readonly source: "direct" | "inherited";
  readonly created_at: string | null;
}

type Visibility = "open_to_organisation" | "invite_only" | "private";

/** The workspace fields derivation reads, in the shape @echo/access decides on. */
export function derivationView(ws: Pick<WorkspaceRowFull, "visibility" | "settings">) {
  const settings = (ws.settings ?? {}) as {
    inherit_organisation_members?: unknown;
    sticky_removed?: unknown;
  };
  return {
    visibility: (ws.visibility ?? "open_to_organisation") as Visibility,
    inheritOrgMembers: settings.inherit_organisation_members === true,
    stickyRemoved: stickyRemovedIds(settings.sticky_removed),
  };
}

/** True when the org's admins reach this workspace without joining it. */
export function followsOrgAdmins(ws: Pick<WorkspaceRowFull, "visibility">): boolean {
  return ws.visibility === "open_to_organisation";
}

/**
 * Everyone who can reach a workspace, direct rows first (primary key order), then the org
 * members whose role derives access. Staff support rows grant access but are never listed:
 * they must not show as members or count as seats.
 */
export async function effectiveMembers(db: Conn, workspaceId: string): Promise<EffectiveMember[]> {
  const ws = await workspaceById(db, workspaceId);
  if (!ws || ws.deleted_at) return [];
  const direct = await workspaceMembers(db, workspaceId);
  const out: EffectiveMember[] = [];
  const seen = new Set<string>();
  for (const row of direct) {
    seen.add(row.user_id);
    out.push({
      user_id: row.user_id,
      role: row.role,
      source: "direct",
      created_at: row.created_at,
    });
  }
  const view = derivationView(ws);
  const inScope = followsOrgAdmins(ws)
    ? view.inheritOrgMembers
      ? ["owner", "admin", "member"]
      : ["owner", "admin"]
    : ["owner"];
  for (const row of await orgMembers(db, ws.org_id, inScope)) {
    if (seen.has(row.user_id)) continue;
    const derived = deriveWorkspaceRole(view, row.role, row.user_id);
    if (!derived) continue;
    out.push({ user_id: row.user_id, role: derived, source: "inherited", created_at: null });
  }
  return out;
}

const SEAT_ROLES = new Set(["owner", "admin", "member", "billing", "external"]);

/**
 * [seats, members, externals, observers]. Only direct rows hold a seat; externals share the
 * paid pool, observers are free and outside it.
 */
export function seatState(members: readonly EffectiveMember[]): [number, number, number, number] {
  const m = new Set<string>();
  const e = new Set<string>();
  const o = new Set<string>();
  for (const row of members) {
    if (row.source !== "direct") continue;
    if (row.role === "observer") o.add(row.user_id);
    else if (row.role === "external") e.add(row.user_id);
    else if (SEAT_ROLES.has(row.role)) m.add(row.user_id);
  }
  return [m.size + e.size, m.size, e.size, o.size];
}

export async function workspaceAdmins(db: Conn, workspaceId: string, roles = ["admin", "owner"]) {
  return (await effectiveMembers(db, workspaceId))
    .filter((m) => roles.includes(m.role))
    .map((m) => m.user_id);
}
