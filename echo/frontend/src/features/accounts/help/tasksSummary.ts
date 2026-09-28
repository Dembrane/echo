import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import type { TasksSummaryT } from "../api/provisional";

/**
 * The caller's account tasks per organisation, for the Help menu's "Tasks" entry. It runs
 * on every dashboard load, so it is one small GET cached by the app's query client and it
 * skips the contract's zod parsing (that would pull zod 4 into every load); a malformed
 * answer simply hides the entry. The key sits under ["accounts"], so any account write
 * refreshes the count.
 */
export const tasksSummaryKey = ["accounts", "tasks-summary"] as const;

export async function fetchTasksSummary(): Promise<TasksSummaryT> {
	if (import.meta.env.VITE_ACCOUNTS_FIXTURES === "1") {
		const fx = await import("../api/fixtureBackend");
		return (await fx.handle("tasksSummary", {}, undefined)) as TasksSummaryT;
	}
	const res = await fetch(`${API_BASE_URL}/v2/account/tasks-summary`, {
		credentials: "include",
	});
	if (!res.ok) return { orgs: [] };
	const data = (await res.json().catch(() => null)) as TasksSummaryT | null;
	return Array.isArray(data?.orgs) ? data : { orgs: [] };
}

export const useTasksSummary = () =>
	useQuery({
		queryFn: fetchTasksSummary,
		queryKey: tasksSummaryKey,
		retry: false,
		staleTime: 5 * 60_000,
	});

/** Orgs that have any task, and their totals. */
export const summarise = (summary: TasksSummaryT | undefined) => {
	const orgs = (summary?.orgs ?? []).filter((o) => o.total > 0);
	return {
		done: orgs.reduce((a, o) => a + o.done, 0),
		orgs,
		total: orgs.reduce((a, o) => a + o.total, 0),
	};
};
