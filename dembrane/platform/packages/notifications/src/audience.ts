import { isWorkspaceRole, roleHas } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { notificationStorage } from "./storage";

/**
 * Who hears about an event. Workspace audiences use effective membership: direct rows
 * (never staff support) plus access derived from the org, with the same rules as the
 * access resolver (owners everywhere, admins on open workspaces, members only through the
 * legacy inherit flag, sticky removals respected).
 */
export function audiences(db: Db) {
  const store = notificationStorage(db);

  async function effectiveMembers(workspaceId: string) {
    const ws = await store.workspaceForMembers(workspaceId);
    if (!ws || ws.deletedAt) return [];
    const out = new Map<string, string>();
    for (const r of await store.directMembers(workspaceId)) out.set(r.userId, r.role);
    if (!ws.orgId) return [...out].map(([userId, role]) => ({ userId, role }));
    const settings = (ws.settings ?? {}) as {
      sticky_removed?: unknown;
      inherit_organisation_members?: unknown;
    };
    const open = ws.visibility === "open_to_organisation";
    const roles = open
      ? ["owner", "admin", ...(settings.inherit_organisation_members === true ? ["member"] : [])]
      : ["owner"];
    const sticky = new Set(
      Array.isArray(settings.sticky_removed)
        ? settings.sticky_removed.map((t) =>
            t && typeof t === "object" ? String((t as { user_id?: unknown }).user_id) : String(t),
          )
        : [],
    );
    for (const r of await store.orgMembers(ws.orgId, roles))
      if (!out.has(r.userId) && !sticky.has(r.userId))
        out.set(r.userId, r.role === "member" ? "member" : "admin");
    return [...out].map(([userId, role]) => ({ userId, role }));
  }

  return {
    effectiveMembers,
    async workspaceAdmins(workspaceId: string) {
      return (await effectiveMembers(workspaceId))
        .filter((m) => m.role === "admin" || m.role === "owner")
        .map((m) => m.userId);
    },
    /**
     * Everyone who can open a project, with the workspace it sits in: the workspace's people
     * whose role reads projects, or for a private project its admins and owners plus the
     * people it is shared with.
     */
    async projectPeople(
      projectId: string,
    ): Promise<{ workspaceId: string | null; userIds: string[] }> {
      const p = await store.projectForAudience(projectId);
      if (!p || p.deletedAt || !p.workspaceId) return { workspaceId: null, userIds: [] };
      const members = await effectiveMembers(p.workspaceId);
      const isPrivate = p.visibility === "private";
      const out = new Set(
        members
          .filter((m) =>
            isPrivate
              ? m.role === "admin" || m.role === "owner"
              : isWorkspaceRole(m.role) && roleHas(m.role, "project:read"),
          )
          .map((m) => m.userId),
      );
      if (isPrivate) for (const s of await store.projectShares(projectId)) out.add(s.userId);
      return { workspaceId: p.workspaceId, userIds: [...out] };
    },
    async organisationAdmins(orgId: string) {
      return (await store.orgMembers(orgId, ["admin", "owner"])).map((r) => r.userId);
    },
    staff: () => store.staffIds(),
  };
}

export type Audiences = ReturnType<typeof audiences>;
