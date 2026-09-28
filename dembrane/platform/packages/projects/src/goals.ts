import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor, workspaceFor } from "@dembrane/http";
import type { ProjectDeps } from "./projects";
import type { Row } from "./storage";

const pick = (row: Row, fields: readonly string[]) =>
  Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));

// ── goals ───────────────────────────────────────────────────────────────

export async function getGoal(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:read");
  const revisions = await d.store.goalRevisions(projectId);
  return { current: revisions[0] ?? null, revisions };
}

/**
 * A new goal revision. A chat named as its source must be a live chat of this project
 * (spec L-6: any id was stored as provenance).
 */
export async function setGoal(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  body: { content: string; chat_id: string | null; set_by: string },
) {
  await projectFor(d.access, who, projectId, "project:update");
  const content = body.content.trim();
  if (!content) throw new BadRequestError("content is required");
  if (body.chat_id !== null && !(await d.store.chatInProject(body.chat_id, projectId)))
    throw new NotFoundError("Chat not found");
  const row = await d.store.insertGoalRevision({
    id: newId(),
    project_id: projectId,
    content,
    set_by: body.set_by,
    chat_id: body.chat_id,
    created_by: who.directusUserId,
    created_at: d.now().toISOString(),
  });
  return pick(row, ["id", "content", "set_by", "created_at"]);
}

// ── methodologies ───────────────────────────────────────────────────────

const VERSION_FIELDS = ["id", "note", "created_at"] as const;
const VERSION_DETAIL_FIELDS = ["id", "note", "created_by", "created_at", "content"] as const;

function card(row: Row, versions: Row[]) {
  return {
    id: row.id ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    framing: row.framing ?? null,
    is_seeded: Boolean(row.is_seeded),
    latest_version: versions[0] ? pick(versions[0], VERSION_FIELDS) : null,
    versions_count: versions.length,
  };
}

function trimRequired(v: string, field: string) {
  const t = v.trim();
  if (!t) throw new BadRequestError(`${field} is required`);
  return t;
}

function trimOptional(v: string | null, field: string) {
  if (v === null) return null;
  const t = v.trim();
  if (!t) throw new BadRequestError(`${field} cannot be empty`);
  return t;
}

const wsExists = (d: ProjectDeps) => (id: string) => d.store.workspaceExists(id);

/** Methodologies a workspace can pick: public ones, the workspace's own, and the caller's. */
export async function listMethodologies(d: ProjectDeps, who: Signed, workspaceId: string) {
  await workspaceFor(d.access, who, workspaceId, "project:read", wsExists(d));
  const rows = await d.store.visibleMethodologies(workspaceId, who.directusUserId);
  const out = [];
  for (const r of rows) out.push(card(r, await d.store.methodologyVersions(r.id)));
  return out;
}

export async function createMethodology(
  d: ProjectDeps,
  who: Signed,
  body: {
    workspace_id: string;
    name: string;
    description: string;
    framing: string;
    content: unknown;
  },
) {
  const workspaceId = body.workspace_id.trim();
  await workspaceFor(d.access, who, workspaceId, "project:create", wsExists(d), "Not allowed");
  const id = newId();
  const now = d.now().toISOString();
  return d.store.transaction(async ({ store }) => {
    const row = await store.insertMethodology({
      id,
      workspace_id: workspaceId,
      owner_directus_user_id: who.directusUserId,
      visibility: "workspace",
      is_seeded: false,
      name: trimRequired(body.name, "name"),
      description: trimRequired(body.description, "description"),
      framing: trimRequired(body.framing, "framing"),
      created_at: now,
    });
    // methodology_version.content is NOT NULL: an omitted content is an empty object.
    const version = await store.insertMethodologyVersion({
      id: newId(),
      methodology_id: id,
      content: body.content ?? {},
      note: "Initial history",
      created_by: who.directusUserId,
      created_at: now,
    });
    return card(row ?? {}, version ? [version] : []);
  });
}

/**
 * Who may read a methodology: anyone for public ones, its owner, and members of its
 * workspace when it is shared with the workspace (spec L-7: private ones leaked to members).
 */
async function requireVisible(d: ProjectDeps, who: Signed, row: Row) {
  if (row.visibility === "public" || row.owner_directus_user_id === who.directusUserId) return;
  if (row.visibility === "workspace" && typeof row.workspace_id === "string") {
    await workspaceFor(d.access, who, row.workspace_id, "project:read", wsExists(d));
    return;
  }
  throw new NotFoundError("Methodology not found");
}

async function methodologyOr404(d: ProjectDeps, id: string) {
  const row = await d.store.methodology(id);
  if (!row) throw new NotFoundError("Methodology not found");
  return row;
}

export async function getMethodology(d: ProjectDeps, who: Signed, id: string) {
  const row = await methodologyOr404(d, id);
  await requireVisible(d, who, row);
  const versions = await d.store.methodologyVersions(row.id);
  return {
    ...card(row, versions),
    versions: versions.map((v) => pick(v, VERSION_DETAIL_FIELDS)),
  };
}

/** Edits the card and, when content is sent, records a new version. The seeded one is read-only. */
export async function editMethodology(
  d: ProjectDeps,
  who: Signed,
  id: string,
  body: {
    name: string | null;
    description: string | null;
    framing: string | null;
    content: unknown;
    note: string | null;
  },
  fieldsSet: ReadonlySet<string>,
) {
  let row: Row = await methodologyOr404(d, id);
  if (row.is_seeded) throw new ForbiddenError("The dembrane methodology is read-only");
  if (row.owner_directus_user_id !== who.directusUserId) {
    if (!(row.visibility === "workspace" && typeof row.workspace_id === "string"))
      throw new ForbiddenError("Not allowed");
    await workspaceFor(
      d.access,
      who,
      row.workspace_id,
      "settings:manage",
      wsExists(d),
      "Not allowed",
    );
  }
  const updates: Record<string, string> = {};
  for (const f of ["name", "description", "framing"] as const) {
    if (!fieldsSet.has(f)) continue;
    const v = trimOptional(body[f], f);
    if (v !== null) updates[f] = v;
  }
  const now = d.now().toISOString();
  return d.store.transaction(async ({ store }) => {
    if (Object.keys(updates).length) {
      const updated = await store.updateMethodology(id, { ...updates, updated_at: now });
      row = { ...row, ...(updated ?? updates) };
    }
    let versions = await store.methodologyVersions(id);
    if (fieldsSet.has("content")) {
      const version = await store.insertMethodologyVersion({
        id: newId(),
        methodology_id: id,
        content: body.content ?? {},
        note: fieldsSet.has("note") ? trimOptional(body.note, "note") : null,
        created_by: who.directusUserId,
        created_at: now,
      });
      if (version) versions = [version, ...versions];
    }
    return card(row, versions);
  });
}
