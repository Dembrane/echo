import {
	aggregate,
	createItem,
	deleteItem,
	type Query,
	readItem,
	readItems,
	updateItem,
} from "@directus/sdk";
import {
	useMutation,
	useQuery,
	useQueryClient,
	useSuspenseInfiniteQuery,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import {
	getChatHistory,
	getProjectChatContext,
	lockConversations,
} from "@/lib/api";
import { directus } from "@/lib/directus";

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
			directus.request(createItem("project_chat_message", payload as any)),
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
			directus.request(deleteItem("project_chat", payload.chatId)),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "chats"],
			});
			queryClient.invalidateQueries({
				queryKey: ["chats", vars.chatId],
			});
			toast.success("Chat deleted successfully");
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
		}) =>
			directus.request(
				updateItem("project_chat", payload.chatId, {
					project_id: {
						id: payload.projectId,
					},
					...payload.payload,
				}),
			),
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

export const useChat = (chatId: string) => {
	return useQuery({
		queryFn: () =>
			directus.request(
				readItem("project_chat", chatId, {
					// Only fetch fields used in chat UI: id, name, project_id
					fields: ["id", "name", "project_id"],
				}),
			),
		queryKey: ["chats", chatId],
	});
};

export const useProjectChats = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
) => {
	return useSuspenseQuery({
		queryFn: () =>
			directus.request(
				readItems("project_chat", {
					fields: ["id", "project_id", "date_created", "date_updated", "name"],
					filter: {
						project_id: {
							_eq: projectId,
						},
					},
					sort: "-date_created",
					...query,
				}),
			),
		queryKey: ["projects", projectId, "chats", query],
	});
};

export const useInfiniteProjectChats = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
	options?: {
		initialLimit?: number;
	},
) => {
	const { initialLimit = 15 } = options ?? {};

	return useSuspenseInfiniteQuery({
		getNextPageParam: (lastPage: { nextOffset?: number }) =>
			lastPage?.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			const response = await directus.request(
				readItems("project_chat", {
					fields: ["id", "project_id", "date_created", "date_updated", "name"],
					filter: {
						project_id: {
							_eq: projectId,
						},
						...(query?.filter && query.filter),
					},
					limit: initialLimit,
					offset: pageParam * initialLimit,
					sort: "-date_created",
					...query,
				}),
			);

			return {
				chats: response,
				nextOffset:
					response.length === initialLimit ? pageParam + 1 : undefined,
			};
		},
		queryKey: ["projects", projectId, "chats", "infinite", query],
		refetchInterval: 30000,
	});
};

export const useProjectChatsCount = (
	projectId: string,
	query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
) => {
	return useSuspenseQuery({
		queryFn: async () => {
			const response = await directus.request(
				aggregate("project_chat", {
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
		queryKey: ["projects", projectId, "chats", "count", query],
	});
};
