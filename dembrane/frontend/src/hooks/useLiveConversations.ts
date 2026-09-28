import { useQuery } from "@tanstack/react-query";
import { bff } from "@/lib/bff";

export type ActiveConversation = {
	id: string;
	participantName: string | null;
};

const TIME_INTERVAL_SECONDS = 30;
const POLL_INTERVAL = 15000; // Poll every 15 seconds

export const useLiveConversations = (
	projectId: string | undefined,
	enabled: boolean,
) => {
	// Direct conversation_chunk reads 403 since the lockdown; go through
	// the BFF.
	const query = useQuery({
		enabled: enabled && !!projectId,
		queryFn: async () => {
			const rows = await bff.get<
				{ id: string; participant_name: string | null }[]
			>("/conversations/live", {
				project_id: projectId,
				window_seconds: TIME_INTERVAL_SECONDS,
			});
			return rows.map(
				(row): ActiveConversation => ({
					id: row.id,
					participantName: row.participant_name,
				}),
			);
		},
		queryKey: ["v2", "live-conversations", projectId],
		refetchInterval: POLL_INTERVAL,
	});

	return {
		conversations: query.data ?? [],
		error: query.error ? query.error.message : null,
		isLoading: query.isLoading,
	};
};
