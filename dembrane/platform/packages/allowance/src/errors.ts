import { PaymentRequiredError } from "@dembrane/core";

export type FreeLimitName =
  | "audio_month"
  | "audio_conversation"
  | "projects"
  | "organisations"
  | "chats"
  | "chat_turns"
  | "report"
  | "map"
  | "popcorn"
  | "recording_project";

// Params go first so they can never overwrite the reason.
export function freeLimitError(
  limit: FreeLimitName,
  params: Record<string, string | number> = {},
): PaymentRequiredError {
  return new PaymentRequiredError("billing.tier_limit", {
    params: { limit },
    details: { ...params, error: "FREE_TIER_LIMIT", limit, upgrade_cta_tier: "changemaker" },
  });
}

export function isFreeLimit(err: unknown, limit?: FreeLimitName): boolean {
  if (!(err instanceof PaymentRequiredError)) return false;
  const d = err.details as { error?: unknown; limit?: unknown } | undefined;
  return d?.error === "FREE_TIER_LIMIT" && (limit === undefined || d.limit === limit);
}
