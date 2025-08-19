import {
  getChatHistory,
  getProjectChatContext,
  lockConversations,
} from "@/lib/api";
import { directus } from "@/lib/directus";
import {
  Query,
  aggregate,
  createItem,
  deleteItem,
  readItem,
  readItems,
  updateItem,
} from "@directus/sdk";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";

export const useChatHistory = (chatId: string) => {
  return useQuery({
    queryKey: ["chats", "history", chatId],
    queryFn: () => getChatHistory(chatId ?? ""),
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
    queryKey: ["chats", "context", chatId],
    queryFn: () => getProjectChatContext(chatId),
    enabled: chatId !== "",
  });
};

export const useChat = (chatId: string) => {
  return useQuery({
    queryKey: ["chats", chatId],
    queryFn: () =>
      directus.request(
        readItem("project_chat", chatId, {
          fields: [
            "*",
            {
              used_conversations: ["*"],
            },
          ],
        }),
      ),
  });
};

export const useProjectChats = (
  projectId: string,
  query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
) => {
  return useSuspenseQuery({
    queryKey: ["projects", projectId, "chats", query],
    queryFn: () =>
      directus.request(
        readItems("project_chat", {
          fields: ["id", "project_id", "date_created", "date_updated", "name"],
          sort: "-date_created",
          filter: {
            project_id: {
              _eq: projectId,
            },
          },
          ...query,
        }),
      ),
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

  return useInfiniteQuery({
    queryKey: ["projects", projectId, "chats", "infinite", query],
    queryFn: async ({ pageParam = 0 }) => {
      const response = await directus.request(
        readItems("project_chat", {
          fields: ["id", "project_id", "date_created", "date_updated", "name"],
          sort: "-date_created",
          filter: {
            project_id: {
              _eq: projectId,
            },
            ...(query?.filter && query.filter),
          },
          limit: initialLimit,
          offset: pageParam * initialLimit,
          ...query,
        }),
      );

      return {
        chats: response,
        nextOffset:
          response.length === initialLimit ? pageParam + 1 : undefined,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });
};

export const useProjectChatsCount = (
  projectId: string,
  query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
) => {
  return useSuspenseQuery({
    queryKey: ["projects", projectId, "chats", "count", query],
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
  });
};
