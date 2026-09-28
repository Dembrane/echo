import type { Access } from "@echo/access";
import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@echo/core";
import type { Signed } from "@echo/http";
import { directusRow, pythonIso } from "@echo/legacy-shape";
import { projectAllows, projectFor, projectSource } from "./access";
import { createLibrary, createView, type JobSink } from "./jobs";
import { isExternalClient, legalBlock, legalWrite } from "./legal";
import type { ProjectsStorage, Row } from "./storage";
import { zip } from "./zip";

export interface ProjectDeps {
  readonly store: ProjectsStorage;
  readonly access: Access;
  readonly jobs: JobSink;
  readonly now: () => Date;
}

const notFound = () => new NotFoundError("Project not found");

async function liveProject(store: ProjectsStorage, id: string) {
  const p = await store.project(id);
  if (!p || p.deleted_at) throw notFound();
  return p;
}

// ── v1 /api/projects ────────────────────────────────────────────────────

/**
 * Pinning curates the workspace home everyone sees, so it needs project:update (spec
 * M-12: the Python rule read one direct row and let workspace billing pin while refusing
 * inherited admins). A legacy project's creator pins it by Directus id.
 */
export async function pinProject(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  pinOrder: number | null,
) {
  if (pinOrder !== null && ![1, 2, 3].includes(pinOrder))
    throw new BadRequestError("pin_order must be 1, 2, or 3");
  await liveProject(d.store, projectId);
  await projectFor(d.access, who, projectId, "project:update", "any");
  await d.store.updateProject(projectId, {
    pin_order: pinOrder,
    updated_at: d.now().toISOString(),
  });
  return { success: true, pin_order: pinOrder };
}

/** Soft delete. Needs project:delete like the BFF route (spec C-5: v1 let any role delete). */
export async function deleteProjectV1(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:delete", "v1");
  const now = d.now().toISOString();
  await d.store.updateProject(projectId, { deleted_at: now, updated_at: now });
  return { status: "success" };
}

/**
 * Shallow clone into the source's workspace: settings and tag names, no conversations.
 * The Python kept the clone owned by the source's creator; that stays.
 */
export async function cloneProject(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  body: { name: string | null; language: string | null },
) {
  const pa = await projectFor(d.access, who, projectId, "project:create");
  const src = await liveProject(d.store, pa.project.id);
  const id = newId();
  const now = d.now().toISOString();
  await d.store.transaction(async ({ store }) => {
    await store.insertProject({
      id,
      name: body.name || src.name,
      language: body.language || src.language,
      is_conversation_allowed: src.is_conversation_allowed,
      directus_user_id: src.directus_user_id,
      context: src.context,
      default_conversation_title: src.default_conversation_title,
      default_conversation_description: src.default_conversation_description,
      default_conversation_finish_text: src.default_conversation_finish_text,
      default_conversation_ask_for_participant_name:
        src.default_conversation_ask_for_participant_name,
      default_conversation_tutorial_slug: src.default_conversation_tutorial_slug,
      default_conversation_transcript_prompt: src.default_conversation_transcript_prompt,
      conversation_ask_for_participant_name_label: src.conversation_ask_for_participant_name_label,
      image_generation_model: src.image_generation_model,
      is_enhanced_audio_processing_enabled: src.is_enhanced_audio_processing_enabled,
      is_get_reply_enabled: src.is_get_reply_enabled,
      is_project_notification_subscription_allowed:
        src.is_project_notification_subscription_allowed,
      is_verify_enabled: src.is_verify_enabled,
      selected_verification_key_list: src.selected_verification_key_list,
      ...(src.workspace_id && { workspace_id: src.workspace_id }),
      created_at: now,
    });
    const tags = await store.tags(src.id);
    await store.insertTags(
      tags.map((t) => ({
        id: newId(),
        project_id: id,
        text: (t.text as string | null) ?? "",
        created_at: now,
      })),
    );
  });
  return id;
}

/** Keeps letters and digits, joins the rest with single underscores, as the export names files. */
export function safeForFilename(text: string | null, max: number): string {
  if (!text) return "";
  const replaced = [...text].map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : "_")).join("");
  return [...replaced.split("_").filter(Boolean).join("_")].slice(0, max).join("");
}

function stamp(iso: string | null, now: Date): string {
  const d = iso ? new Date(iso.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : now;
  const t = Number.isNaN(d.getTime()) ? now : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

/** Every transcribed conversation as one markdown file each, zipped. Reading transcripts needs conversation:read. */
export async function exportTranscripts(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "conversation:read", "v1");
  const project = await liveProject(d.store, projectId);
  const conversations = await d.store.conversationsWithChunks(projectId);
  if (!conversations.length) throw new NotFoundError("No conversations found for this project");
  const enc = new TextEncoder();
  const files = conversations.flatMap((c) => {
    const lines = c.chunks.filter((t): t is string => Boolean(t));
    if (!lines.length) return [];
    let name = stamp(c.created_at, d.now());
    const safeName = safeForFilename(c.participant_name, 50);
    if (safeName) name += `_${safeName}`;
    const safeEmail = c.participant_email
      ? safeForFilename(c.participant_email.split("@")[0] ?? "", 30)
      : "";
    if (safeEmail) name += `_${safeEmail}`;
    name += `_${c.id.slice(0, 8)}`;
    return [
      { name: `${name}-transcript.md`, data: enc.encode(lines.map((l) => `${l}\n`).join("")) },
    ];
  });
  if (!files.length) throw new NotFoundError("No transcripts available for this project");
  const label = (project.name ?? projectId).replace(/[/\\ ]/g, "_");
  return { filename: `${label}_transcripts.zip`, body: zip(files, d.now()) };
}

/** Queues a library regeneration. Creating analysis runs is contributing to the project. */
export async function requestLibrary(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  language: string,
) {
  await projectFor(d.access, who, projectId, "project:update", "v1");
  await d.jobs.enqueue(createLibrary, { projectId, runId: newId(), language });
}

export async function requestView(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  body: { query: string; additional_context: string; language: string },
) {
  await projectFor(d.access, who, projectId, "project:update");
  const run = await d.store.latestAnalysisRun(projectId);
  if (!run) throw new NotFoundError("No analysis found for this project");
  await d.jobs.enqueue(createView, {
    analysisRunId: run.id,
    query: body.query,
    context: body.additional_context,
    language: body.language,
  });
}

// ── v2 /api/v2/projects ─────────────────────────────────────────────────

/** Read-time detail for the project header. Needs project:read (spec M-4: billing got it). */
export async function projectDetail(d: ProjectDeps, who: Signed, projectId: string) {
  const pa = await projectFor(d.access, who, projectId, "project:read");
  const p = await liveProject(d.store, projectId);
  const row = directusRow(p);
  return {
    id: p.id,
    name: p.name,
    workspace_id: p.workspace_id,
    visibility: p.visibility || "workspace",
    role: pa.role,
    source: await projectSource(d.access, who, pa),
    language: p.language,
    updated_at: row.updated_at ?? null,
  };
}

/** The whole project row for the detail page, trimmed by `fields`, with the caller's role. */
export async function projectBff(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  opts: { includeTags: boolean; includeLegal: boolean; fields: string | null },
) {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const item = await d.store.projectItem(projectId);
  if (!item || item.deleted_at) throw notFound();
  const pa = await projectFor(d.access, who, projectId, "project:read");

  const legal = opts.includeLegal
    ? await legalBlock(
        d.store,
        item as { workspace_id: string | null; directus_user_id: string | null } & Row,
      )
    : null;

  let out: Row = item;
  if (opts.fields) {
    const wanted = new Set(
      opts.fields
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    );
    wanted.add("id");
    out = Object.fromEntries(Object.entries(item).filter(([k]) => wanted.has(k)));
  }
  out._role = pa.role;
  out._source = await projectSource(d.access, who, pa);
  if (legal) out._legal = legal;
  if (opts.includeTags) out.tags = await d.store.tags(projectId);
  return out;
}

/**
 * The move rules shared by single and bulk moves: project:move on the source and the
 * target workspace (spec M-6: the Python compared raw role strings), a legacy project only
 * by its creator, and both sides in one billing and data-ownership context.
 */
async function authorizeMove(
  d: ProjectDeps,
  who: Signed,
  project: { workspace_id: string | null; directus_user_id: string | null },
  target: { id: string; usage_context: string | null; data_owner_email: string | null } & Row,
) {
  const src = project.workspace_id;
  if (!src) {
    if (project.directus_user_id !== who.directusUserId)
      throw new ForbiddenError("Not the owner of this project");
  } else await canMove(d, who, src, "source");
  await canMove(d, who, target.id, "target");
  const sameContext = src
    ? await sameBillingContext(d.store, src, target.id)
    : !isExternalClient(target);
  if (!sameContext)
    throw new ForbiddenError(
      "Projects can only move between workspaces in the same billing and data-ownership context. External-client workspaces keep their projects within their own context.",
    );
  return src;
}

async function canMove(d: ProjectDeps, who: Signed, wsId: string, side: "source" | "target") {
  try {
    await d.access.workspace(who, wsId, "project:move");
  } catch (err) {
    if (err instanceof NotFoundError) throw new ForbiddenError(`No access to ${side} workspace`);
    if (err instanceof ForbiddenError)
      throw new ForbiddenError(`Must be admin or owner of ${side} workspace`);
    throw err;
  }
}

async function sameBillingContext(store: ProjectsStorage, a: string, b: string) {
  if (a === b) return true;
  const key = async (id: string) => {
    const acc = await store.billingAccountForWorkspace(id);
    if (!acc) return null;
    return acc.orgId ? `org:${acc.orgId}` : `workspace:${acc.id}`;
  };
  const [ka, kb] = [await key(a), await key(b)];
  return ka !== null && ka === kb;
}

function moveEntry(
  history: unknown,
  e: {
    from: string | null;
    fromLabel: string | null;
    to: string;
    toLabel: string | null;
    by: string;
    byLabel: string | null;
  },
  now: Date,
) {
  const entries = Array.isArray(history) ? [...history] : [];
  entries.push({
    from: e.from,
    from_label: e.fromLabel,
    to: e.to,
    to_label: e.toLabel,
    by: e.by,
    by_label: e.byLabel,
    at: pythonIso(now),
  });
  return entries;
}

export async function moveProject(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  targetId: string,
) {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const project = await liveProject(d.store, projectId);
  const target = await d.store.liveWorkspace(targetId);
  if (!target) throw new NotFoundError("Target workspace not found");
  const src = await authorizeMove(d, who, project, target);
  const me = await d.store.appUser(who.appUserId);
  const fromLabel = src ? ((await d.store.workspace(src))?.name ?? null) : null;
  const now = d.now();
  await d.store.updateProject(projectId, {
    workspace_id: targetId,
    move_history: moveEntry(
      project.move_history,
      {
        from: src,
        fromLabel,
        to: targetId,
        toLabel: target.name,
        by: who.appUserId,
        byLabel: me?.display_name || me?.email || null,
      },
      now,
    ),
    updated_at: now.toISOString(),
  });
  return { project_id: projectId, workspace_id: targetId };
}

/** All or nothing: every project is authorised before any moves. */
export async function bulkMoveProjects(
  d: ProjectDeps,
  who: Signed,
  projectIds: string[],
  targetId: string,
) {
  if (!projectIds.length) throw new BadRequestError("No projects selected");
  const ids = [...new Set(projectIds)];
  if (ids.length > 500) throw new BadRequestError("Too many projects (max 500)");
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const target = await d.store.liveWorkspace(targetId);
  if (!target) throw new NotFoundError("Target workspace not found");
  const pending: {
    project: NonNullable<Awaited<ReturnType<ProjectsStorage["project"]>>>;
    src: string | null;
  }[] = [];
  for (const id of ids) {
    const project = await d.store.project(id);
    if (!project || project.deleted_at) throw new NotFoundError(`Project ${id} not found`);
    pending.push({ project, src: await authorizeMove(d, who, project, target) });
  }
  const me = await d.store.appUser(who.appUserId);
  const byLabel = me?.display_name || me?.email || null;
  const names = new Map<string, string | null>();
  const now = d.now();
  const moved: string[] = [];
  await d.store.transaction(async ({ store }) => {
    for (const { project, src } of pending) {
      if (src && !names.has(src)) names.set(src, (await store.workspace(src))?.name ?? null);
      await store.updateProject(project.id, {
        workspace_id: targetId,
        move_history: moveEntry(
          project.move_history,
          {
            from: src,
            fromLabel: src ? (names.get(src) ?? null) : null,
            to: targetId,
            toLabel: target.name,
            by: who.appUserId as string,
            byLabel,
          },
          now,
        ),
        updated_at: now.toISOString(),
      });
      moved.push(project.id);
    }
  });
  return { moved, count: moved.length };
}

const NOW_PRIVATE = {
  event_code: "PROJECT_NOW_PRIVATE",
  severity: "destructive",
  action: "NONE",
  message:
    "It's no longer visible to the whole workspace. Only the people explicitly shared can see it.",
} as const;

/**
 * Workspace or private. Changing it needs project:set_private, whose innovator tier gate
 * applies only when going private: making a project visible again is never a paid feature.
 * Members are told, since a project they saw may disappear.
 */
export async function setVisibility(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  visibility: "workspace" | "private",
) {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const project = await liveProject(d.store, projectId);
  const wsId = project.workspace_id;
  if (!wsId) throw new BadRequestError("Project is not attached to a workspace");
  const ws = await d.store.liveWorkspace(wsId);
  try {
    await d.access.workspace(who, wsId, "project:set_private");
  } catch (err) {
    // A deleted workspace grants nobody a role, so it reads as no access, as before.
    if (err instanceof NotFoundError) throw new ForbiddenError("No access to this project");
    if (!(err instanceof ForbiddenError)) throw err;
    const details = err.details;
    const tierGate = !!details && !Array.isArray(details) && "requiredTier" in details;
    if (!tierGate) throw new ForbiddenError("Only workspace admins can change project visibility");
    const current = project.visibility || "workspace";
    if (current === visibility) return { status: "unchanged", visibility: current };
    if (visibility === "private")
      throw new ForbiddenError("Private projects require innovator tier or above.");
  }
  if (!ws) throw new NotFoundError("Workspace not found");
  const current = project.visibility || "workspace";
  if (current === visibility) return { status: "unchanged", visibility: current };

  const now = d.now().toISOString();
  await d.store.updateProject(projectId, { visibility, updated_at: now });
  const name = project.name || "A project";
  const audience = (await d.store.effectiveMemberIds(wsId)).filter((u) => u !== who.appUserId);
  const note =
    visibility === "private"
      ? { ...NOW_PRIVATE, title: `${name} is now private` }
      : {
          event_code: "PROJECT_NOW_WORKSPACE",
          severity: "info",
          action: "NAVIGATE_PROJECT",
          title: `${name} is now shared with the workspace`,
          message: `Everyone in ${ws.name} can see it.`,
        };
  // Frozen breadcrumb, as the inbox shows it even after a rename.
  const scope = [ws.name, project.name].filter(Boolean).join(" › ") || null;
  await d.store.insertNotifications(
    audience.map((uid) => ({
      id: newId(),
      audience_user_id: uid,
      actor_user_id: who.appUserId,
      ...note,
      scope,
      ref_workspace_id: wsId,
      ref_project_id: projectId,
      created_at: now,
    })),
  );
  return { status: "updated", visibility };
}

/** Python's round(x, 2): round half to even on the exact binary value. */
export function round2(x: number): number {
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9 && Number((x * 100).toPrecision(15)) === floor + 0.5)
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  return Number(x.toFixed(2));
}

/** Audio hours per conversation for the usage tab, deleted ones in their own bucket. */
export async function conversationUsage(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:read");
  const rows = await d.store.conversationUsage(projectId);
  const active: Row[] = [];
  const deleted: Row[] = [];
  for (const c of rows) {
    const r = {
      id: c.id,
      title: c.title,
      hours: round2((c.duration ?? 0) / 3600),
      is_deleted: Boolean(c.deleted_at),
    };
    (r.is_deleted ? deleted : active).push(r);
  }
  const byHours = (a: Row, b: Row) => (b.hours as number) - (a.hours as number);
  active.sort(byHours);
  deleted.sort(byHours);
  const sum = (xs: Row[]) => round2(xs.reduce((n, r) => n + (r.hours as number), 0));
  const activeHours = sum(active);
  const deletedHours = sum(deleted);
  return {
    active,
    deleted,
    total_hours: round2(activeHours + deletedHours),
    active_hours: activeHours,
    deleted_hours: deletedHours,
  };
}

// ── BFF /api/v2/bff/projects ────────────────────────────────────────────

/** Every project the caller can open, across workspaces, for pickers. */
export async function listMyProjects(
  d: ProjectDeps,
  who: Signed,
  opts: { limit: number; offset: number; search: string | null },
) {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const wsIds = await d.store.reachableWorkspaceIds(who.appUserId);
  if (!wsIds.length) return [];
  const rows = await d.store.projectsInWorkspaces(wsIds, {
    search: opts.search?.trim() || null,
    limit: opts.limit,
    offset: opts.offset,
  });
  const out: Row[] = [];
  for (const r of rows)
    if (await projectAllows(d.access, who, r.id as string, "project:read")) out.push(r);
  return out;
}

/**
 * The fields the BFF project PATCH accepts (bff/tags.py ProjectUpdate). The assistant's
 * project settings and proposed updates read the same list, so both agree on what exists.
 */
export const PROJECT_UPDATE_FIELDS = [
  "name",
  "context",
  "language",
  "is_conversation_allowed",
  "default_conversation_title",
  "default_conversation_description",
  "default_conversation_finish_text",
  "default_conversation_ask_for_participant_name",
  "default_conversation_ask_for_participant_email",
  "default_conversation_transcript_prompt",
  "default_conversation_tutorial_slug",
  "get_reply_mode",
  "get_reply_prompt",
  "is_get_reply_enabled",
  "is_verify_enabled",
  "is_verify_on_finish_enabled",
  "is_canvas_enabled",
  "is_dembrane_event_cta_enabled",
  "selected_verification_key_list",
  "is_project_notification_subscription_allowed",
  "anonymize_transcripts",
  "enable_ai_title_and_tags",
  "conversation_title_prompt",
  "image_generation_model",
  "tutorial_slug",
  "host_guide",
  "methodology_version_id",
  "legal_basis",
  "privacy_policy_url",
] as const;

/**
 * Edits whitelisted fields; explicit nulls clear. Hiding the event invitation is a paid
 * feature. The legal basis can switch consent off, so it needs settings:manage (spec M-6:
 * the Python compared raw role strings) and dembrane-events a dembrane account.
 */
export async function updateProject(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
  body: Record<string, unknown>,
  fieldsSet: ReadonlySet<string>,
) {
  const pa = await projectFor(d.access, who, projectId, "project:update");
  const project = await liveProject(d.store, projectId);
  const payload: Record<string, unknown> = {};
  for (const k of PROJECT_UPDATE_FIELDS) if (fieldsSet.has(k)) payload[k] = body[k];
  if (!Object.keys(payload).length) throw new BadRequestError("No fields to update");

  if (payload.is_dembrane_event_cta_enabled === false) {
    const tier = project.workspace_id ? await d.store.workspaceTier(project.workspace_id) : null;
    if (tier === "free")
      throw new ForbiddenError("Hiding the dembrane event invitation comes with a paid plan");
  }

  const legal = legalWrite({
    fieldsSet,
    legalBasis: (body.legal_basis as string | null) ?? null,
    privacyPolicyUrl: (body.privacy_policy_url as string | null) ?? null,
    storedLegalBasis: project.legal_basis,
    storedPrivacyPolicyUrl: project.privacy_policy_url,
  });
  if (legal) {
    const canSetLegal = await d.access
      .project(who, projectId, "settings:manage")
      .then(() => true)
      .catch(() => false);
    if (!canSetLegal) throw new ForbiddenError("Only workspace admins can change the legal basis");
    if (legal.requiresDembraneEmail) {
      const email = (await d.store.directusUser(who.directusUserId))?.email ?? "";
      if (!email.toLowerCase().endsWith("@dembrane.com"))
        throw new ForbiddenError("dembrane-events is only available for dembrane accounts");
    }
    Object.assign(payload, legal.payload);
  }
  // tutorial_slug is accepted by the whitelist but has no column; Directus dropped it too.
  delete payload.tutorial_slug;
  void pa;
  await d.store.updateProject(projectId, { ...payload, updated_at: d.now().toISOString() });
  return (await d.store.projectItem(projectId)) ?? {};
}

/** Soft delete behind project:delete. */
export async function deleteProjectBff(d: ProjectDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:delete");
  const now = d.now().toISOString();
  await d.store.updateProject(projectId, { deleted_at: now, updated_at: now });
  return { status: "deleted" };
}
