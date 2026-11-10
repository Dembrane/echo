import type { TasksSummaryT } from "../contract/contract.gen";

/**
 * The banner for someone with tasks waiting on them: which organisation it names and
 * whether it was closed. Closing it holds for the browser session (sessionStorage, cleared
 * when someone signs in), so a reload stays quiet and the next session shows it again.
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

/** A new sign-in may see the banner again. */
export function resetPromptSeen(): void {
	try {
		sessionStorage.removeItem(TASKS_PROMPT_SEEN_KEY);
	} catch {}
}
