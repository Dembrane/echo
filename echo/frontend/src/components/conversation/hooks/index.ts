import {
	aggregate,
	createItems,
	deleteItems,
	type Query,
	type QueryFields,
	readItem,
	readItems,
	updateItem,
} from "@directus/sdk";
import { t } from "@lingui/core/macro";
import * as Sentry from "@sentry/react";
import {
	type UseQueryOptions,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { AxiosError } from "axios";
import { toast } from "@/components/common/Toaster";
import {
	addChatContext,
	apiNoAuth,
	deleteChatContext,
	deleteConversationById,
	deselectAllContext,
	getConversationChunkContentLink,
	getConversationContentLink,
	getConversationTranscriptString,
	retranscribeConversation,
	selectAllContext,
} from "@/lib/api";
import { directus } from "@/lib/directus";

export const useInfiniteConversationChunks = (
	conversationId: string,
	options?: {
		initialLimit?: number;
		refetchInterval?: number | false;
	},
) => {
	const defaultOptions = {
		initialLimit: 10,
		refetchInterval: 30000,
	};

	const { initialLimit, refetchInterval } = { ...defaultOptions, ...options };

	return useInfiniteQuery({
		getNextPageParam: (lastPage: { nextOffset?: number }) =>
			lastPage.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			const response = await directus.request(
				readItems("conversation_chunk", {
					fields: [
						"id",
						"conversation_id",
						"transcript",
						"path",
						"timestamp",
						"error",
						"diarization",
					],
					filter: {
						conversation_id: {
							_eq: conversationId,
						},
					},
					limit: initialLimit,
					offset: pageParam * initialLimit,
					sort: ["timestamp"],
				}),
			);

			return {
				chunks: response,
				nextOffset:
					response.length === initialLimit ? pageParam + 1 : undefined,
			};
		},
		queryKey: ["conversations", conversationId, "chunks", "infinite"],
		refetchInterval,
	});
};

export const useUpdateConversationByIdMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			payload,
		}: {
			id: string;
			payload: Partial<Conversation>;
		}) =>
			directus.request<Conversation>(updateItem("conversation", id, payload)),
		onSuccess: (values, variables) => {
			queryClient.setQueryData(
				["conversations", variables.id],
				(oldData: Conversation | undefined) => {
					return {
						...oldData,
						...values,
					};
				},
			);
			queryClient.invalidateQueries({
				queryKey: ["conversations"],
			});
		},
	});
};

// you always need to provide all the tags
export const useUpdateConversationTagsMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			conversationId,
			projectId,
			projectTagIdList,
		}: {
			projectId: string;
			conversationId: string;
			projectTagIdList: string[];
		}) => {
			let validTagsIds: string[] = [];
			try {
				const validTags = await directus.request<ProjectTag[]>(
					readItems("project_tag", {
						fields: ["id"],
						filter: {
							id: {
								_in: projectTagIdList,
							},
							project_id: {
								_eq: projectId,
							},
						},
					}),
				);

				validTagsIds = validTags.map((tag) => tag.id);
			} catch (_error) {
				validTagsIds = [];
			}

			const tagsRequest = await directus.request(
				readItems("conversation_project_tag", {
					fields: [
						"id",
						{
							project_tag_id: ["id"],
						},
					],
					filter: {
						conversation_id: { _eq: conversationId },
					},
				}),
			);

			const needToDelete = tagsRequest.filter(
				(conversationProjectTag) =>
					conversationProjectTag.project_tag_id &&
					!validTagsIds.includes(
						(conversationProjectTag.project_tag_id as ProjectTag).id,
					),
			);

			const needToCreate = validTagsIds.filter(
				(tagId) =>
					!tagsRequest.some(
						(conversationProjectTag) =>
							(conversationProjectTag.project_tag_id as ProjectTag).id ===
							tagId,
					),
			);

			// slightly esoteric, but basically we only want to delete if there are any tags to delete
			// otherwise, directus doesn't accept an empty array
			const deletePromise =
				needToDelete.length > 0
					? directus.request(
							deleteItems(
								"conversation_project_tag",
								needToDelete.map((tag) => tag.id),
							),
						)
					: Promise.resolve();

			// same deal for creating
			const createPromise =
				needToCreate.length > 0
					? directus.request(
							createItems(
								"conversation_project_tag",
								needToCreate.map((tagId) => ({
									conversation_id: {
										id: conversationId,
									} as Conversation,
									project_tag_id: {
										id: tagId,
									} as ProjectTag,
								})),
							),
						)
					: Promise.resolve();

			// await both promises
			await Promise.all([deletePromise, createPromise]);

			return directus.request<Conversation>(
				readItem("conversation", conversationId, {
					fields: ["*"],
				}),
			);
		},
		onSuccess: (_values, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", variables.conversationId],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.projectId],
			});
		},
	});
};

export const useDeleteConversationByIdMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: deleteConversationById,
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["projects"],
			});
			queryClient.invalidateQueries({
				queryKey: ["conversations"],
			});
			toast.success("Conversation deleted successfully");
		},
	});
};

export const useMoveConversationMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			conversationId,
			targetProjectId,
		}: {
			conversationId: string;
			targetProjectId: string;
		}) => {
			try {
				await directus.request(
					updateItem("conversation", conversationId, {
						project_id: targetProjectId,
					}),
				);
			} catch (_error) {
				toast.error("Failed to move conversation.");
			}
		},
		onError: (error: Error) => {
			toast.error(`Failed to move conversation: ${error.message}`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["conversations"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Conversation moved successfully");
		},
	});
};

export const useAddChatContextMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			chatId: string;
			conversationId?: string;
			auto_select_bool?: boolean;
		}) =>
			addChatContext(payload.chatId, {
				auto_select_bool: payload.auto_select_bool,
				conversationId: payload.conversationId,
			}),
		onError: (error, variables, context) => {
			Sentry.captureException(error);

			// Only rollback the failed optimistic entry
			if ((context as any)?.optimisticId && (context as any)?.conversationId) {
				queryClient.setQueryData(
					["chats", "context", variables.chatId],
					(oldData: TProjectChatContext | undefined) => {
						if (!oldData) return oldData;
						return {
							...oldData,
							conversations: oldData.conversations.filter(
								(conv) =>
									conv.conversation_id !== (context as any).conversationId ||
									conv.optimisticId !== (context as any).optimisticId,
							),
						};
					},
				);
			} else if ((context as any)?.previousChatContext) {
				// fallback: full rollback
				queryClient.setQueryData(
					["chats", "context", variables.chatId],
					(context as any).previousChatContext,
				);
			}
			if (error instanceof AxiosError) {
				let errorMessage = t`Failed to add conversation to chat${
					error.response?.data?.detail ? `: ${error.response.data.detail}` : ""
				}`;
				if (variables.auto_select_bool) {
					errorMessage = t`Failed to enable Auto Select for this chat`;
				}
				toast.error(errorMessage);
			} else {
				let errorMessage = t`Failed to add conversation to chat`;
				if (variables.auto_select_bool) {
					errorMessage = t`Failed to enable Auto Select for this chat`;
				}
				toast.error(errorMessage);
			}
		},
		onMutate: async (variables) => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({
				queryKey: ["chats", "context", variables.chatId],
			});

			// Snapshot the previous value
			const previousChatContext = queryClient.getQueryData([
				"chats",
				"context",
				variables.chatId,
			]);

			// Optimistically update the chat context
			let optimisticId: string | undefined;
			queryClient.setQueryData(
				["chats", "context", variables.chatId],
				(oldData: TProjectChatContext | undefined) => {
					if (!oldData) return oldData;

					// If conversationId is provided, add it to the conversations array
					if (variables.conversationId) {
						const existingConversation = oldData.conversations.find(
							(conv) => conv.conversation_id === variables.conversationId,
						);

						if (!existingConversation) {
							optimisticId = `optimistic-${Date.now()}${Math.random()}`;
							return {
								...oldData,
								conversations: [
									...oldData.conversations,
									{
										conversation_id: variables.conversationId,
										conversation_participant_name: t`Loading...`,
										locked: false,
										optimisticId,
										token_usage: 0,
									},
								],
							};
						}
					}

					// If auto_select_bool is provided, update it
					if (variables.auto_select_bool !== undefined) {
						return {
							...oldData,
							auto_select_bool: variables.auto_select_bool,
						};
					}

					return oldData;
				},
			);

			// Return a context object with the snapshotted value
			return {
				conversationId: variables.conversationId ?? undefined,
				optimisticId,
				previousChatContext,
			};
		},
		onSettled: (_, __, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", variables.chatId],
			});
		},
		onSuccess: (data: AddContextResponse, variables) => {
			// Update selected_all state in query cache
			queryClient.setQueryData(
				["chats", "selectedAll", variables.chatId],
				data.selected_all,
			);

			const message = variables.auto_select_bool
				? t`Auto-select enabled`
				: t`Conversation added to chat`;
			toast.success(message);
		},
	});
};

// Hook to get the selected_all state for a chat
export const useSelectedAllState = (chatId: string) => {
	return useQuery({
		enabled: !!chatId,
		queryFn: () => false, // Default to false, will be updated by mutations
		queryKey: ["chats", "selectedAll", chatId],
		staleTime: Number.POSITIVE_INFINITY, // Never stale, only updated by mutations
	});
};

export const useDeleteChatContextMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			chatId: string;
			conversationId?: string;
			auto_select_bool?: boolean;
		}) =>
			deleteChatContext(payload.chatId, {
				auto_select_bool: payload.auto_select_bool,
				conversationId: payload.conversationId,
			}),
		onError: (error, variables, context) => {
			Sentry.captureException(error);

			// Only rollback the failed optimistic entry
			const conversationId = (context as { conversationId?: string })
				?.conversationId;
			const previousChatContext = (
				context as { previousChatContext?: TProjectChatContext }
			)?.previousChatContext;

			if (conversationId) {
				queryClient.setQueryData(
					["chats", "context", variables.chatId],
					(oldData: TProjectChatContext | undefined) => {
						if (!oldData) return oldData;

						const removedConversation = (
							previousChatContext as TProjectChatContext | undefined
						)?.conversations?.find(
							(conv) => conv.conversation_id === conversationId,
						);

						if (removedConversation) {
							return {
								...oldData,
								conversations: [
									...oldData.conversations,
									{
										...removedConversation,
									},
								],
							};
						}

						return oldData;
					},
				);
			} else if (previousChatContext) {
				// fallback: full rollback
				queryClient.setQueryData(
					["chats", "context", variables.chatId],
					previousChatContext,
				);
			}

			if (error instanceof AxiosError) {
				let errorMessage = t`Failed to remove conversation from chat${
					error.response?.data?.detail ? `: ${error.response.data.detail}` : ""
				}`;
				if (variables.auto_select_bool === false) {
					errorMessage = t`Failed to disable Auto Select for this chat`;
				}
				toast.error(errorMessage);
			} else {
				let errorMessage = t`Failed to remove conversation from chat`;
				if (variables.auto_select_bool === false) {
					errorMessage = t`Failed to disable Auto Select for this chat`;
				}
				toast.error(errorMessage);
			}
		},
		onMutate: async (variables) => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({
				queryKey: ["chats", "context", variables.chatId],
			});

			// Snapshot the previous value
			const previousChatContext = queryClient.getQueryData([
				"chats",
				"context",
				variables.chatId,
			]);

			// Optimistically update the chat context
			queryClient.setQueryData(
				["chats", "context", variables.chatId],
				(oldData: TProjectChatContext | undefined) => {
					if (!oldData) return oldData;

					// If conversationId is provided, remove it from the conversations array
					if (variables.conversationId) {
						const conversationToRemove = oldData.conversations.find(
							(conv) => conv.conversation_id === variables.conversationId,
						);

						if (conversationToRemove) {
							return {
								...oldData,
								conversations: oldData.conversations.filter(
									(conv) => conv.conversation_id !== variables.conversationId,
								),
							};
						}
					}

					// If auto_select_bool is provided, update it
					if (variables.auto_select_bool !== undefined) {
						return {
							...oldData,
							auto_select_bool: variables.auto_select_bool,
						};
					}

					return oldData;
				},
			);

			// Return a context object with the snapshotted value
			return {
				conversationId: variables.conversationId ?? undefined,
				previousChatContext,
			};
		},
		onSettled: (_, __, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", variables.chatId],
			});
		},
		onSuccess: (data: DeleteContextResponse, variables) => {
			// Update selected_all state in query cache (will be false after removing a conversation)
			queryClient.setQueryData(
				["chats", "selectedAll", variables.chatId],
				data.selected_all,
			);

			const message =
				variables.auto_select_bool === false
					? t`Auto-select disabled`
					: t`Conversation removed from chat`;
			toast.success(message);
		},
	});
};

export const useSelectAllContextMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { chatId: string; projectId: string }) =>
			selectAllContext(payload.chatId, payload.projectId),
		onError: (error) => {
			Sentry.captureException(error);
		},
		onSettled: (_, __, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", variables.chatId],
			});
		},
		onSuccess: (data: SelectAllContextResponse, variables) => {
			// Update selected_all state in query cache
			queryClient.setQueryData(
				["chats", "selectedAll", variables.chatId],
				data.selected_all,
			);
		},
	});
};

export const useDeselectAllContextMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { chatId: string }) =>
			deselectAllContext(payload.chatId),
		onError: (error) => {
			Sentry.captureException(error);
		},
		onSettled: (_, __, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", variables.chatId],
			});
		},
		onSuccess: (data: DeselectAllContextResponse, variables) => {
			// Update selected_all state in query cache
			queryClient.setQueryData(
				["chats", "selectedAll", variables.chatId],
				data.selected_all,
			);
		},
	});
};

export const useConversationChunkContentUrl = (
	conversationId: string,
	chunkId: string,
	enabled = true,
) => {
	return useQuery({
		enabled,
		gcTime: 1000 * 60 * 60, // 1 hour
		queryFn: async () => {
			const url = getConversationChunkContentLink(
				conversationId,
				chunkId,
				true,
			);
			return apiNoAuth.get<unknown, string>(url);
		},
		queryKey: ["conversation", conversationId, "chunk", chunkId, "audio-url"],
		staleTime: 1000 * 60 * 30, // 30 minutes
	});
};

export const useConversationContentUrl = (
	conversationId: string,
	enabled = true,
) => {
	return useQuery({
		enabled,
		gcTime: 1000 * 60 * 60, // 1 hour
		queryFn: async () => {
			const url = getConversationContentLink(conversationId, true);
			return url;
		},
		queryKey: ["conversation", conversationId, "merged-audio-url"],
		staleTime: 1000 * 60 * 30, // 30 minutes
	});
};

export const useRetranscribeConversationMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			conversationId,
			newConversationName,
			usePiiRedaction,
		}: {
			conversationId: string;
			newConversationName: string;
			usePiiRedaction: boolean;
		}) =>
			retranscribeConversation(
				conversationId,
				newConversationName,
				usePiiRedaction,
			),
		onError: (error) => {
			toast.error(t`Failed to retranscribe conversation. Please try again.`);
			console.error("Retranscribe error:", error);
		},
		onSuccess: (_data) => {
			// Invalidate all conversation related queries
			queryClient.invalidateQueries({
				queryKey: ["conversations"],
			});
		},
	});
};

export const useGetConversationTranscriptStringMutation = () => {
	return useMutation({
		mutationFn: (conversationId: string) =>
			getConversationTranscriptString(conversationId),
	});
};

export const useConversationChunks = (
	conversationId: string,
	refetchInterval = 10000,
	fields: string[] = ["id"],
) => {
	return useQuery({
		queryFn: () =>
			directus.request(
				readItems("conversation_chunk", {
					fields: fields as any,
					filter: {
						conversation_id: {
							_eq: conversationId,
						},
					},
					limit: 1, // Only need to check if chunks exist
					sort: "timestamp",
				}),
			),
		queryKey: ["conversations", conversationId, "chunks"],
		refetchInterval,
	});
};

export const useConversationsByProjectId = (
	projectId: string,
	loadChunks?: boolean,
	// unused
	loadWhereTranscriptExists?: boolean,
	query?: Partial<Query<CustomDirectusTypes, Conversation>>,
	filterBySource?: string[],
) => {
	const TIME_INTERVAL_SECONDS = 30;

	return useQuery({
		queryFn: async () => {
			const conversations = await directus.request(
				readItems("conversation", {
					deep: {
						chunks: {
							_limit: loadChunks ? 1000 : 1,
							_sort: ["-timestamp", "-created_at"],
						},
					},
					fields: [
						...CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS,
						{
							tags: [
								{
									project_tag_id: ["id", "text", "created_at"],
								},
							],
						},
						{
							chunks: [
								"id",
								"conversation_id",
								"transcript",
								"source",
								"path",
								"timestamp",
								"created_at",
								"error",
							],
						},
					],
					// @ts-expect-error TODO
					filter: {
						chunks: {
							...(loadWhereTranscriptExists && {
								_some: {
									transcript: {
										_nempty: true,
									},
								},
							}),
						},
						project_id: {
							_eq: projectId,
						},
						...(filterBySource && {
							source: {
								_in: filterBySource,
							},
						}),
					},
					limit: 1000,
					sort: "-updated_at",
					...query,
				}),
			);

			return conversations;
		},
		queryKey: [
			"projects",
			projectId,
			"conversations",
			loadChunks ? "chunks" : "no-chunks",
			loadWhereTranscriptExists ? "transcript" : "no-transcript",
			query,
			filterBySource,
		],
		refetchInterval: 30000,
		select: (data) => {
			// Add live field to each conversation based on recent chunk activity
			const cutoffTime = new Date(Date.now() - TIME_INTERVAL_SECONDS * 1000);

			if (data.length === 0) return [];

			return data.map((conversation) => {
				// Skip upload chunks
				if (["upload", "clone"].includes(conversation.source ?? ""))
					return {
						...conversation,
						live: false,
					};

				if (conversation.chunks?.length === 0)
					return {
						...conversation,
						live: false,
					};

				const hasRecentChunks = conversation.chunks?.some((chunk: any) => {
					// Check if chunk timestamp is recent
					const chunkTime = new Date(chunk.timestamp || chunk.created_at || 0);
					return chunkTime > cutoffTime;
				});

				return {
					...conversation,
					live: hasRecentChunks || false,
				};
			});
		},
	});
};

export const CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS: QueryFields<
	CustomDirectusTypes,
	Conversation
> = [
	"id",
	"created_at",
	"updated_at",
	"project_id",
	"participant_name",
	"participant_email",
	"tags",
	"summary",
	"source",
	"chunks",
	"duration",
	"is_finished",
	"is_audio_processing_finished",
	"linked_conversations",
	"linking_conversations",
];

export const useConversationById = ({
	conversationId,
	loadConversationChunks = false,
	query = {},
	useQueryOpts = {
		refetchInterval: 10000,
	},
}: {
	conversationId: string;
	loadConversationChunks?: boolean;
	// query overrides the default query and loadChunks
	query?: Partial<Query<CustomDirectusTypes, Conversation>>;
	useQueryOpts?: Partial<UseQueryOptions<Conversation>>;
}) => {
	return useQuery({
		queryFn: () =>
			directus.request<Conversation>(
				readItem("conversation", conversationId, {
					// @ts-expect-error TODO
					fields: [
						...CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS,
						{
							linking_conversations: [
								"id",
								{
									source_conversation_id: ["id", "participant_name"],
								},
								"link_type",
							],
						},
						{
							linked_conversations: [
								"id",
								{
									target_conversation_id: ["id", "participant_name"],
								},
								"link_type",
							],
						},
						{
							tags: [
								{
									project_tag_id: ["id", "text"],
								},
							],
						},
						...(loadConversationChunks
							? [
									{
										chunks: [
											"id",
											"conversation_id",
											"transcript",
											"source",
											"path",
											"timestamp",
											"created_at",
											"error",
										],
									},
								]
							: []),
					],
					...query,
				}),
			),
		queryKey: ["conversations", conversationId, loadConversationChunks, query],
		...useQueryOpts,
	});
};

export const useInfiniteConversationsByProjectId = (
	projectId: string,
	loadChunks?: boolean,
	// unused
	loadWhereTranscriptExists?: boolean,
	query?: Partial<Query<CustomDirectusTypes, Conversation>>,
	filterBySource?: string[],
	options?: {
		initialLimit?: number;
	},
) => {
	const { initialLimit = 15 } = options ?? {};
	const TIME_INTERVAL_SECONDS = 30;

	return useInfiniteQuery({
		getNextPageParam: (lastPage: { nextOffset?: number }) =>
			lastPage.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			const conversations = await directus.request(
				readItems("conversation", {
					deep: {
						chunks: {
							_limit: loadChunks ? 1000 : 1,
							_sort: ["-timestamp", "-created_at"],
						},
					},
					fields: [
						...CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS,
						{
							tags: [
								{
									project_tag_id: ["id", "text"],
								},
							],
						},
						{
							chunks: [
								"id",
								"conversation_id",
								"transcript",
								"source",
								"path",
								"timestamp",
								"created_at",
								"error",
							],
						},
						{
							conversation_artifacts: ["id", "approved_at"],
						},
					],
					// @ts-expect-error TODO
					filter: {
						chunks: {
							...(loadWhereTranscriptExists && {
								_some: {
									transcript: {
										_nempty: true,
									},
								},
							}),
						},
						project_id: {
							_eq: projectId,
						},
						...(filterBySource && {
							source: {
								_in: filterBySource,
							},
						}),
					},
					limit: initialLimit,
					offset: pageParam * initialLimit,
					sort: "-updated_at",
					...query,
				}),
			);

			return {
				conversations: conversations,
				nextOffset:
					conversations.length === initialLimit ? pageParam + 1 : undefined,
			};
		},
		queryKey: [
			"projects",
			projectId,
			"conversations",
			"infinite",
			loadChunks ? "chunks" : "no-chunks",
			loadWhereTranscriptExists ? "transcript" : "no-transcript",
			query,
			filterBySource,
		],
		refetchInterval: 30000,
		select: (data) => {
			// Add live field to each conversation based on recent chunk activity
			const cutoffTime = new Date(Date.now() - TIME_INTERVAL_SECONDS * 1000);

			return {
				...data,
				pages: data.pages.map((page) => ({
					...page,
					conversations: page.conversations.map((conversation) => {
						// Skip upload chunks
						if (["upload", "clone"].includes(conversation.source ?? ""))
							return {
								...conversation,
								live: false,
							};

						if (conversation.chunks?.length === 0)
							return {
								...conversation,
								live: false,
							};

						const hasRecentChunks = conversation.chunks?.some((chunk: any) => {
							// Check if chunk timestamp is recent
							const chunkTime = new Date(
								chunk.timestamp || chunk.created_at || 0,
							);
							return chunkTime > cutoffTime;
						});

						return {
							...conversation,
							live: hasRecentChunks || false,
						};
					}),
				})),
			};
		},
	});
};

export const useConversationsCountByProjectId = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, Conversation>>,
) => {
	return useQuery({
		queryFn: async () => {
			const response = await directus.request(
				aggregate("conversation", {
					aggregate: {
						count: "*",
					},
					query: {
						filter: {
							project_id: {
								_eq: projectId,
							},
							...(query?.filter && query.filter),
						},
					},
				}),
			);
			return response[0].count;
		},
		queryKey: ["projects", projectId, "conversations", "count", query],
	});
};

export const useConversationHasTranscript = (
	conversationId: string,
	refetchInterval = 10000,
	enabled = true,
) => {
	return useQuery({
		enabled: enabled,
		queryFn: async () => {
			const response = await directus.request(
				aggregate("conversation_chunk", {
					aggregate: {
						count: "*",
					},
					query: {
						filter: {
							_and: [
								{
									conversation_id: {
										_eq: conversationId,
									},
								},
								{
									transcript: {
										_nnull: true,
									},
								},
								{
									transcript: {
										_nempty: true,
									},
								},
							],
						},
					},
				}),
			);
			const count = response[0]?.count;
			return typeof count === "number" ? count : Number(count) || 0;
		},
		queryKey: ["conversations", conversationId, "chunks", "transcript-count"],
		refetchInterval,
	});
};
