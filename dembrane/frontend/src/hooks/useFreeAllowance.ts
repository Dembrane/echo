import { type QueryClient, useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ensureOk } from "@/lib/errors/read";

export interface FreeMeter {
	used: number;
	limit: number;
}

export interface FreeAllowance {
	free: boolean;
	period_start: string | null;
	resets_at: string | null;
	audio_seconds: FreeMeter | null;
	chats: FreeMeter | null;
	reports: FreeMeter | null;
	maps: FreeMeter | null;
	popcorn_analyses: FreeMeter | null;
	projects: FreeMeter | null;
}

export const freeAllowanceQueryKey = (workspaceId: string) =>
	["workspace", workspaceId, "free-allowance"] as const;

/** Refetches every workspace's free allowance after a spend or a refund. */
export const invalidateFreeAllowance = (qc: QueryClient) =>
	qc.invalidateQueries({
		predicate: ({ queryKey }) =>
			queryKey[0] === "workspace" && queryKey.at(-1) === "free-allowance",
	});

export const useFreeAllowance = (workspaceId: string | null | undefined) =>
	useQuery({
		enabled: !!workspaceId,
		queryFn: async () => {
			const res = await ensureOk(
				await fetch(
					`${API_BASE_URL}/v2/workspaces/${workspaceId}/free-allowance`,
					{ credentials: "include" },
				),
			);
			return (await res.json()) as FreeAllowance;
		},
		queryKey: freeAllowanceQueryKey(workspaceId ?? ""),
		staleTime: 60_000,
	});
