import type { Query } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import {
	useMutation,
	useQuery,
	useQueryClient,
	useSuspenseInfiniteQuery,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import {
	type ChatMode,
	deleteChatById,
	getChatHistory,
	getChatSuggestions,
	getProjectChatContext,
	initializeChatMode,
	lockConversations,
} from "@/lib/api";
import { bff } from "@/lib/bff";

export const useChatHistory = (chatId: string) => {
	return useQuery({
		enabled: chatId !== "",
		queryFn: () => getChatHistory(chatId),
		queryKey: ["chats", "history", chatId],
	});
};

export const useAddChatMessageMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: Partial<ProjectChatMessage>) =>
			bff.post("/chat-messages", payload),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", vars.project_chat_id],
			});
			queryClient.invalidateQueries({
				queryKey: ["chats", "history", vars.project_chat_id],
			});
		},
	});
};

export const useLockConversationsMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { chatId: string }) =>
			lockConversations(payload.chatId),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", vars.chatId],
			});
			queryClient.invalidateQueries({
				queryKey: ["chats", "history", vars.chatId],
			});
		},
	});
};

export const useDeleteChatMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { chatId: string; projectId: string }) =>
			deleteChatById(payload.chatId),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "chats"],
			});
			queryClient.invalidateQueries({
				queryKey: ["chats", vars.chatId],
			});
			toast.success(t`Chat deleted`);
		},
		onError: (error: Error) => {
			toast.error(error.message || t`Failed to delete chat`);
		},
	});
};

export const useUpdateChatMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			chatId: string;
			// for invalidating the chat query
			projectId: string;
			payload: Partial<ProjectChat>;
		}) => {
			// project_id is a side-channel for cache invalidation; the
			// BFF PATCH accepts only name/chat_mode, not project_id.
			const body: Record<string, unknown> = {};
			if (typeof payload.payload?.name === "string") {
				body.name = payload.payload.name;
			}
			if (typeof payload.payload?.chat_mode === "string") {
				body.chat_mode = payload.payload.chat_mode;
			}
			return bff.patch(`/chats/${payload.chatId}`, body);
		},
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "chats"],
			});

			queryClient.invalidateQueries({
				queryKey: ["chats", vars.chatId],
			});
			toast.success("Chat updated successfully");
		},
	});
};

export const useProjectChatContext = (chatId: string) => {
	return useQuery({
		enabled: chatId !== "",
		queryFn: () => getProjectChatContext(chatId),
		queryKey: ["chats", "context", chatId],
	});
};

export const useInitializeChatModeMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: {
			chatId: string;
			mode: ChatMode;
			projectId: string;
		}) => initializeChatMode(payload.chatId, payload.mode, payload.projectId),
		onError: (error) => {
			console.error("Failed to initialize chat mode:", error);
			toast.error("Failed to initialize chat mode. Please try again.");
		},
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", "context", vars.chatId],
			});
			queryClient.invalidateQueries({
				queryKey: ["chats", vars.chatId],
			});
			// Don't show toast here - let the component handle messaging
		},
	});
};

export const useChat = (chatId: string) => {
	return useQuery({
		queryFn: () => bff.get<ProjectChat>(`/chats/${chatId}`),
		queryKey: ["chats", chatId],
	});
};

export const useProjectChats = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
) => {
	return useSuspenseQuery({
		queryFn: async () => {
			void query; // advanced query filter not forwarded to BFF
			const { chats } = await bff.get<{ chats: ProjectChat[]; total: number }>(
				"/chats",
				{ project_id: projectId, limit: 200 },
			);
			return chats;
		},
		queryKey: ["projects", projectId, "chats", query],
	});
};

export const useInfiniteProjectChats = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
	options?: {
		initialLimit?: number;
		hasMessages?: boolean;
	},
) => {
	const { initialLimit = 15, hasMessages = false } = options ?? {};

	return useSuspenseInfiniteQuery({
		getNextPageParam: (lastPage: { nextOffset?: number }) =>
			lastPage?.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			void query;
			const { chats } = await bff.get<{ chats: ProjectChat[]; total: number }>(
				"/chats",
				{
					project_id: projectId,
					limit: initialLimit,
					offset: pageParam * initialLimit,
					...(hasMessages ? { has_messages: true } : {}),
				},
			);

			return {
				chats,
				nextOffset:
					chats.length === initialLimit ? pageParam + 1 : undefined,
			};
		},
		queryKey: [
			"projects",
			projectId,
			"chats",
			"infinite",
			{ query, hasMessages },
		],
		refetchInterval: 30000,
	});
};

export const useProjectChatsCount = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
	options?: { hasMessages?: boolean },
) => {
	const { hasMessages = false } = options ?? {};
	return useSuspenseQuery({
		queryFn: async () => {
			void query;
			const { total } = await bff.get<{ chats: ProjectChat[]; total: number }>(
				"/chats",
				{
					project_id: projectId,
					limit: 1,
					...(hasMessages ? { has_messages: true } : {}),
				},
			);
			return total;
		},
		queryKey: ["projects", projectId, "chats", "count", { query, hasMessages }],
	});
};

export const useProjectChatsTotal = (
	projectId: string,
	options?: { hasMessages?: boolean },
) => {
	const { hasMessages = false } = options ?? {};
	return useQuery({
		enabled: projectId !== "",
		queryFn: async () => {
			const { total } = await bff.get<{ chats: ProjectChat[]; total: number }>(
				"/chats",
				{
					project_id: projectId,
					limit: 1,
					...(hasMessages ? { has_messages: true } : {}),
				},
			);
			return total;
		},
		queryKey: [
			"projects",
			projectId,
			"chats",
			"count",
			{ query: undefined, hasMessages },
		],
	});
};

/**
 * Hook to fetch contextual suggestions for a chat.
 *
 * Lifecycle:
 * - Initial fetch: When chat route mounts AND chat_mode is set
 * - Refetch triggers:
 *   - After assistant response completes (via refetch())
 *   - When conversation selection changes (deep_dive mode)
 * - Stale time: 30 seconds to avoid rapid re-fetches
 * - Error handling: Silent fallback to empty suggestions
 */
export const useChatSuggestions = (
	chatId: string,
	options?: {
		enabled?: boolean;
		language?: string;
	},
) => {
	const { enabled = true, language = "en" } = options ?? {};

	return useQuery({
		enabled: enabled && chatId !== "",
		queryFn: () => getChatSuggestions(chatId, language),
		queryKey: ["chats", chatId, "suggestions", language],
		refetchOnWindowFocus: false,
		retry: 1, // Retry once on failure, then give up gracefully
		staleTime: 30_000, // 30 seconds - avoid rapid re-fetches
	});
};

/**
 * Prefetch suggestions for a chat and wait for them (with timeout).
 * Returns early if suggestions arrive, or after maxWaitMs.
 * Used when navigating to a chat to ensure suggestions are ready.
 */
export const usePrefetchSuggestions = () => {
	const queryClient = useQueryClient();

	return async (chatId: string, language = "en", maxWaitMs = 8000) => {
		const queryKey = ["chats", chatId, "suggestions", language];

		// Start the prefetch
		const prefetchPromise = queryClient.prefetchQuery({
			queryFn: () => getChatSuggestions(chatId, language),
			queryKey,
			staleTime: 30_000,
		});

		// Race between prefetch completing and timeout
		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(resolve, maxWaitMs);
		});

		await Promise.race([prefetchPromise, timeoutPromise]);
	};
};
