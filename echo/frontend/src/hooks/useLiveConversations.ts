import { readItems } from "@directus/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { directus } from "@/lib/directus";

export type ActiveConversation = {
	id: string;
	participantName: string | null;
};

type ConversationChunkResult = {
	conversation_id: {
		id: string;
		participant_name: string | null;
	} | null;
};

const TIME_INTERVAL_SECONDS = 30;
const POLL_INTERVAL = 15000; // Poll every 15 seconds

export const useLiveConversations = (
	projectId: string | undefined,
	enabled: boolean,
) => {
	const [conversations, setConversations] = useState<ActiveConversation[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const intervalRef = useRef<NodeJS.Timeout | null>(null);

	const fetchConversations = useCallback(async () => {
		if (!projectId) return;

		try {
			// Query conversation_chunks from the last 30 seconds
			// Same logic as OngoingConversationsSummaryCard
			const result = await directus.request(
				readItems("conversation_chunk", {
					// @ts-expect-error nested fields not properly typed
					fields: ["conversation_id.id", "conversation_id.participant_name"],
					filter: {
						conversation_id: {
							project_id: { _eq: projectId },
						},
						source: {
							// @ts-expect-error source filter type is not properly typed
							_nin: ["DASHBOARD_UPLOAD", "CLONE"],
						},
						timestamp: {
							// @ts-expect-error _gt is not typed for timestamp
							_gt: new Date(
								Date.now() - TIME_INTERVAL_SECONDS * 1000,
							).toISOString(),
						},
					},
					limit: 50,
				}),
			);

			// Get unique conversations
			const conversationMap = new Map<string, ActiveConversation>();
			for (const chunk of result as unknown as ConversationChunkResult[]) {
				if (
					chunk.conversation_id &&
					!conversationMap.has(chunk.conversation_id.id)
				) {
					conversationMap.set(chunk.conversation_id.id, {
						id: chunk.conversation_id.id,
						participantName: chunk.conversation_id.participant_name,
					});
				}
			}

			setConversations(Array.from(conversationMap.values()));
			setError(null);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to fetch conversations",
			);
		}
	}, [projectId]);

	useEffect(() => {
		if (!enabled || !projectId) {
			setConversations([]);
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
			return;
		}

		// Initial fetch
		setIsLoading(true);
		fetchConversations().finally(() => setIsLoading(false));

		// Set up polling
		intervalRef.current = setInterval(fetchConversations, POLL_INTERVAL);

		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [projectId, enabled, fetchConversations]);

	return { conversations, error, isLoading };
};
