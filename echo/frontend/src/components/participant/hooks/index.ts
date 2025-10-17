import { createItem, readItems } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { toast } from "@/components/common/Toaster";
import {
	getParticipantConversationById,
	getParticipantConversationChunks,
	getParticipantProjectById,
	getParticipantTutorialCardsBySlug,
	initiateConversation,
	submitNotificationParticipant,
	uploadConversationChunk,
	uploadConversationText,
} from "@/lib/api";
import { directus } from "@/lib/directus";

export const useCreateProjectReportMetricOncePerDayMutation = () => {
	return useMutation({
		mutationFn: ({ payload }: { payload: Partial<ProjectReportMetric> }) => {
			const key = `rm_${payload.project_report_id}_updated`;
			let shouldUpdate = false;

			try {
				const lastUpdated = localStorage.getItem(key);
				if (!lastUpdated) {
					shouldUpdate = true;
				} else {
					const lastUpdateTime = new Date(lastUpdated).getTime();
					const currentTime = Date.now();
					const hoursDiff = (currentTime - lastUpdateTime) / (1000 * 60 * 60);
					shouldUpdate = hoursDiff >= 24;
				}

				if (shouldUpdate) {
					localStorage.setItem(key, new Date().toISOString());
				}
			} catch (_e) {
				// Ignore localStorage errors
				shouldUpdate = true;
			}

			if (!shouldUpdate) {
				return Promise.resolve(null);
			}

			return directus.request(createItem("project_report_metric", payload));
		},
	});
};

export const useUploadConversationChunk = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: uploadConversationChunk,
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
								} as ConversationChunk,
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
								} as ConversationChunk,
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
		retry: 20,
	});
};

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
								} as ConversationChunk,
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
								} as ConversationChunk,
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
		retry: 10,
	});
};

export const useInitiateConversationMutation = () => {
	return useMutation({
		mutationFn: initiateConversation,
		onError: () => {
			toast.error("Invalid PIN or email. Please try again.");
		},
		onSuccess: () => {
			toast.success("Success");
		},
	});
};

export const useSubmitNotificationParticipant = () => {
	return useMutation({
		mutationFn: async ({
			emails,
			projectId,
			conversationId,
		}: {
			emails: string[];
			projectId: string;
			conversationId: string;
		}) => {
			return await submitNotificationParticipant(
				emails,
				projectId,
				conversationId,
			);
		},
		onError: (error) => {
			console.error("Notification submission failed:", error);
		},
		retry: 2,
	});
};

export const useParticipantProjectById = (projectId: string) => {
	return useQuery({
		queryFn: () => getParticipantProjectById(projectId),
		queryKey: ["participantProject", projectId],
	});
};

export const useParticipantTutorialCardBySlug = (slug: string) => {
	return useQuery({
		enabled: slug !== "",
		queryFn: () => getParticipantTutorialCardsBySlug(slug),
		queryKey: ["participantTutorialCard", slug],
		select: (data) => (data.length > 0 ? data[0] : null),
	});
};

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
	conversationId: string | undefined,
) => {
	return useQuery({
		enabled: !!conversationId,
		queryFn: () =>
			directus.request(
				readItems("conversation_reply", {
					fields: ["id", "content_text", "date_created", "type"],
					filter: { conversation_id: { _eq: conversationId } },
					sort: ["date_created"],
				}),
			),
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
