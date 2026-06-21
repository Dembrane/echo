import type { Query, QueryFields } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import {
	type UseQueryOptions,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { AxiosError } from "axios";
import posthog from "posthog-js";
import { useProjectChatContext } from "@/components/chat/hooks";
import { toast } from "@/components/common/Toaster";
import {
	addChatContext,
	apiNoAuth,
	deleteChatContext,
	deleteConversationById,
	getConversationChunkContentLink,
	getConversationContentLink,
	getConversationEmails,
	getConversationTranscriptString,
	retranscribeConversation,
	selectAllContext,
} from "@/lib/api";
import { bff } from "@/lib/bff";

type ConversationBffListParams = {
	search_text?: string;
	sort?:
		| "-created_at"
		| "created_at"
		| "-participant_name"
		| "participant_name"
		| "-duration"
		| "duration"
		| "-updated_at"
		| "updated_at";
	tag_ids?: string;
	verified_only?: true;
};

type ConversationQueryFilter = {
	conversation_artifacts?: {
		_some?: {
			approved_at?: {
				_nnull?: unknown;
			};
		};
	};
	tags?: {
		_some?: {
			project_tag_id?: {
				id?: {
					_in?: unknown;
				};
			};
		};
	};
};

const conversationQueryToBffParams = (
	query?: Partial<Query<CustomDirectusTypes, Conversation>>,
): ConversationBffListParams => {
	const params: ConversationBffListParams = {};
	const rawQuery = query as
		| {
				filter?: ConversationQueryFilter;
				search?: unknown;
				sort?: unknown;
		  }
		| undefined;

	const search = rawQuery?.search;
	if (typeof search === "string" && search.trim()) {
		params.search_text = search.trim();
	}

	const sort = Array.isArray(rawQuery?.sort)
		? rawQuery?.sort[0]
		: rawQuery?.sort;
	if (
		sort === "-created_at" ||
		sort === "created_at" ||
		sort === "-participant_name" ||
		sort === "participant_name" ||
		sort === "-duration" ||
		sort === "duration" ||
		sort === "-updated_at" ||
		sort === "updated_at"
	) {
		params.sort = sort;
	}

	const filter = rawQuery?.filter;
	const tagIds = filter?.tags?._some?.project_tag_id?.id?._in;
	if (Array.isArray(tagIds) && tagIds.length > 0) {
		params.tag_ids = tagIds.filter(Boolean).join(",");
	}

	if (filter?.conversation_artifacts?._some?.approved_at?._nnull) {
		params.verified_only = true;
	}

	return params;
};

type AddChatContextMutationContext = {
	conversationId?: string;
	optimisticId?: string;
	previousChatContext?: TProjectChatContext;
};

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
			const response = await bff.get<ConversationChunk[]>(
				`/conversations/${conversationId}/chunks`,
				{
					fields: "id,conversation_id,transcript,path,timestamp,error",
					limit: initialLimit,
					offset: pageParam * initialLimit,
					sort: "timestamp",
				},
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
		}) => bff.patch<Conversation>(`/conversations/${id}`, payload),
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
			// Delegates add + remove delta to the server — it validates
			// every tag belongs to the project, computes the diff, and
			// returns the fresh junction list.
			await bff.post("/conversation-project-tags/replace", {
				conversation_id: conversationId,
				project_tag_ids: projectTagIdList,
			});
			// Project id is a side-channel for cache invalidation; the
			// server doesn't need it but we keep the arg name stable.
			void projectId;
			return bff.get<Conversation>(`/conversations/${conversationId}`);
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
				await bff.post(`/conversations/${conversationId}/move`, {
					target_project_id: targetProjectId,
				});
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

export const useBulkMoveConversationsMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			conversationIds,
			targetProjectId,
		}: {
			conversationIds: string[];
			targetProjectId: string;
		}) => {
			// Let errors propagate so onError fires and the modal stays open on
			// a permission failure (all-or-nothing on the server).
			return bff.post("/conversations/bulk-move", {
				conversation_ids: conversationIds,
				target_project_id: targetProjectId,
			});
		},
		onError: (error: Error) => {
			toast.error(`Couldn't move conversations: ${error.message}`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["conversations"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Conversations moved");
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
		mutationKey: ["chat-context", "add"],
		onError: (error, variables, context) => {
			posthog.captureException(error);
			const mutationContext = context as
				| AddChatContextMutationContext
				| undefined;

			// Only rollback the failed optimistic entry
			if (mutationContext?.optimisticId && mutationContext.conversationId) {
				queryClient.setQueryData(
					["chats", "context", variables.chatId],
					(oldData: TProjectChatContext | undefined) => {
						if (!oldData) return oldData;
						return {
							...oldData,
							conversations: oldData.conversations.filter(
								(conv) =>
									conv.conversation_id !== mutationContext.conversationId ||
									conv.optimisticId !== mutationContext.optimisticId,
							),
						};
					},
				);
			} else if (mutationContext?.previousChatContext) {
				// fallback: full rollback
				queryClient.setQueryData(
					["chats", "context", variables.chatId],
					mutationContext.previousChatContext,
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
		onSuccess: (_, variables) => {
			const message = variables.auto_select_bool
				? t`Auto-select enabled`
				: t`Conversation added to chat`;
			toast.success(message);
		},
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
			deleteChatContext(
				payload.chatId,
				payload.conversationId,
				payload.auto_select_bool,
			),
		mutationKey: ["chat-context", "delete"],
		onError: (error, variables, context) => {
			posthog.captureException(error);
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
		onSuccess: (_, variables) => {
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
		mutationFn: (payload: {
			chatId: string;
			projectId: string;
			tagIds?: string[];
			verifiedOnly?: boolean;
			searchText?: string;
		}) =>
			selectAllContext(payload.chatId, payload.projectId, {
				searchText: payload.searchText,
				tagIds: payload.tagIds,
				verifiedOnly: payload.verifiedOnly,
			}),
		onSettled: (_, __, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", variables.chatId],
			});
			// Also invalidate the remaining conversations count query
			queryClient.invalidateQueries({
				queryKey: [
					"projects",
					variables.projectId,
					"chats",
					variables.chatId,
					"remaining-conversations-count",
				],
			});
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
			attachVerifiedArtifacts,
		}: {
			conversationId: string;
			newConversationName: string;
			usePiiRedaction: boolean;
			attachVerifiedArtifacts?: boolean;
		}) =>
			retranscribeConversation(
				conversationId,
				newConversationName,
				usePiiRedaction,
				attachVerifiedArtifacts,
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
			bff.get<unknown[]>(`/conversations/${conversationId}/chunks`, {
				fields: fields.join(","),
				limit: 1,
				sort: "timestamp",
			}),
		queryKey: ["conversations", conversationId, "chunks"],
		refetchInterval,
	});
};

export const useConversationEmails = (
	conversationId: string,
	enabled = true,
) => {
	return useQuery({
		enabled: enabled && !!conversationId,
		queryFn: () => getConversationEmails(conversationId),
		queryKey: ["conversations", conversationId, "emails"],
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
			void loadWhereTranscriptExists;
			const params = conversationQueryToBffParams(query);
			const conversations = await bff.get<Conversation[]>("/conversations", {
				include_chunks: Boolean(loadChunks),
				include_tags: true,
				limit: 1000,
				project_id: projectId,
				sources: filterBySource?.join(","),
				...params,
			});
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
			// Add live field based on the server-derived last_chunk_at
			const cutoffTime = new Date(Date.now() - TIME_INTERVAL_SECONDS * 1000);

			if (data.length === 0) return [];

			return data.map((conversation) => {
				// Only portal sessions can show as live/Ongoing
				if (
					!["PORTAL_AUDIO", "PORTAL_TEXT"].includes(conversation.source ?? "")
				)
					return {
						...conversation,
						live: false,
					};

				const lastChunkAt = conversation.last_chunk_at;
				return {
					...conversation,
					live: lastChunkAt ? new Date(lastChunkAt) > cutoffTime : false,
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
	"title",
	"tags",
	"summary",
	"source",
	"chunks",
	"duration",
	"is_finished",
	"is_audio_processing_finished",
	"is_anonymized",
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
		queryFn: async () => {
			void query; // reserved for future fields param on BFF
			return bff.get<Conversation>(`/conversations/${conversationId}`, {
				include_chunks: loadConversationChunks,
				include_tags: true,
			});
		},
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
			const params = conversationQueryToBffParams(query);
			const conversations = await bff.get<Conversation[]>("/conversations", {
				include_chunks: Boolean(loadChunks),
				include_tags: true,
				limit: initialLimit,
				offset: pageParam * initialLimit,
				project_id: projectId,
				sources: filterBySource?.join(","),
				transcript_required: Boolean(loadWhereTranscriptExists),
				...params,
			});

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
			// Add live field based on the server-derived last_chunk_at
			const cutoffTime = new Date(Date.now() - TIME_INTERVAL_SECONDS * 1000);

			return {
				...data,
				pages: data.pages.map((page) => ({
					...page,
					conversations: page.conversations.map((conversation) => {
						// Only portal sessions can show as live/Ongoing
						if (
							!["PORTAL_AUDIO", "PORTAL_TEXT"].includes(
								conversation.source ?? "",
							)
						)
							return {
								...conversation,
								live: false,
							};

						const lastChunkAt = conversation.last_chunk_at;
						return {
							...conversation,
							live: lastChunkAt ? new Date(lastChunkAt) > cutoffTime : false,
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
			const params = conversationQueryToBffParams(query);
			const { count } = await bff.get<{ count: number }>(
				"/conversations/count",
				{ project_id: projectId, ...params },
			);
			return count;
		},
		queryKey: ["projects", projectId, "conversations", "count", query],
	});
};

export const useRemainingConversationsCount = (
	projectId: string,
	chatId: string | undefined,
	filters?: {
		tagIds?: string[];
		verifiedOnly?: boolean;
		searchText?: string;
	},
	options?: {
		enabled?: boolean;
	},
) => {
	const chatContextQuery = useProjectChatContext(chatId ?? "");

	return useQuery({
		// Wait for chat context to be loaded before running this query
		enabled:
			!!chatId &&
			!!projectId &&
			!chatContextQuery.isLoading &&
			chatContextQuery.data !== undefined &&
			options?.enabled !== false,
		queryFn: async () => {
			const conversationsInContext = chatContextQuery.data?.conversations ?? [];
			const conversationIdsInContext = Array.from(
				new Set(conversationsInContext.map((c) => c.conversation_id)),
			);
			const { count } = await bff.get<{ count: number }>(
				"/conversations/remaining-count",
				{
					exclude_ids:
						conversationIdsInContext.length > 0
							? conversationIdsInContext.join(",")
							: undefined,
					project_id: projectId,
					search_text: filters?.searchText?.trim() || undefined,
					tag_ids:
						filters?.tagIds && filters.tagIds.length > 0
							? filters.tagIds.join(",")
							: undefined,
					verified_only: filters?.verifiedOnly ? true : undefined,
				},
			);
			return count;
		},
		queryKey: [
			"projects",
			projectId,
			"chats",
			chatId,
			"remaining-conversations-count",
			filters,
			// Include the conversation IDs in context in the query key so it refetches when context changes
			chatContextQuery.data?.conversations
				?.map((c) => c.conversation_id)
				.sort(),
		],
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
			const { count } = await bff.get<{ count: number }>(
				`/conversations/${conversationId}/chunk-count`,
				{ transcript_required: true },
			);
			return count;
		},
		queryKey: ["conversations", conversationId, "chunks", "transcript-count"],
		refetchInterval,
	});
};
