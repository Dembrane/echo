import {
  initiateConversation,
  submitNotificationParticipant,
  uploadConversationChunk,
  uploadConversationText,
  getParticipantConversationById,
  getParticipantConversationChunks,
  getParticipantProjectById,
  getParticipantTutorialCardsBySlug,
} from "@/lib/api";
import { directus } from "@/lib/directus";
import { createItem, readItems } from "@directus/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { useQuery } from "@tanstack/react-query";
import { AxiosError } from "axios";

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
          const currentTime = new Date().getTime();
          const hoursDiff = (currentTime - lastUpdateTime) / (1000 * 60 * 60);
          shouldUpdate = hoursDiff >= 24;
        }

        if (shouldUpdate) {
          localStorage.setItem(key, new Date().toISOString());
        }
      } catch (e) {
        // Ignore localStorage errors
        shouldUpdate = true;
      }

      if (!shouldUpdate) {
        return Promise.resolve(null);
      }

      return directus.request(
        createItem("project_report_metric", payload as any),
      );
    },
  });
};

export const useUploadConversationChunk = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: uploadConversationChunk,
    retry: 10,
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
                  id: "optimistic-" + Date.now(),
                  conversation_id: variables.conversationId,
                  created_at: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  transcript: undefined,
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
                  id: "optimistic-" + Date.now(),
                  conversation_id: variables.conversationId,
                  created_at: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  transcript: undefined,
                } as ConversationChunk,
              ]
            : [];
        },
      );

      // Return a context object with the snapshotted value
      return { previousChunks };
    },
    // If the mutation fails,
    // use the context returned from onMutate to roll back
    onError: (_err, variables, context) => {
      queryClient.setQueryData(
        ["conversations", variables.conversationId, "chunks"],
        context?.previousChunks,
      );
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
  });
};

export const useUploadConversationTextChunk = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: uploadConversationText,
    retry: 10,
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
                  id: "optimistic-" + Date.now(),
                  conversation_id: variables.conversationId,
                  created_at: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  transcript: undefined,
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
                  id: "optimistic-" + Date.now(),
                  conversation_id: variables.conversationId,
                  created_at: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  transcript: undefined,
                } as ConversationChunk,
              ]
            : [];
        },
      );

      // Return a context object with the snapshotted value
      return { previousChunks };
    },
    // If the mutation fails,
    // use the context returned from onMutate to roll back
    onError: (_err, variables, context) => {
      queryClient.setQueryData(
        ["conversations", variables.conversationId, "chunks"],
        context?.previousChunks,
      );
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
  });
};

export const useInitiateConversationMutation = () => {
  return useMutation({
    mutationFn: initiateConversation,
    onSuccess: () => {
      toast.success("Success");
    },
    onError: () => {
      toast.error("Invalid PIN or email. Please try again.");
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
    retry: 2,
    onError: (error) => {
      console.error("Notification submission failed:", error);
    },
  });
};

export const useParticipantProjectById = (projectId: string) => {
  return useQuery({
    queryKey: ["participantProject", projectId],
    queryFn: () => getParticipantProjectById(projectId),
  });
};

export const useParticipantTutorialCardBySlug = (slug: string) => {
  return useQuery({
    queryKey: ["participantTutorialCard", slug],
    queryFn: () => getParticipantTutorialCardsBySlug(slug),
    select: (data) => (data.length > 0 ? data[0] : null),
    enabled: slug !== "",
  });
};

export const combineUserChunks = (
  chunks: { type: "user_chunk"; timestamp: Date; data: TConversationChunk }[],
) => {
  return {
    type: "user_chunk" as const,
    timestamp: chunks[0].timestamp,
    data: {
      ...chunks[0].data,
      transcript: chunks.map((c) => c.data.transcript).join("..."),
    },
  };
};

export const useConversationRepliesQuery = (
  conversationId: string | undefined,
) => {
  return useQuery({
    queryKey: ["participant", "conversation_replies", conversationId],
    queryFn: () =>
      directus.request(
        readItems("conversation_reply", {
          filter: { conversation_id: { _eq: conversationId } },
          fields: ["id", "content_text", "date_created", "type"],
          sort: ["date_created"],
        }),
      ),
    enabled: !!conversationId,
    // refetchInterval: 15000,
  });
};

export const useConversationQuery = (
  projectId: string | undefined,
  conversationId: string | undefined,
) => {
  return useQuery({
    queryKey: ["participant", "conversation", projectId, conversationId],
    queryFn: () =>
      getParticipantConversationById(projectId ?? "", conversationId ?? ""),
    enabled: !!conversationId && !!projectId,
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
    queryKey: ["participant", "conversation_chunks", conversationId],
    queryFn: () =>
      getParticipantConversationChunks(projectId ?? "", conversationId ?? ""),
    refetchInterval: 60000,
  });
};
