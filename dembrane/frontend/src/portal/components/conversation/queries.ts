import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import {
	getParticipantConversationById,
	getParticipantConversationChunks,
	getParticipantConversationReplies,
} from "@/lib/api";

export const combineUserChunks = (
	chunks: { type: "user_chunk"; timestamp: Date; data: TConversationChunk }[],
) => {
	return {
		data: {
			...chunks[0].data,
			transcript: chunks.map((c) => c.data.transcript).join("..."),
		},
		timestamp: chunks[0].timestamp,
		type: "user_chunk" as const,
	};
};

export const useConversationRepliesQuery = (
	projectId: string | undefined,
	conversationId: string | undefined,
) => {
	return useQuery({
		enabled: !!conversationId && !!projectId,
		queryFn: () =>
			getParticipantConversationReplies(projectId ?? "", conversationId ?? ""),
		queryKey: ["participant", "conversation_replies", conversationId],
		// refetchInterval: 15000,
	});
};

export const useConversationQuery = (
	projectId: string | undefined,
	conversationId: string | undefined,
) => {
	return useQuery({
		enabled: !!conversationId && !!projectId,
		queryFn: () =>
			getParticipantConversationById(projectId ?? "", conversationId ?? ""),
		queryKey: ["participant", "conversation", projectId, conversationId],
		refetchInterval: 60000,
		retry: (failureCount, error: AxiosError) => {
			const status = error?.response?.status;
			// Don't retry if conversation is deleted
			if (status && [404, 403, 410].includes(status as number)) {
				return false;
			}

			return failureCount < 6;
		},
	});
};

export const useConversationChunksQuery = (
	projectId: string | undefined,
	conversationId: string | undefined,
) => {
	return useQuery({
		queryFn: () =>
			getParticipantConversationChunks(projectId ?? "", conversationId ?? ""),
		queryKey: ["participant", "conversation_chunks", conversationId],
		refetchInterval: 60000,
	});
};
