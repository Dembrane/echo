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

/** The alert for a failed or cancelled report: a budget stop is neutral, not an error. */
export function failedReportAlert(r: {
	error_code?: string | null;
	status?: string | null;
}): { color: "yellow" | "gray" | "red"; title: string } {
	if (r.status === "cancelled")
		return { color: "yellow", title: t`Report generation cancelled` };
	if (r.error_code === "AI_BUDGET_USED_UP")
		return { color: "gray", title: t`Report not generated` };
	return { color: "red", title: t`Something went wrong` };
}
