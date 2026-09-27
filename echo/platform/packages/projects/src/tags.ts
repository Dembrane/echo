import { BadRequestError, NotFoundError, newId } from "@echo/core";
import type { Signed } from "@echo/http";
import { directusRow } from "@echo/legacy-shape";
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
  return (await d.store.tagLinkIds(tagId)).map(String);
}

/** Hard delete with its conversation links; tags carry no billing weight. */
export async function deleteTag(d: ProjectDeps, who: Signed, tagId: string) {
  await tagFor(d, who, tagId);
  await d.store.transaction(async ({ store }) => {
    await store.deleteTagLinks(tagId);
    await store.deleteTag(tagId);
  });
  return { status: "deleted" };
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

/**
 * Removes tag links from one conversation of this project (spec C-4: any link platform
 * wide, by integer id, for any role). Links elsewhere are left alone and not counted.
 */
export async function deleteConversationTags(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  conversationId: string,
  linkIds: number[],
) {
  await projectFor(d.access, who, projectId, "project:update", "v1");
  if (!(await d.store.conversationInProject(conversationId, projectId)))
    throw new NotFoundError("Conversation not found");
  const deleted = await d.store.deleteConversationTagLinks(projectId, conversationId, linkIds);
  return { status: "success", deleted };
}

// ── BFF /api/v2/bff/analysis-runs ───────────────────────────────────────

export async function listAnalysisRuns(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  limit: number,
) {
  await projectFor(d.access, who, projectId, "project:read");
  return d.store.analysisRuns(projectId, limit);
}

/** A run is reached through its project; reading it needs project:read (spec L-4). */
async function runFor(d: ProjectDeps, who: Signed, runId: string) {
  const run = await d.store.analysisRun(runId);
  if (!run?.project_id) throw new NotFoundError("Analysis run not found");
  await projectFor(d.access, who, run.project_id, "project:read");
  return run;
}

export async function getAnalysisRun(d: ProjectDeps, who: Signed, runId: string) {
  const run = await runFor(d, who, runId);
  return { ...directusRow(run), processing_status: await d.store.runStatusIds(runId) };
}

/** Chunks recorded in the run's project since the run: the "new since last library" banner. */
export async function newChunksSince(d: ProjectDeps, who: Signed, runId: string) {
  const run = await runFor(d, who, runId);
  if (!run.project_id || !run.created_at) return { count: 0 };
  return { count: await d.store.chunksSince(run.project_id, run.created_at) };
}
