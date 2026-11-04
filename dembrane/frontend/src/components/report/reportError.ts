import { t } from "@lingui/core/macro";

/** The message for a failed report: known codes translated, else the stored text; null when none. */
export function reportErrorText(r: {
	error_code?: string | null;
	error_message?: string | null;
}): string | null {
	if (r.error_code === "AI_BUDGET_USED_UP")
		return t`This month's AI budget is used up.`;
	return r.error_message || null;
}
