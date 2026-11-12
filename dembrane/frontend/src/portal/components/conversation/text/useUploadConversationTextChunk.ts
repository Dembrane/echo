import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { uploadConversationText } from "@/lib/api";

// A 402 is a limit; retrying it can only repeat the refusal.
const NO_RETRY_STATUSES = [402, 403, 404, 410];

export const useUploadConversationTextChunk = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: uploadConversationText,
		// If the mutation fails,
		// use the context returned from onMutate to roll back
		onError: (_err, variables, context) => {
			queryClient.setQueryData(
				["conversations", variables.conversationId, "chunks"],
				(context as { previousChunks?: ConversationChunk[] })?.previousChunks,
			);
		},
		// When mutate is called:
		onMutate: async (variables) => {
			// Cancel any outgoing refetches
			// (so they don't overwrite our optimistic update)
			await queryClient.cancelQueries({
				queryKey: ["conversations", variables.conversationId, "chunks"],
			});

			await queryClient.cancelQueries({
				queryKey: [
					"participant",
					"conversation_chunks",
					variables.conversationId,
				],
			});

			// Snapshot the previous value
			const previousChunks = queryClient.getQueryData([
				"conversations",
				variables.conversationId,
				"chunks",
			]);

			// Optimistically update to the new value
			queryClient.setQueryData(
				["conversations", variables.conversationId, "chunks"],
				(oldData: ConversationChunk[] | undefined) => {
					return oldData
						? [
								...oldData,
								{
									conversation_id: variables.conversationId,
									created_at: new Date().toISOString(),
									id: `optimistic-${Date.now()}`,
									timestamp: new Date().toISOString(),
									transcript: undefined,
									updated_at: new Date().toISOString(),
								} as unknown as ConversationChunk,
							]
						: [];
				},
			);

			queryClient.setQueryData(
				["participant", "conversation_chunks", variables.conversationId],
				(oldData: ConversationChunk[] | undefined) => {
					return oldData
						? [
								...oldData,
								{
									conversation_id: variables.conversationId,
									created_at: new Date().toISOString(),
									id: `optimistic-${Date.now()}`,
									timestamp: new Date().toISOString(),
									transcript: undefined,
									updated_at: new Date().toISOString(),
								} as unknown as ConversationChunk,
							]
						: [];
				},
			);

			// Return a context object with the snapshotted value
			return { previousChunks };
		},
		// Always refetch after error or success:
		onSettled: (_data, _error, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", variables.conversationId, "chunks"],
			});

			queryClient.invalidateQueries({
				queryKey: [
					"participant",
					"conversation_chunks",
					variables.conversationId,
				],
			});
		},
		// A refusal answers the same on every retry: show it at once.
		retry: (failureCount, error: Error) => {
			const status = (error as AxiosError)?.response?.status;
			if (status && NO_RETRY_STATUSES.includes(status as number)) {
				return false;
			}
			return failureCount < 10;
		},
	});
};
