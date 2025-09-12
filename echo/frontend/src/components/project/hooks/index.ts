import {
  useMutation,
  useQuery,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  Query,
  createItem,
  deleteItem,
  readItem,
  readItems,
  updateItem,
} from "@directus/sdk";
import { directus } from "@/lib/directus";
import { toast } from "@/components/common/Toaster";
import { api, getLatestProjectAnalysisRunByProjectId } from "@/lib/api";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useAddChatContextMutation } from "@/components/conversation/hooks";

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
  const addChatContextMutation = useAddChatContextMutation();
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
          auto_select:
            payload.conversationId &&
            project.is_enhanced_audio_processing_enabled
              ? false
              : !!project.is_enhanced_audio_processing_enabled,
        }),
      );

      if (payload.navigateToNewChat && chat && chat.id) {
        navigate(`/projects/${payload.project_id.id}/chats/${chat.id}`);
      }

      if (payload.conversationId) {
        addChatContextMutation.mutate({
          chatId: chat.id,
          conversationId: payload.conversationId,
        });
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

export const useLatestProjectAnalysisRunByProjectId = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "latest_analysis"],
    queryFn: () => getLatestProjectAnalysisRunByProjectId(projectId),
    refetchInterval: 10000,
  });
};

export const useUpdateProjectByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<Project> }) =>
      directus.request<Project>(updateItem("project", id, payload)),
    onSuccess: (_values, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", variables.id],
      });
      toast.success("Project updated successfully");
    },
  });
};

export const useCreateProjectMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<Project>) => {
      return api.post<unknown, TProject>("/projects", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Project created successfully");
    },
    onError: (e) => {
      console.error(e);
      toast.error("Error creating project");
    },
  });
};

export const useInfiniteProjects = ({
  query,
  options = {
    initialLimit: 15,
  },
}: {
  query: Partial<Query<CustomDirectusTypes, Project>>;
  options?: {
    initialLimit?: number;
  };
}) => {
  const { initialLimit = 15 } = options;

  return useInfiniteQuery({
    queryKey: ["projects", query],
    queryFn: async ({ pageParam = 0 }) => {
      const response = await directus.request(
        readItems("project", {
          ...query,
          limit: initialLimit,
          offset: pageParam * initialLimit,
        }),
      );

      return {
        projects: response,
        nextOffset:
          response.length === initialLimit ? pageParam + 1 : undefined,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });
};

export const useProjectById = ({
  projectId,
  query = {
    fields: [
      "*",
      {
        tags: ["id", "created_at", "text", "sort"],
      },
    ],
    deep: {
      // @ts-expect-error tags won't be typed
      tags: {
        _sort: "sort",
      },
    },
  },
}: {
  projectId: string;
  query?: Partial<Query<CustomDirectusTypes, Project>>;
}) => {
  return useQuery({
    queryKey: ["projects", projectId, query],
    queryFn: () =>
      directus.request<Project>(readItem("project", projectId, query)),
  });
};
