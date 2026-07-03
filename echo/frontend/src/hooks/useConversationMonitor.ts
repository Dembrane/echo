import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff";

export type MonitorConversation = {
	id: string;
	label: string | null;
	is_live: boolean;
	is_finished: boolean;
	last_chunk_at: string | null;
	chunk_count: number;
	has_error: boolean;
	error_message: string | null;
};

export type MonitorSummary = {
	live: number;
	finished: number;
	with_errors: number;
	total: number;
};

export type MonitorResponse = {
	conversations: MonitorConversation[];
	summary: MonitorSummary;
	live_window_seconds: number;
};

// Poll every few seconds so hosts see a conversation go live (or start
// failing) without a manual refresh. The endpoint is two bounded reads.
const POLL_INTERVAL_MS = 5000;

export const useConversationMonitor = (
	projectId: string | undefined,
	enabled = true,
) => {
	const query = useQuery({
		enabled: enabled && !!projectId,
		queryFn: async () =>
			bff.get<MonitorResponse>("/conversations/monitor", {
				project_id: projectId,
			}),
		queryKey: ["v2", "conversation-monitor", projectId],
		refetchInterval: POLL_INTERVAL_MS,
	});

	return {
		conversations: query.data?.conversations ?? [],
		summary: query.data?.summary ?? {
			live: 0,
			finished: 0,
			with_errors: 0,
			total: 0,
		},
		isLoading: query.isLoading,
		error: query.error ? query.error.message : null,
	};
};
