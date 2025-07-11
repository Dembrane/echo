import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createItem, deleteItem, readItem, updateItem } from "@directus/sdk";
import { directus } from "@/lib/directus";
import { toast } from "@/components/common/Toaster";
import { addChatContext } from "@/lib/api";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

export const useDeleteProjectByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      directus.request(deleteItem("project", projectId)),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.resetQueries();
      toast.success("Project deleted successfully");
    },
  });
};

export const useCreateProjectTagMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      project_id: {
        id: string;
        directus_user_id: string;
      };
      text: string;
      sort?: number;
    }) => directus.request(createItem("project_tag", payload as any)),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", variables.project_id.id],
      });
      toast.success("Tag created successfully");
    },
  });
};

export const useUpdateProjectTagByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      project_id: string;
      payload: Partial<ProjectTag>;
    }) => directus.request<ProjectTag>(updateItem("project_tag", id, payload)),
    onSuccess: (_values, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", variables.project_id],
      });
    },
  });
};

export const useDeleteTagByIdMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tagId: string) =>
      directus.request(deleteItem("project_tag", tagId)),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      toast.success("Tag deleted successfully");
    },
  });
};

export const useCreateChatMutation = () => {
  const navigate = useI18nNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      navigateToNewChat?: boolean;
      conversationId?: string;
      project_id: {
        id: string;
      };
    }) => {
      const project = await directus.request(
        readItem("project", payload.project_id.id),
      );

      const chat = await directus.request(
        createItem("project_chat", {
          ...(payload as any),
          auto_select: !!project.is_enhanced_audio_processing_enabled,
        }),
      );

      try {
        if (payload.conversationId) {
          await addChatContext(chat.id, payload.conversationId);
        }
      } catch (error) {
        console.error("Failed to add conversation to chat:", error);
        toast.error("Failed to add conversation to chat");
      }

      if (payload.navigateToNewChat && chat && chat.id) {
        navigate(`/projects/${payload.project_id.id}/chats/${chat.id}`);
      }

      return chat;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", variables.project_id.id, "chats"],
      });
      toast.success("Chat created successfully");
    },
  });
};
