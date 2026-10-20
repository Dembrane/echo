import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ensureOk } from "@/lib/errors/read";

export type FreeLimitKey =
	| "audio_seconds_month"
	| "audio_seconds_conversation"
	| "projects"
	| "chats_month"
	| "chat_turns_first"
	| "chat_turns_second"
	| "reports_month"
	| "maps_month"
	| "popcorn_sessions_month"
	| "popcorn_window_minutes"
	| "popcorn_cadence_minutes";

export interface FreeLimit {
	key: FreeLimitKey;
	value: number;
	default: number;
	updated_at: string | null;
	updated_by: string | null;
}

type FreeLimitsResponse = { limits: FreeLimit[] };

export const FREE_LIMITS_QUERY_KEY = ["admin", "free-limits"] as const;

const PATH = `${API_BASE_URL}/v2/admin/free-limits`;

export const useFreeLimits = () =>
	useQuery({
		queryFn: async () => {
			const res = await ensureOk(await fetch(PATH, { credentials: "include" }));
			return ((await res.json()) as FreeLimitsResponse).limits;
		},
		queryKey: FREE_LIMITS_QUERY_KEY,
		staleTime: 30_000,
	});

export const useSetFreeLimit = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			key,
			value,
		}: {
			key: FreeLimitKey;
			value: number;
		}) => {
			const res = await ensureOk(
				await fetch(`${PATH}/${key}`, {
					body: JSON.stringify({ value }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PUT",
				}),
			);
			return ((await res.json()) as FreeLimitsResponse).limits;
		},
		onSuccess: (limits) => {
			queryClient.setQueryData(FREE_LIMITS_QUERY_KEY, limits);
			void queryClient.invalidateQueries({ queryKey: FREE_LIMITS_QUERY_KEY });
		},
	});
};
