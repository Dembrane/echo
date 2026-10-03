import type { TasksSummaryT } from "../contract/contract.gen";

/**
 * The popup after sign-in for someone with tasks waiting on them: which organisation it
 * names and whether it already showed. It shows once per sign-in (sessionStorage, cleared
 * when someone signs in), so a reload or a new tab in the same session stays quiet.
 */
export const TASKS_PROMPT_SEEN_KEY = "dembrane_tasks_prompt_seen";

type Row = TasksSummaryT[number];

/** The organisation with the most waiting on the caller (by name on a tie), or null. */
export const promptFor = (summary: TasksSummaryT | undefined): Row | null =>
	(summary ?? [])
		.filter((o) => o.tasks_waiting > 0)
		.sort(
			(a, b) =>
				b.tasks_waiting - a.tasks_waiting || a.name.localeCompare(b.name),
		)[0] ?? null;

export function promptSeen(): boolean {
	try {
		return sessionStorage.getItem(TASKS_PROMPT_SEEN_KEY) === "1";
	} catch {
		return false;
	}
}

export function markPromptSeen(): void {
	try {
		sessionStorage.setItem(TASKS_PROMPT_SEEN_KEY, "1");
	} catch {}
}

/** A new sign-in may see the popup again. */
export function resetPromptSeen(): void {
	try {
		sessionStorage.removeItem(TASKS_PROMPT_SEEN_KEY);
	} catch {}
}
