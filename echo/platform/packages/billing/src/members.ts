/**
 * Who counts as a member of a workspace for seats, billing and notifications (Python
 * inheritance.get_effective_members). Direct rows win; org owners always derive admin,
 * org admins derive admin on open workspaces, org members only through the legacy
 * inherit flag. Staff support rows never count.
 */
export interface WorkspaceForMembers {
  readonly org_id: string | null;
  readonly visibility: string | null;
  readonly settings: unknown;
}

export interface DirectRow {
  readonly user_id: string | null;
  readonly role: string | null;
  readonly source: string | null;
  readonly created_at?: string | null;
  readonly custom_policies?: unknown;
}

export interface OrgRow {
  readonly user_id: string | null;
  readonly role: string | null;
}

export interface EffectiveMember {
  readonly user_id: string;
  readonly role: string;
  readonly source: "direct" | "inherited";
}

function settingsOf(ws: WorkspaceForMembers): Record<string, unknown> {
  const s = ws.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

export function followsOrgAdmins(ws: WorkspaceForMembers): boolean {
  return ws.visibility === "open_to_organisation";
}

export function followsOrgMembers(ws: WorkspaceForMembers): boolean {
  return Boolean(settingsOf(ws).inherit_organisation_members);
}

export function isStickyRemoved(ws: WorkspaceForMembers, userId: string): boolean {
  const t = settingsOf(ws).sticky_removed;
  return Array.isArray(t) && t.some((x) => x && typeof x === "object" && x.user_id === userId);
}

/** The org roles whose holders derive access to this workspace. */
export function derivingOrgRoles(ws: WorkspaceForMembers): string[] {
  if (!followsOrgAdmins(ws)) return ["owner"];
  return followsOrgMembers(ws) ? ["owner", "admin", "member"] : ["owner", "admin"];
}

export function effectiveMembersFromRows(
  ws: WorkspaceForMembers,
  direct: readonly DirectRow[],
  org: readonly OrgRow[],
): EffectiveMember[] {
  const out: EffectiveMember[] = [];
  const directIds = new Set<string>();
  for (const r of direct) {
    if (!r.user_id || r.source === "staff_support") continue;
    directIds.add(r.user_id);
    out.push({ user_id: r.user_id, role: r.role ?? "", source: "direct" });
  }
  if (!ws.org_id) return out;
  const inScope = new Set(derivingOrgRoles(ws));
  for (const r of org) {
    if (!r.user_id || directIds.has(r.user_id) || !r.role || !inScope.has(r.role)) continue;
    if (isStickyRemoved(ws, r.user_id)) continue;
    out.push({
      user_id: r.user_id,
      role: r.role === "owner" || r.role === "admin" ? "admin" : "member",
      source: "inherited",
    });
  }
  return out;
}

/** Every billable role takes a seat; observers are free and never do. */
export const SEAT_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "member",
  "billing",
  "external",
]);

/** Distinct direct users holding a seat. Derived org access never takes a seat. */
export function seatUserIds(members: readonly EffectiveMember[]): Set<string> {
  const ids = new Set<string>();
  for (const m of members)
    if (m.source === "direct" && m.user_id && SEAT_ROLES.has(m.role)) ids.add(m.user_id);
  return ids;
}

/** [seats used, members, externals, observers] from direct rows (Python seat_state_from_members). */
export function seatState(members: readonly EffectiveMember[]): [number, number, number, number] {
  const member = new Set<string>();
  const external = new Set<string>();
  const observer = new Set<string>();
  for (const m of members) {
    if (m.source !== "direct" || !m.user_id) continue;
    if (m.role === "observer") observer.add(m.user_id);
    else if (m.role === "external") external.add(m.user_id);
    else if (SEAT_ROLES.has(m.role)) member.add(m.user_id);
  }
  return [member.size + external.size, member.size, external.size, observer.size];
}
