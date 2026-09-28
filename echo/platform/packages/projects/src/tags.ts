import { BadRequestError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { directusRow } from "@dembrane/legacy-shape";
import { projectFor } from "./access";
import type { ProjectDeps } from "./projects";

// ── BFF /api/v2/bff/tags ────────────────────────────────────────────────

export async function listTags(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:read");
  return d.store.tags(projectId);
}

export async function createTag(
  d: ProjectDeps,
  who: Signed,
  body: { project_id: string; text: string; sort: number | null },
) {
  await projectFor(d.access, who, body.project_id, "project:update");
  const id = newId();
  await d.store.insertTags([
    {
      id,
      project_id: body.project_id,
      text: body.text,
      ...(body.sort !== null && { sort: body.sort }),
      created_at: d.now().toISOString(),
    },
  ]);
  const tag = await d.store.tag(id);
  return tag ? { ...directusRow(tag), conversations: [] } : {};
}

/** A tag and the access its project grants; a tag is never reachable past its project. */
async function tagFor(d: ProjectDeps, who: Signed, tagId: string) {
  const tag = await d.store.tag(tagId);
  if (!tag) throw new NotFoundError("Tag not found");
  await projectFor(d.access, who, tag.project_id, "project:update");
  return tag;
}

export async function updateTag(
  d: ProjectDeps,
  who: Signed,
  tagId: string,
  body: { text: string | null; sort: number | null },
) {
  await tagFor(d, who, tagId);
  const payload = {
    ...(body.text !== null && { text: body.text }),
    ...(body.sort !== null && { sort: body.sort }),
  };
  if (!Object.keys(payload).length) throw new BadRequestError("No fields to update");
  await d.store.updateTag(tagId, { ...payload, updated_at: d.now().toISOString() });
  const tag = await d.store.tag(tagId);
  return tag ? { ...directusRow(tag), conversations: await tagLinks(d, tagId) } : {};
}

async function tagLinks(d: ProjectDeps, tagId: string) {
  return d.store.tagLinkIds(tagId);
}

// ── v1 /api/projects/{id}/tags ─────────────────────────────────────────

/** Deletes a tag of this project (spec H-3: any tag of any tenant, by id, for any role). */
export async function deleteProjectTag(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  tagId: string,
) {
  await projectFor(d.access, who, projectId, "project:update", "v1");
  const tag = await d.store.tag(tagId);
  if (!tag || tag.project_id !== projectId) throw new NotFoundError("Tag not found");
  await d.store.transaction(async ({ store }) => {
    await store.deleteTagLinks(tagId);
    await store.deleteTag(tagId);
  });
  return { status: "success" };
}
