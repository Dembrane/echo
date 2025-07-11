import { getChatHistory, lockConversations } from "@/lib/api";
import { directus } from "@/lib/directus";
import { createItem, deleteItem, updateItem } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
