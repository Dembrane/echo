import { type ProjectAccess, resolveProject, resolveWorkspace } from "@dembrane/access";
import { conversationForBff, enrich } from "@dembrane/conversations";
import { BadRequestError, ForbiddenError, NotFoundError } from "@dembrane/core";
import { directusRow } from "@dembrane/legacy-shape";
import { projectFor } from "@dembrane/projects";
import { type AgentContext, type AgentDeps, orgAgentAccessEnabled } from "./context";
import type { DocsCorpus } from "./knowledge";
import type { Row } from "./storage";
import {
  type ConversationSort,
  chunkCount,
  grepConversation as grepChunks,
  listConversations as listPage,
  MIN_TOKEN_LENGTH,
  normalizeQueryTokens,
  overCap,
  readTranscript as readPage,
  searchTranscripts as searchChunks,
  status,
  tagsByConversation,
  text,
} from "./toolkit";

/**
 * The tools an agent can call, as plain functions over an AgentContext. REST and MCP both
 * call these, and each resolves access through the rules the dashboard uses before
 * narrowing to the organisations in the grant. Answers are plain objects whose key order
 * is the Python response models' field order, because the MCP text content is that JSON.
 */

export type ResultFormat = "concise" | "detailed";

export interface ToolDeps extends AgentDeps {
  readonly docs: DocsCorpus;
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The shape the token-bound person is checked in: the dashboard's project resolver. */
function projectAs(
  d: ToolDeps,
  ctx: AgentContext,
  projectId: string,
  policy: Parameters<typeof projectFor>[3],
) {
  return projectFor(d.access, ctx.who, projectId, policy);
}

async function orgOf(d: ToolDeps, pa: ProjectAccess): Promise<string | null> {
  return pa.project.workspaceId ? d.store.workspaceOrg(pa.project.workspaceId) : null;
}

/**
 * Project access as the person, then the grant's org check, then the free-tier charge.
 * project:read is required (spec L-24: the Python tools resolved any role, so a workspace
 * billing user read project settings through an agent though the dashboard refuses them).
 */
async function projectAccess(d: ToolDeps, ctx: AgentContext, projectId: string) {
  const pa = await projectAs(d, ctx, projectId, "project:read");
  const orgId = await ctx.requireOrg(await orgOf(d, pa));
  await ctx.charge(orgId);
  return { pa, orgId };
}

/** Conversation access as the person (conversation:read), then org check and charge. */
async function conversationAccess(d: ToolDeps, ctx: AgentContext, conversationId: string) {
  const { conversation, project } = await conversationForBff(d, ctx.who, conversationId);
  const orgId = await ctx.requireOrg(await orgOf(d, project));
  await ctx.charge(orgId);
  const conv = directusRow(conversation as unknown as Row);
  const active = await overCap(d, project);
  enrich(conv, project.tier, active);
  return { pa: project, conv, orgId, locked: Boolean(conv.locked) };
}

async function projectOut(d: ToolDeps, row: Row, orgId: string | null) {
  const workspaceId = s(row.workspace_id);
  const [workspaceName, organisationName] = workspaceId
    ? await d.store.placeNames(workspaceId)
    : [null, null];
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    organisation_id: orgId,
    organisation_name: organisationName,
    language: s(row.language),
    context: s(row.context),
    is_conversation_allowed: row.is_conversation_allowed ?? null,
    created_at: s(row.created_at),
    updated_at: s(row.updated_at),
  };
}

const tokenHint = () =>
  new BadRequestError(
    `query needs at least one word of ${MIN_TOKEN_LENGTH} letters or more; shorter words are ignored`,
  );

// ── identity and discovery ─────────────────────────────────────────────

async function organisations(d: ToolDeps, ctx: AgentContext) {
  if (!ctx.orgIds.length) return [];
  const orgs = await d.store.orgs(ctx.orgIds);
  if (!orgs.length) return [];
  const now = d.now();
  const guest = new Set(await d.store.guestOrgIds(ctx.appUserId, now));
  const out: Row[] = [];
  for (const org of orgs) {
    const orgId = String(org.id);
    let role = await d.store.orgRole(orgId, ctx.appUserId);
    if (!role && guest.has(orgId)) role = "guest";
    if (!role) continue;
    const enabled = await orgAgentAccessEnabled(d, orgId);
    const workspaces: Row[] = [];
    if (enabled)
      for (const ws of await d.store.orgWorkspaces(orgId)) {
        const resolved = await resolveWorkspace(d.accessStore, String(ws.id), ctx.who, now);
        if (!resolved) continue;
        workspaces.push({
          id: String(ws.id),
          name: String(ws.name ?? ""),
          role: s(resolved.role),
          tier: s(ws.tier),
        });
      }
    out.push({
      id: orgId,
      name: String(org.name ?? ""),
      role,
      agent_access_enabled: enabled,
      workspaces,
    });
  }
  return out;
}

/** Who the agent acts as and everything the grant reaches. No charge: orientation only. */
export async function whoami(d: ToolDeps, ctx: AgentContext) {
  const user = (await d.store.appUser(ctx.appUserId)) ?? {};
  return {
    app_user_id: ctx.appUserId,
    email: s(user.email),
    display_name: s(user.display_name),
    scopes: [...ctx.scopes],
    grant_id: ctx.grantId,
    client_name: ctx.clientName,
    build_version: d.buildVersion,
    organisations: await organisations(d, ctx),
  };
}

const FIND_LIMIT_MAX = 200;

/**
 * Projects by name across the grant's organisations. No charge. Organisations outside the
 * grant, or switched off, are dropped rather than refused, so the answer never confirms
 * what lies outside.
 */
export async function findProjects(
  d: ToolDeps,
  ctx: AgentContext,
  a: { query: string | null; workspace_id: string | null; limit: number },
) {
  if (!ctx.who.appUserId) throw new ForbiddenError("User not onboarded");
  const now = d.now();
  let wsIds = await d.store.reachableWorkspaceIds(ctx.who.appUserId);
  if (a.workspace_id) wsIds = wsIds.filter((w) => w === a.workspace_id);
  const hits: Row[] = [];
  if (wsIds.length) {
    const q = a.query?.trim() ? a.query.trim() : null;
    const rows = await d.store.projectsIn(
      wsIds,
      q,
      Math.max(1, Math.min(Math.trunc(a.limit), FIND_LIMIT_MAX)),
    );
    for (const row of rows) {
      if (!(await resolveProject(d.accessStore, String(row.id), ctx.who, now))) continue;
      hits.push(row);
    }
  }
  const enabled = new Map<string, boolean>();
  const kept: Row[] = [];
  for (const h of hits) {
    const orgId = s(h.org_id);
    if (!orgId || !ctx.orgIds.includes(orgId)) continue;
    if (!enabled.has(orgId)) enabled.set(orgId, await orgAgentAccessEnabled(d, orgId));
    if (enabled.get(orgId)) kept.push(h);
  }
  const names = await d.store.orgNames([...new Set(kept.map((h) => String(h.org_id)))].sort());
  return {
    query: (a.query ?? "").trim() || null,
    workspace_id: a.workspace_id,
    projects: kept.map((h) => ({
      id: String(h.id),
      name: String(h.name ?? ""),
      workspace_id: s(h.workspace_id),
      workspace_name: s(h.workspace_name),
      organisation_id: s(h.org_id),
      organisation_name: names.get(String(h.org_id)) ?? null,
      updated_at: s(h.updated_at),
    })),
  };
}

// ── projects ───────────────────────────────────────────────────────────

export async function getProject(d: ToolDeps, ctx: AgentContext, projectId: string) {
  const { orgId } = await projectAccess(d, ctx, projectId);
  return projectOut(d, (await d.store.project(projectId)) ?? { id: projectId }, orgId);
}

export const PROJECT_UPDATE_FIELDS = [
  "name",
  "context",
  "language",
  "is_conversation_allowed",
  "default_conversation_title",
  "default_conversation_description",
  "default_conversation_finish_text",
] as const;

export async function updateProject(
  d: ToolDeps,
  ctx: AgentContext,
  projectId: string,
  payload: Row,
) {
  ctx.requireWrite();
  const { orgId } = await projectAccess(d, ctx, projectId);
  await projectAs(d, ctx, projectId, "project:update");
  if (!Object.keys(payload).length) throw new BadRequestError("No fields to update");
  const row = await d.store.updateProject(projectId, payload, d.now());
  return projectOut(d, row ?? { id: projectId, ...payload }, orgId);
}

function webhookEvents(raw: unknown): string[] {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw.map(String) : [];
}

export async function listProjectWebhooks(d: ToolDeps, ctx: AgentContext, projectId: string) {
  await projectAccess(d, ctx, projectId);
  await projectAs(d, ctx, projectId, "workspace:webhooks");
  const rows = await d.store.projectWebhooks(projectId);
  return {
    project_id: projectId,
    webhooks: rows.map((w) => ({
      id: String(w.id),
      name: s(w.name),
      url: s(w.url),
      events: webhookEvents(w.events),
      status: s(w.status),
    })),
  };
}

// ── conversations ──────────────────────────────────────────────────────

/** A page of a project's conversations; one charge per page whatever the format. */
export async function listConversations(
  d: ToolDeps,
  ctx: AgentContext,
  projectId: string,
  a: {
    search: string | null;
    created_after: string | null;
    created_before: string | null;
    limit: number;
    offset: number;
    sort: ConversationSort;
    format: ResultFormat;
  },
) {
  await projectAccess(d, ctx, projectId);
  const pa = await projectAs(d, ctx, projectId, "conversation:read");
  const page = await listPage(d, pa, projectId, {
    search: a.search,
    limit: a.limit,
    offset: a.offset,
    sort: a.sort,
    createdAfter: a.created_after,
    createdBefore: a.created_before,
  });
  const tags =
    a.format === "detailed"
      ? await tagsByConversation(
          d,
          page.conversations.map((c) => String(c.id)),
        )
      : new Map<string, string[]>();
  const conversations = page.conversations.map((c) =>
    a.format === "detailed"
      ? {
          id: c.id,
          participant_name: c.participant_name,
          title: c.title,
          created_at: c.created_at,
          duration: c.duration,
          status: c.status,
          locked: c.locked,
          summary: c.summary,
          tags: tags.get(String(c.id)) ?? [],
        }
      : {
          id: c.id,
          participant_name: c.participant_name,
          title: c.title,
          created_at: c.created_at,
          duration: c.duration,
          status: c.status,
        },
  );
  return {
    project_id: projectId,
    format: a.format,
    offset: page.offset,
    has_more: page.has_more,
    conversations,
  };
}

/** Conversations whose transcript holds the query's words, with snippets. One charge per call. */
export async function searchTranscripts(
  d: ToolDeps,
  ctx: AgentContext,
  projectId: string,
  query: string,
  limit: number,
  offset: number,
) {
  if (!query.trim()) throw new BadRequestError("query is required");
  await projectAccess(d, ctx, projectId);
  const pa = await projectAs(d, ctx, projectId, "conversation:read");
  const result = await searchChunks(d, pa, projectId, query, limit, offset);
  if (!result.tokens.length) throw tokenHint();
  return result;
}

export async function grepConversation(
  d: ToolDeps,
  ctx: AgentContext,
  conversationId: string,
  query: string,
  maxMatches: number,
) {
  if (!query.trim()) throw new BadRequestError("query is required");
  const tokens = normalizeQueryTokens(query);
  if (!tokens.length) throw tokenHint();
  const { locked } = await conversationAccess(d, ctx, conversationId);
  const matches = await grepChunks(d, conversationId, locked, query, maxMatches);
  return { conversation_id: conversationId, tokens, matches };
}

export async function readTranscript(
  d: ToolDeps,
  ctx: AgentContext,
  conversationId: string,
  offset: number,
  limit: number,
  format: ResultFormat,
) {
  const { locked } = await conversationAccess(d, ctx, conversationId);
  const page = await readPage(d, conversationId, locked, offset, limit);
  return {
    conversation_id: conversationId,
    format,
    offset: page.offset,
    limit: page.limit,
    total: page.total,
    has_more: page.has_more,
    transcript_locked: page.transcript_locked,
    chunks: page.chunks.map((c) =>
      format === "detailed"
        ? { id: c.id, timestamp: c.timestamp, transcript: c.transcript }
        : { timestamp: c.timestamp, transcript: c.transcript },
    ),
  };
}

/** One conversation's metadata, never its transcript. */
export async function getConversation(d: ToolDeps, ctx: AgentContext, conversationId: string) {
  const { conv } = await conversationAccess(d, ctx, conversationId);
  const [count, tags] = await Promise.all([
    chunkCount(d, conversationId),
    tagsByConversation(d, [conversationId]),
  ]);
  const base = {
    id: String(conv.id),
    project_id: String(conv.project_id),
    title: s(conv.title),
    participant_name: s(conv.participant_name),
    summary: s(conv.summary),
    source: s(conv.source),
    duration: conv.duration ?? null,
    is_finished: conv.is_finished ?? null,
    is_all_chunks_transcribed: conv.is_all_chunks_transcribed ?? null,
    locked: Boolean(conv.locked),
    created_at: s(conv.created_at),
    updated_at: s(conv.updated_at),
  };
  return {
    ...base,
    chunk_count: count,
    tags: tags.get(conversationId) ?? [],
    status: status(base),
  };
}

// ── reporting back to dembrane ─────────────────────────────────────────

const MAX_TICKET_CHARS = 4000;
const SOURCE_AGENT_MCP = "agent_mcp";

function clip(t: string, limit = MAX_TICKET_CHARS): string {
  const chars = Array.from(t.trim());
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

/** Python's json.dumps with default separators and ensure_ascii, for stored JSON text. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string")
    return JSON.stringify(v).replace(
      /[\u007f-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  return `{${Object.entries(v as Row)
    .map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`)
    .join(", ")}}`;
}

/**
 * Files a support ticket in the person's name, source agent_mcp, on the same outbox table
 * the dashboard form and the assistant write. Never transcript content.
 */
export async function reportIssue(
  d: ToolDeps,
  ctx: AgentContext,
  message: string,
  projectIdIn: string | null,
  conversationId: string | null,
) {
  if (!message.trim()) throw new BadRequestError("message is required");
  let projectId = projectIdIn;
  let workspaceId: string | null = null;
  let orgId: string | null = null;
  if (conversationId) {
    // The conversation must be one the person can read, and when a project is named too it
    // must belong to it (spec L-24: the Python tool stored an unchecked conversation id
    // whenever a project was given, so a ticket could point at another tenant's data).
    const { conversation } = await conversationForBff(d, ctx.who, conversationId);
    if (projectId && conversation.project_id !== projectId)
      throw new NotFoundError("Conversation not found");
    projectId = conversation.project_id;
  }
  if (projectId) {
    const r = await projectAccess(d, ctx, projectId);
    workspaceId = r.pa.project.workspaceId;
    orgId = r.orgId;
  }
  let body = `[${ctx.clientName} via MCP] ${clip(message)}`;
  if (conversationId) body += `\nConversation: ${conversationId}`;
  const id = await d.store.fileSupportRequest({
    source: SOURCE_AGENT_MCP,
    directusUserId: ctx.directusUserId,
    appUserId: ctx.appUserId,
    workspaceId,
    projectId,
    message: body,
    pageContext: pyDumps({
      source: SOURCE_AGENT_MCP,
      kind: "issue",
      client_name: ctx.clientName,
      client_id: ctx.clientId,
      grant_id: ctx.grantId,
      conversation_id: conversationId,
      org_id: orgId,
    }),
    now: d.now(),
  });
  return { id, status: "new", kind: "issue" };
}

/** A missing tool, filed as a capability gap in the table the assistant's insights use. */
export async function requestTool(
  d: ToolDeps,
  ctx: AgentContext,
  name: string,
  description: string,
  example: string | null,
) {
  if (!name.trim() || !description.trim())
    throw new BadRequestError("name and description are required");
  let content = `[${ctx.clientName} via MCP] ${clip(description)}`;
  if (example) content += `\nExample: ${clip(example, 1000)}`;
  const suggested = Array.from(name.trim()).slice(0, 120).join("").trim();
  const id = await d.store.fileInsight({
    source: SOURCE_AGENT_MCP,
    kind: "capability_gap",
    content: content.trim(),
    suggestedCapability: suggested || null,
    workspaceId: null,
    projectId: null,
    now: d.now(),
  });
  return { id, status: "new", kind: "tool_request" };
}

// ── documentation ──────────────────────────────────────────────────────

export async function readDoc(d: ToolDeps, path: string, offset: number, limit: number) {
  return { path, text: await d.docs.read(path, offset, limit) };
}

/** With a pattern, matching lines; without, the page index. */
export async function searchDocs(d: ToolDeps, pattern: string | null, maxResults: number) {
  const pages = await d.docs.list();
  if (!(pattern ?? "").trim())
    return {
      pattern: null,
      results: pages.map((p) => ({ path: p.path, title: p.title, line: null, text: null })),
    };
  const titles = new Map(pages.map((p) => [p.path, p.title]));
  const hits = await d.docs.grep(String(pattern), maxResults);
  return {
    pattern,
    results: hits.map((h) => ({
      path: h.path,
      title: titles.get(h.path) ?? h.path,
      line: h.line,
      text: h.text,
    })),
  };
}

export { text };
