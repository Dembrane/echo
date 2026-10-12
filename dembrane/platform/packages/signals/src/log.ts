import { newId } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";

export type SignalKind = "accept" | "edit" | "reject" | "revise" | "rate";
export type ActorKind = "participant" | "host" | "staff" | "agent";

export interface SignalInput {
  readonly step: string;
  readonly kind: SignalKind;
  /** +1 / -1 for a rating, a score where the step has one; null otherwise. */
  readonly value?: number | null;
  readonly targetType: string;
  readonly targetId: string;
  readonly projectId?: string | null;
  readonly conversationId?: string | null;
  readonly actorKind: ActorKind;
  readonly actorId?: string | null;
  readonly payload?: Record<string, unknown> | null;
}

/**
 * Records what a person did with a model's artefact. Awaited, so the row exists when the
 * request answers, but a failed write is logged and never fails the person's action.
 */
export async function recordSignal(db: Db, logger: Logger, s: SignalInput): Promise<void> {
  try {
    await db.insert(schema.ai_signal).values({
      id: newId(),
      step: s.step,
      kind: s.kind,
      value: s.value ?? null,
      target_type: s.targetType,
      target_id: s.targetId,
      project_id: s.projectId ?? null,
      conversation_id: s.conversationId ?? null,
      actor_kind: s.actorKind,
      actor_id: s.actorId ?? null,
      payload: s.payload ?? null,
    });
  } catch (err) {
    logger.warn({ err, step: s.step, kind: s.kind }, "signal write failed");
  }
}

/**
 * What an edit to a model's text says: unchanged text on approval is an accept, changed
 * text is an edit and keeps both versions as the training pair.
 */
export function classifyEdit(
  before: string | null,
  after: string | null,
  approved: boolean,
): { kind: "accept" | "edit"; payload: Record<string, unknown> } | null {
  const changed = after !== null && after.trim() !== (before ?? "").trim();
  if (changed) return { kind: "edit", payload: { before: before ?? "", after, approved } };
  if (approved) return { kind: "accept", payload: { approved: true } };
  return null;
}
