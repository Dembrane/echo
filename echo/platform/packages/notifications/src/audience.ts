import type { Db } from "@echo/db";
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
    async organisationAdmins(orgId: string) {
      return (await store.orgMembers(orgId, ["admin", "owner"])).map((r) => r.userId);
    },
    staff: () => store.staffIds(),
  };
}

export type Audiences = ReturnType<typeof audiences>;
