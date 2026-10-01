import { newId } from "@dembrane/core";
import { isoTimestamp } from "@dembrane/legacy-shape";
import type { WorkspaceContext } from "../context";
import { iso } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { effectiveMembers } from "../members";
import { pyRound } from "../numbers";
import { appUsersByIds, avatars } from "../storage/people";
import { insertProject, projectListPage, sharedProjectIds, sharePairs } from "../storage/projects";
import { hoursByProject } from "../storage/usage";

export function projectService(deps: TenancyDeps) {
  const { db } = deps;

  /** Avatar bubbles and access counts: everyone for workspace projects, admins plus shares for private ones. */
  async function previews(workspaceId: string, rows: { id: string; visibility: string }[]) {
    const members = (await effectiveMembers(db, workspaceId)).sort(
      (a, b) =>
        (a.source === "direct" ? 0 : 1) - (b.source === "direct" ? 0 : 1) ||
        (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0),
    );
    const everyone = members.map((m) => m.user_id);
    const admins = members.filter((m) => ["admin", "owner"].includes(m.role)).map((m) => m.user_id);
    const privateIds = rows.filter((r) => r.visibility === "private").map((r) => r.id);
    const shares = new Map<string, string[]>();
    if (privateIds.length) {
      const shareRows = await sharePairs(db, privateIds);
      for (const r of shareRows)
        shares.set(r.project_id, [...(shares.get(r.project_id) ?? []), r.user_id]);
    }
    const privateAccess = (pid: string) => [...new Set([...admins, ...(shares.get(pid) ?? [])])];
    const bubbles = new Set(everyone.slice(0, 3));
    for (const pid of privateIds) for (const u of privateAccess(pid).slice(0, 3)) bubbles.add(u);
    const users = await appUsersByIds(db, [...bubbles]);
    const av = await avatars(
      db,
      users.map((u) => u.directus_user_id),
    );
    const enriched = new Map(
      users.map((u) => [
        u.id,
        { display_name: u.display_name ?? "", avatar: av.get(u.directus_user_id ?? "") || null },
      ]),
    );
    const pick = (ids: string[]) =>
      ids.flatMap((id) => (enriched.has(id) ? [enriched.get(id)] : []));
    const out = new Map<string, [unknown[], number]>();
    for (const r of rows) {
      if (r.visibility === "private") {
        const ids = privateAccess(r.id);
        out.set(r.id, [pick(ids.slice(0, 3)), ids.length]);
      } else out.set(r.id, [pick(everyone.slice(0, 3)), everyone.length]);
    }
    return out;
  }

  return {
    /** A workspace's projects, pinned first, paginated, with previews and hours. */
    async list(ctx: WorkspaceContext, q: { search: string | null; offset: number; limit: number }) {
      ctx.require("project:read");
      // Admins and owners see private projects anyway, as @dembrane/access resolves project
      // access; everyone else only those shared with them. The legacy creator clause is gone:
      // inside a workspace, creating a project grants nothing by itself (spec L-12).
      const privateVisible =
        ctx.role === "admin" || ctx.role === "owner"
          ? null
          : await sharedProjectIds(db, ctx.who.appUserId);
      const { page, pinned, total } = await projectListPage(db, {
        workspaceId: ctx.workspaceId,
        privateVisible,
        search: q.search?.trim() || null,
        countTotal: !q.search,
        offset: q.offset,
        limit: q.limit,
      });
      const hasMore = page.length > q.limit;
      const rows = page.slice(0, q.limit);
      const totalCount = total ?? q.offset + rows.length + (hasMore ? 1 : 0);
      const seen = new Set(rows.map((r) => r.id));
      const union = [...rows, ...pinned.filter((p) => !seen.has(p.id))];
      const views = union.map((r) => ({ id: r.id, visibility: r.visibility || "workspace" }));
      const [preview, hours] = await Promise.all([
        previews(ctx.workspaceId, views),
        hoursByProject(
          db,
          union.map((r) => r.id),
        ),
      ]);
      const shape = (p: (typeof page)[number]) => {
        const [bubbles, count] = preview.get(p.id) ?? [[], 0];
        return {
          id: p.id,
          name: p.name,
          updated_at: isoTimestamp(p.updated_at),
          language: p.language,
          pin_order: p.pin_order,
          conversations_count: p.conversations_count ?? 0,
          audio_hours: pyRound((hours.get(p.id) ?? 0) / 3600, 1),
          visibility: p.visibility || "workspace",
          access_preview: bubbles,
          access_count: count,
        };
      };
      return {
        pinned: pinned.map(shape),
        projects: rows.map(shape),
        total_count: totalCount,
        has_more: hasMore,
        is_admin: ctx.allows("settings:manage"),
      };
    },

    /** Creates a project in the workspace; the caller is recorded as its Directus-era creator. */
    async create(ctx: WorkspaceContext, body: { name: string; language: string }) {
      ctx.require("project:create");
      const now = clock(deps);
      const id = newId();
      await insertProject(db, {
        id,
        name: body.name,
        language: body.language,
        workspace_id: ctx.workspaceId,
        directus_user_id: ctx.who.directusUserId,
        is_conversation_allowed: true,
        created_at: iso(now),
        updated_at: iso(now),
      });
      return { id, name: body.name, workspace_id: ctx.workspaceId };
    },
  };
}
