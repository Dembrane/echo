import {
  type PayingAccount,
  payingAccountsForProjects,
  payingAccountsForWorkspaces,
} from "@dembrane/allowance";
import { isUuid } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Payer, type PayerRefKind, payerKey } from "@dembrane/observability";
import { type SQL, sql } from "drizzle-orm";

/** The paying account, plus the project the call ran in (null for a workspace payer). */
export interface ResolvedPayer extends PayingAccount {
  readonly projectId: string | null;
}

export type Resolution = ResolvedPayer | "internal" | null;

type Lookup = (ids: string[]) => SQL;
const byUuid =
  (table: string): Lookup =>
  (ids) =>
    sql`select id::text as key, project_id::text as project_id from ${sql.raw(table)}
    where id = any(${sql.param(ids)}::uuid[])`;

// Each ref kind's way to its project; ids come back as Postgres prints them (lowercase).
const PROJECT_OF: Partial<Record<PayerRefKind, Lookup>> = {
  conversation: byUuid("conversation"),
  chat: byUuid("project_chat"),
  agent_run: byUuid("project_agentic_run"),
  report: (ids) =>
    sql`select id::text as key, project_id::text as project_id from project_report
      where id = any(${sql.param(ids)}::bigint[])`,
  canvas: byUuid("agent_loop"),
  popcorn_loop: byUuid("agent_loop"),
  verify_artifact: (ids) =>
    sql`select a.id::text as key, c.project_id::text as project_id
      from conversation_artifact a join conversation c on c.id = a.conversation_id
      where a.id = any(${sql.param(ids)}::uuid[])`,
  analysis_run: byUuid("analysis_run"),
};

const validId = (kind: PayerRefKind, id: string) =>
  kind === "report" ? /^\d{1,18}$/.test(id) : isUuid(id);

/** Who pays for each payer, keyed by payerKey; null when it names nothing that pays. */
export async function resolvePayers(
  db: Db,
  payers: readonly Payer[],
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  // Ref kind -> lowercase id -> the payer keys asking for it.
  const asked = new Map<PayerRefKind, Map<string, string[]>>();
  for (const p of payers) {
    const key = payerKey(p);
    if (out.has(key)) continue;
    if (!("ref" in p)) {
      out.set(key, "internal");
      continue;
    }
    out.set(key, null);
    const id = p.id.toLowerCase();
    if (!validId(p.ref, id)) continue;
    const ids = asked.get(p.ref) ?? new Map<string, string[]>();
    ids.set(id, [...(ids.get(id) ?? []), key]);
    asked.set(p.ref, ids);
  }

  // Payer key -> project id, for every ref that is or leads to a project.
  const projectOf = new Map<string, string>();
  for (const [kind, ids] of asked) {
    if (kind === "project") {
      for (const [id, keys] of ids) for (const k of keys) projectOf.set(k, id);
      continue;
    }
    const lookup = PROJECT_OF[kind];
    if (!lookup) continue;
    const rows = await db.execute<{ key: string; project_id: string | null }>(
      lookup([...ids.keys()]),
    );
    for (const r of rows)
      if (r.project_id) for (const k of ids.get(r.key) ?? []) projectOf.set(k, r.project_id);
  }

  const projects = await payingAccountsForProjects(db, [...new Set(projectOf.values())]);
  for (const [key, projectId] of projectOf) {
    const a = projects.get(projectId);
    if (a) out.set(key, { ...a, projectId });
  }
  const workspaces = asked.get("workspace");
  if (workspaces) {
    const accounts = await payingAccountsForWorkspaces(db, [...workspaces.keys()]);
    for (const [id, keys] of workspaces) {
      const a = accounts.get(id);
      if (a) for (const k of keys) out.set(k, { ...a, projectId: null });
    }
  }
  return out;
}
