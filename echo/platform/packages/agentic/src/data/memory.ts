import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/http";
import { agentProject } from "../access";
import {
  type DataDeps,
  isUuid,
  projectWorkspaceId,
  type Row,
  row,
  ServerError,
  sqlOf,
  text,
  workspaceGate,
} from "./deps";

/**
 * Assistant memory in three scopes. User memory belongs to one host and may hold private
 * content; workspace and project memory is shared with everyone who can reach the scope,
 * so its content stays generic.
 */
export const MEMORY_SCOPES = ["workspace", "project", "user"] as const;
const READ_LIMIT = 200;
const CARD = ["id", "scope", "memory_key", "content", "source", "updated_at"] as const;
const LIST = [...CARD, "created_at"] as const;

const pick = (r: Row, fields: readonly string[]) =>
  Object.fromEntries(fields.map((f) => [f, r[f] ?? null]));

/** GET /agentic/projects/{p}/memory: the host's own, the workspace's and the project's memory. */
export async function memory(d: DataDeps, who: Signed, projectId: string) {
  await agentProject(d.access, who, projectId);
  const workspaceId = await projectWorkspaceId(d, projectId);
  const sql = sqlOf(d);
  const rows = await sql`
    select * from agent_memory
    where (scope = 'user' and directus_user_id = ${who.directusUserId})
       or (scope = 'workspace' and ${
         workspaceId === null ? sql`workspace_id is null` : sql`workspace_id = ${workspaceId}`
       })
       or (scope = 'project' and project_id = ${projectId})
    order by updated_at desc
    limit ${READ_LIMIT}`;
  const memories = rows.map((r) => pick(row(r as Row), CARD));
  return { project_id: projectId, count: memories.length, memories };
}

/**
 * POST /agentic/projects/{p}/memory. With a memory_key it upserts on (scope, owner, key),
 * so a remembered fact is corrected in place; without one it appends.
 */
export async function writeMemory(
  d: DataDeps,
  who: Signed,
  projectId: string,
  body: { scope: string; content: string; memory_key?: string | null },
) {
  await agentProject(d.access, who, projectId);
  const scope = body.scope.trim().toLowerCase();
  if (!(MEMORY_SCOPES as readonly string[]).includes(scope))
    throw new BadRequestError(`Invalid scope. Use one of: ${MEMORY_SCOPES.join(", ")}`);
  const content = body.content.trim();
  if (!content) throw new BadRequestError("content is required");
  const workspaceId = await projectWorkspaceId(d, projectId);
  if (scope !== "user" && workspaceId === null) {
    throw new ServerError("Project is missing a workspace reference");
  }
  const owner: Record<string, string | null> =
    scope === "user"
      ? { directus_user_id: who.directusUserId }
      : scope === "workspace"
        ? { workspace_id: workspaceId }
        : { project_id: projectId, workspace_id: workspaceId };
  const key = text(body.memory_key);
  const sql = sqlOf(d);
  const now = d.now().toISOString();
  if (key !== null) {
    const ownerClause = Object.entries(owner)
      .map(([f, v]) => sql`and ${sql(f)} = ${v}`)
      .reduce((a, b) => sql`${a} ${b}`, sql``);
    const [existing] = await sql`
      select id from agent_memory where scope = ${scope} and memory_key = ${key} ${ownerClause}
      order by id limit 1`;
    if (existing) {
      await sql`update agent_memory set content = ${content}, updated_at = ${now} where id = ${existing.id}`;
      return { id: String(existing.id), scope, action: "updated" };
    }
  }
  const id = newId();
  await sql`
    insert into agent_memory (id, scope, memory_key, content, source, directus_user_id,
                              workspace_id, project_id, created_at)
    values (${id}, ${scope}, ${key}, ${content}, 'agent', ${owner.directus_user_id ?? null},
            ${owner.workspace_id ?? null}, ${owner.project_id ?? null}, ${now})`;
  return { id, scope, action: "created" };
}

async function memoryOr404(d: DataDeps, memoryId: string): Promise<Row> {
  if (!isUuid(memoryId)) throw new NotFoundError("Memory not found");
  const [r] = await sqlOf(d)`select * from agent_memory where id = ${memoryId}`;
  if (!r) throw new NotFoundError("Memory not found");
  return row(r as Row);
}

/**
 * Who may change a memory through the assistant: its owner for user memory, chat:use on
 * the project for project memory. Workspace memory needs chat:use to amend and
 * settings:manage to forget (spec M-13: any workspace role, observers and billing
 * included, could rewrite or delete it). Unreachable memories answer 404.
 */
async function requireMemoryAccess(d: DataDeps, who: Signed, mem: Row, intent: "amend" | "forget") {
  if (who.isStaff) return;
  const scope = String(mem.scope ?? "");
  if (scope === "user") {
    if (text(mem.directus_user_id) !== who.directusUserId)
      throw new NotFoundError("Memory not found");
    return;
  }
  const projectId = text(mem.project_id);
  if (projectId) {
    await agentProject(d.access, who, projectId);
    return;
  }
  const workspaceId = text(mem.workspace_id);
  if (workspaceId && who.appUserId && isUuid(workspaceId)) {
    const reach = await d.access.workspace(who, workspaceId, "chat:use").then(
      () => true,
      () => false,
    );
    if (!reach) throw new NotFoundError("Memory not found");
    if (intent === "forget") {
      await d.access.workspace(who, workspaceId, "settings:manage").catch(() => {
        throw new ForbiddenError("Not allowed");
      });
    }
    return;
  }
  throw new NotFoundError("Memory not found");
}

/** PATCH /agentic/memories/{id}: a correction edits the same row instead of layering another. */
export async function amendMemory(d: DataDeps, who: Signed, memoryId: string, content: string) {
  const mem = await memoryOr404(d, memoryId);
  await requireMemoryAccess(d, who, mem, "amend");
  const trimmed = content.trim();
  if (!trimmed) throw new BadRequestError("content is required");
  await sqlOf(d)`
    update agent_memory set content = ${trimmed}, updated_at = ${d.now().toISOString()}
    where id = ${memoryId}`;
  return { id: memoryId, scope: mem.scope ?? null, action: "amended" };
}

/** DELETE /agentic/memories/{id}: memory is working state, so forgetting deletes the row. */
export async function forgetMemory(d: DataDeps, who: Signed, memoryId: string) {
  const mem = await memoryOr404(d, memoryId);
  await requireMemoryAccess(d, who, mem, "forget");
  await sqlOf(d)`delete from agent_memory where id = ${memoryId}`;
  return { id: memoryId, deleted: true };
}

// ── /v2/bff/memory: hosts see and clear what the assistant remembers ───

async function listFor(d: DataDeps, where: ReturnType<ReturnType<typeof sqlOf>>) {
  const rows = await sqlOf(d)`
    select * from agent_memory where ${where} order by updated_at desc limit ${READ_LIMIT}`;
  return rows.map((r) => pick(row(r as Row), LIST));
}

/** The caller's own user memory; the owner is the filter, so no policy applies. */
export async function listUserMemory(d: DataDeps, who: Signed) {
  const sql = sqlOf(d);
  return listFor(d, sql`scope = 'user' and directus_user_id = ${who.directusUserId}`);
}

export async function listProjectMemory(d: DataDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "chat:use");
  const sql = sqlOf(d);
  return listFor(d, sql`scope = 'project' and project_id = ${projectId}`);
}

export async function listWorkspaceMemory(d: DataDeps, who: Signed, workspaceId: string) {
  await workspaceGate(d, who, workspaceId, "chat:use");
  const sql = sqlOf(d);
  return listFor(d, sql`scope = 'workspace' and workspace_id = ${workspaceId}`);
}

/**
 * Clears one memory from the settings page: user rows only by their owner (404 to anyone
 * else), project and workspace rows with chat:use on that scope. A row with an unknown
 * scope or no owner id is unreachable here and reads as absent.
 */
export async function deleteMemory(d: DataDeps, who: Signed, memoryId: string) {
  const mem = await memoryOr404(d, memoryId);
  const scope = mem.scope;
  const projectId = text(mem.project_id);
  const workspaceId = text(mem.workspace_id);
  if (scope === "user") {
    if (text(mem.directus_user_id) !== who.directusUserId)
      throw new NotFoundError("Memory not found");
  } else if (scope === "project" && projectId) {
    await projectFor(d.access, who, projectId, "chat:use");
  } else if (scope === "workspace" && workspaceId) {
    await workspaceGate(d, who, workspaceId, "chat:use");
  } else {
    throw new NotFoundError("Memory not found");
  }
  await sqlOf(d)`delete from agent_memory where id = ${memoryId}`;
  return { status: "deleted" };
}
