import type { Access } from "@echo/access";
import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@echo/core";
import type { Signed } from "@echo/http";
import { directusRow } from "@echo/legacy-shape";
import type { ProjectsStorage, Row } from "./storage";

export interface TemplateDeps {
  readonly store: ProjectsStorage;
  readonly access: Access;
  readonly now: () => Date;
}

/**
 * Workspace templates are read by anyone with project:read in the workspace and written
 * with project:create, so outsiders (external, observer) read but never edit. Spec L-9:
 * the Python read one direct membership row, which refused inherited org admins and
 * ignored expiry.
 */
async function workspaceRights(d: TemplateDeps, who: Signed, workspaceId: string) {
  if (!who.appUserId || !(await d.store.workspaceExists(workspaceId)))
    return { read: false, write: false };
  const read = await d.access.workspace(who, workspaceId, "project:read").then(
    () => true,
    () => false,
  );
  const write = await d.access.workspace(who, workspaceId, "project:create").then(
    () => true,
    () => false,
  );
  return { read, write };
}

type TemplateRow = NonNullable<Awaited<ReturnType<ProjectsStorage["template"]>>>;

/** The PromptTemplateOut shape: model fields only, with the defaults it declared. */
function out(
  t: TemplateRow,
  extra: { author: string | null; scope: string; canEdit: boolean; workspaceId?: string | null },
) {
  const row = directusRow(t);
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    icon: row.icon ?? null,
    sort: row.sort ?? null,
    is_public: Boolean(row.is_public),
    description: row.description ?? null,
    tags: parseTags(t.tags),
    language: row.language ?? null,
    author_display_name: extra.author,
    use_count: 0,
    star_count: 0,
    copied_from: null,
    date_created: row.date_created ?? null,
    date_updated: row.date_updated ?? null,
    scope: extra.scope,
    workspace_id: extra.workspaceId === undefined ? (row.workspace_id ?? null) : extra.workspaceId,
    can_edit: extra.canEdit,
  };
}

function parseTags(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

export async function listTemplates(d: TemplateDeps, who: Signed, workspaceId: string | null) {
  const personal = await d.store.personalTemplates(who.directusUserId);
  let shared: typeof personal = [];
  let canEditShared = false;
  if (workspaceId) {
    const rights = await workspaceRights(d, who, workspaceId);
    if (rights.read) {
      shared = await d.store.workspaceTemplates(workspaceId);
      canEditShared = rights.write;
    }
  }
  return [...personal, ...shared].map(({ t, firstName }) => {
    const scope = t.scope || "user";
    // A public template credits its author unless they chose to stay anonymous.
    const author = t.is_public ? (t.is_anonymous ? null : (firstName ?? null)) : null;
    return out(t, {
      author,
      scope,
      canEdit: scope === "workspace" ? canEditShared : t.user_created === who.directusUserId,
    });
  });
}

export async function createTemplate(
  d: TemplateDeps,
  who: Signed,
  body: {
    title: string;
    content: string;
    icon: string | null;
    scope: "user" | "workspace";
    workspace_id: string | null;
  },
) {
  if (body.scope === "workspace") {
    if (!body.workspace_id)
      throw new BadRequestError("workspace_id is required for scope='workspace'");
    const rights = await workspaceRights(d, who, body.workspace_id);
    if (!rights.read) throw new ForbiddenError("Not a workspace member");
    if (!rights.write)
      throw new ForbiddenError("Read-only collaborators cannot create workspace templates");
  }
  const now = d.now().toISOString();
  const created = await d.store.insertTemplate({
    id: newId(),
    title: body.title,
    content: body.content,
    icon: body.icon,
    scope: body.scope,
    ...(body.scope === "workspace" && { workspace_id: body.workspace_id }),
    user_created: who.directusUserId,
    date_created: now,
    // Directus stamped the creator in a second write, which also set date_updated.
    date_updated: now,
  });
  // The response is the row before that second write: no date_updated yet.
  return out(
    { ...created, date_updated: null },
    { author: null, scope: body.scope, canEdit: true, workspaceId: body.workspace_id },
  );
}

/** Loads a template the caller may change: their own, or a workspace one they can write. */
async function editable(d: TemplateDeps, who: Signed, id: string, verb: "edit" | "delete") {
  const t = await d.store.template(id);
  if (!t) throw new NotFoundError("Template not found");
  const scope = t.scope || "user";
  if (scope === "workspace") {
    if (!t.workspace_id) throw new NotFoundError("Template not found");
    if (!who.appUserId) throw new ForbiddenError("Not a workspace member");
    const rights = await workspaceRights(d, who, t.workspace_id);
    if (!rights.write) throw new ForbiddenError(`Not allowed to ${verb} this template`);
  } else if (t.user_created !== who.directusUserId) throw new NotFoundError("Template not found");
  return { t, scope };
}

export async function updateTemplate(
  d: TemplateDeps,
  who: Signed,
  id: string,
  body: { title: string | null; content: string | null; icon: string | null },
) {
  const { scope } = await editable(d, who, id, "edit");
  const values = {
    ...(body.title !== null && { title: body.title }),
    ...(body.content !== null && { content: body.content }),
    ...(body.icon !== null && { icon: body.icon }),
  };
  if (!Object.keys(values).length) throw new BadRequestError("No fields to update");
  const updated = await d.store.updateTemplate(id, {
    ...values,
    date_updated: d.now().toISOString(),
  });
  if (!updated) throw new NotFoundError("Template not found");
  return out(updated, { author: null, scope, canEdit: true });
}

export async function deleteTemplate(d: TemplateDeps, who: Signed, id: string) {
  await editable(d, who, id, "delete");
  await d.store.deleteTemplate(id);
  return { status: "ok" };
}

export async function getQuickAccess(d: TemplateDeps, who: Signed) {
  const prefs = (await d.store.userPreferences(who.directusUserId))?.quick;
  return Array.isArray(prefs) ? prefs : [];
}

/**
 * Up to five shortcuts, no duplicates; a user template must be one the caller can see
 * (their own, or shared with a workspace they read).
 */
export async function saveQuickAccess(
  d: TemplateDeps,
  who: Signed,
  items: { type: "static" | "user"; id: string }[],
) {
  if (items.length > 5) throw new BadRequestError("Maximum 5 quick access items");
  const seen = new Set<string>();
  for (const i of items) {
    const key = `${i.type}:${i.id}`;
    if (seen.has(key)) throw new BadRequestError(`Duplicate item: ${key}`);
    seen.add(key);
  }
  for (const i of items) {
    if (i.type !== "user") continue;
    const missing = new BadRequestError(`Template not found: ${i.id}`);
    const t = await d.store.template(i.id);
    if (!t) throw missing;
    if ((t.scope || "user") === "workspace") {
      if (!t.workspace_id || !(await workspaceRights(d, who, t.workspace_id)).read) throw missing;
    } else if (t.user_created !== who.directusUserId) throw missing;
  }
  const prefs: Row[] = items.map((i) => ({ type: i.type, id: i.id }));
  await d.store.updateUserPreferences(who.directusUserId, { quick_access_preferences: prefs });
  return prefs;
}

export async function setHideAiSuggestions(d: TemplateDeps, who: Signed, hide: boolean) {
  await d.store.updateUserPreferences(who.directusUserId, { hide_ai_suggestions: hide });
  return { status: "ok", hide_ai_suggestions: hide };
}
