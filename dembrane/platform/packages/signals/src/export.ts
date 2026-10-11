import { type Db, schema } from "@dembrane/db";
import { and, asc, eq, gte } from "drizzle-orm";
import { trainingVerdict } from "./consent";

const { ai_signal, conversation, project, workspace } = schema;

export interface ExportedSignal {
  readonly id: string;
  readonly created_at: string;
  readonly step: string;
  readonly kind: string;
  readonly value: number | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly conversation_id: string;
  readonly consent_version: string;
  readonly payload: unknown;
}

/**
 * The signals a training run may read: participant-conversation signals whose client opted
 * in and whose participant consented. This is the only way signals leave the database for
 * training, so the consent rule lives here once. Project and actor ids are not exported.
 */
export async function trainableSignals(
  db: Db,
  opts: { since?: string | undefined; step?: string | undefined } = {},
): Promise<{ rows: ExportedSignal[]; skipped: Record<string, number> }> {
  const where = [
    ...(opts.since ? [gte(ai_signal.created_at, opts.since)] : []),
    ...(opts.step ? [eq(ai_signal.step, opts.step)] : []),
  ];
  const found = await db
    .select({
      s: ai_signal,
      deletedAt: conversation.deleted_at,
      consentAt: conversation.training_consent_at,
      consentVersion: conversation.training_consent_version,
      projectAiTraining: project.ai_training,
      workspaceAiTraining: workspace.ai_training,
    })
    .from(ai_signal)
    .innerJoin(conversation, eq(conversation.id, ai_signal.conversation_id))
    .innerJoin(project, eq(project.id, conversation.project_id))
    .leftJoin(workspace, eq(workspace.id, project.workspace_id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(ai_signal.created_at));
  const rows: ExportedSignal[] = [];
  const skipped: Record<string, number> = {};
  for (const f of found) {
    const v = trainingVerdict({
      projectAiTraining: f.projectAiTraining,
      workspaceAiTraining: f.workspaceAiTraining ?? null,
      trainingConsentAt: f.consentAt,
      trainingConsentVersion: f.consentVersion,
      deletedAt: f.deletedAt,
    });
    if (!v.eligible) {
      skipped[v.reason] = (skipped[v.reason] ?? 0) + 1;
      continue;
    }
    rows.push({
      id: f.s.id,
      created_at: f.s.created_at,
      step: f.s.step,
      kind: f.s.kind,
      value: f.s.value,
      target_type: f.s.target_type,
      target_id: f.s.target_id,
      conversation_id: f.s.conversation_id as string,
      consent_version: v.consentVersion,
      payload: f.s.payload,
    });
  }
  return { rows, skipped };
}
