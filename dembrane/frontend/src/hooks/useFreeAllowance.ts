import { useQuery } from "@tanstack/react-query";
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
	popcorn_sessions: FreeMeter | null;
	projects: FreeMeter | null;
}

export const freeAllowanceQueryKey = (workspaceId: string) =>
	["workspace", workspaceId, "free-allowance"] as const;

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
