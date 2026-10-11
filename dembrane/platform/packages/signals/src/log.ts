import { newId } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import type { CallRecord } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | undefined) => (v && UUID.test(v) ? v : null);
const cut = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : null);

/**
 * The FallbackModel's onCall for the api and the worker: one ai_generation row per call.
 * The write is not awaited by the call, and a failed write is logged, never thrown.
 */
export function generationLog(db: Db, logger: Logger): (record: CallRecord) => void {
  return (r) => {
    const t = r.trace;
    db.insert(schema.ai_generation)
      .values({
        id: newId(),
        step: cut(t?.step, 64) ?? "untraced",
        model_group: r.group.slice(0, 64),
        deployment: cut(r.deployment, 255),
        prompt_ref: cut(t?.promptRef, 128),
        prompt_version: cut(t?.promptVersion, 128),
        project_id: uuidOrNull(t?.projectId),
        conversation_id: uuidOrNull(t?.conversationId),
        target_type: cut(t?.targetType, 64),
        target_id: cut(t?.targetId, 255),
        status: r.status,
        streamed: r.streamed,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        latency_ms: Math.round(r.latencyMs),
      })
      .then(
        () => {},
        (err) => logger.warn({ err, step: t?.step }, "generation log write failed"),
      );
  };
}

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
