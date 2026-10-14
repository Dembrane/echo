import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import posthog from "posthog-js";
import {
	confirmConversationChunkUpload,
	uploadConversationChunk,
} from "@/lib/api";

const uploadFailureStage = (
	message: string,
): "presigned_url" | "s3_put" | "confirm" => {
	if (message.includes("upload URL")) return "presigned_url";
	if (message.includes("S3")) return "s3_put";
	return "confirm";
};

const useConfirmConversationChunkUpload = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: confirmConversationChunkUpload,
		onError: (error, variables) => {
			console.error(
				`[Confirm Upload] Failed to confirm chunk ${variables.chunk_id}:`,
				error,
			);
			posthog.capture("portal_chunk_upload_failed", {
				attempts: 5,
				chunk_id: variables.chunk_id,
				conversation_id: variables.conversationId,
				stage: "confirm",
			});
		},
		onSuccess: (_data, variables) => {
			console.log(
				`[Confirm Upload] Successfully confirmed chunk ${variables.chunk_id}`,
			);
			// Invalidate queries after successful confirmation
			queryClient.invalidateQueries({
				queryKey: ["conversations", variables.conversationId],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"participant",
					"conversation_chunks",
					variables.conversationId,
				],
			});
		},
		retry: (failureCount, error: Error) => {
			const status = (error as AxiosError)?.response?.status;
			if (status && [404, 403, 410].includes(status as number)) {
				return false;
			}
			return failureCount < 5;
		},
		retryDelay: (attemptIndex) => {
			// Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped at 30s)
			return Math.min(2000 * 2 ** attemptIndex, 30000);
		},
	});
};

export const useUploadConversationChunk = () => {
	const queryClient = useQueryClient();
	const confirmUpload = useConfirmConversationChunkUpload();

	return useMutation({
		mutationFn: uploadConversationChunk,
		// If the mutation fails,
		// use the context returned from onMutate to roll back
		onError: (err, variables, context) => {
			queryClient.setQueryData(
				["conversations", variables.conversationId, "chunks"],
				(context as { previousChunks?: ConversationChunk[] })?.previousChunks,
			);
			posthog.capture("portal_chunk_upload_failed", {
				attempts: 20,
				conversation_id: variables.conversationId,
				stage: uploadFailureStage((err as Error)?.message ?? ""),
			});
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
			// Only invalidate if there was an error during S3 upload
			if (_error) {
				queryClient.invalidateQueries({
					queryKey: ["conversations", variables.conversationId],
				});

				queryClient.invalidateQueries({
					queryKey: [
						"participant",
						"conversation_chunks",
						variables.conversationId,
					],
				});
			}
		},
		// After successful S3 upload, confirm with API
		onSuccess: (data, variables) => {
			console.log(
				`[Upload] S3 upload successful, triggering confirmation for chunk ${data.chunk_id}`,
			);
			confirmUpload.mutate({
				...data,
				onProgress: variables.onProgress,
			});
		},
		retry: (failureCount, error: Error) => {
			const status = (error as AxiosError)?.response?.status;
			if (status && [404, 403, 410].includes(status as number)) {
				return false;
			}
			return failureCount < 20;
		},
	});
};
