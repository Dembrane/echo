import { directus } from "@/lib/directus";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryOptions,
} from "@tanstack/react-query";
import {
  Query,
  createItems,
  deleteItems,
  readItem,
  readItems,
  updateItem,
} from "@directus/sdk";
import {
  addChatContext,
  apiNoAuth,
  deleteChatContext,
  deleteConversationById,
  getConversationChunkContentLink,
  getConversationTranscriptString,
  retranscribeConversation,
} from "@/lib/api";
import { toast } from "@/components/common/Toaster";
import * as Sentry from "@sentry/react";
import { AxiosError } from "axios";
import { t } from "@lingui/core/macro";

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
    queryKey: ["conversations", conversationId, "chunks", "infinite"],
    queryFn: async ({ pageParam = 0 }) => {
      const response = await directus.request(
        readItems("conversation_chunk", {
          filter: {
            conversation_id: {
              _eq: conversationId,
            },
          },
          sort: ["timestamp"],
          limit: initialLimit,
          offset: pageParam * initialLimit,
        }),
      );

      return {
        chunks: response,
        nextOffset:
          response.length === initialLimit ? pageParam + 1 : undefined,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
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
            filter: {
              id: {
                _in: projectTagIdList,
              },
              project_id: {
                _eq: projectId,
              },
            },
            fields: ["*"],
          }),
        );

        validTagsIds = validTags.map((tag) => tag.id);
      } catch (error) {
        validTagsIds = [];
      }

      const tagsRequest = await directus.request(
        readItems("conversation_project_tag", {
          fields: [
            "id",
            {
              project_tag_id: ["id"],
            },
            {
              conversation_id: ["id"],
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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });
      toast.success("Conversation deleted successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message);
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
      } catch (error) {
        toast.error("Failed to move conversation.");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Conversation moved successfully");
    },
    onError: (error: Error) => {
      toast.error("Failed to move conversation: " + error.message);
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
      addChatContext(
        payload.chatId,
        payload.conversationId,
        payload.auto_select_bool,
      ),
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
      let optimisticId: string | undefined = undefined;
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
              optimisticId = "optimistic-" + Date.now() + Math.random();
              return {
                ...oldData,
                conversations: [
                  ...oldData.conversations,
                  {
                    conversation_id: variables.conversationId,
                    conversation_participant_name: t`Loading...`,
                    locked: false,
                    token_usage: 0,
                    optimisticId,
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
        previousChatContext,
        optimisticId,
        conversationId: variables.conversationId ?? undefined,
      };
    },
    onError: (error, variables, context) => {
      Sentry.captureException(error);

      // Only rollback the failed optimistic entry
      if (context?.optimisticId && context?.conversationId) {
        queryClient.setQueryData(
          ["chats", "context", variables.chatId],
          (oldData: TProjectChatContext | undefined) => {
            if (!oldData) return oldData;
            return {
              ...oldData,
              conversations: oldData.conversations.filter(
                (conv) =>
                  conv.conversation_id !== context.conversationId ||
                  conv.optimisticId !== context.optimisticId,
              ),
            };
          },
        );
      } else if (context?.previousChatContext) {
        // fallback: full rollback
        queryClient.setQueryData(
          ["chats", "context", variables.chatId],
          context.previousChatContext,
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
        previousChatContext,
        conversationId: variables.conversationId ?? undefined,
      };
    },
    onError: (error, variables, context) => {
      Sentry.captureException(error);

      // Only rollback the failed optimistic entry
      if (context?.conversationId) {
        queryClient.setQueryData(
          ["chats", "context", variables.chatId],
          (oldData: TProjectChatContext | undefined) => {
            if (!oldData) return oldData;

            // Find the conversation that was removed optimistically
            const previousContext = context.previousChatContext as
              | TProjectChatContext
              | undefined;
            const removedConversation = previousContext?.conversations?.find(
              (conv) => conv.conversation_id === context.conversationId,
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
      } else if (context?.previousChatContext) {
        // fallback: full rollback
        queryClient.setQueryData(
          ["chats", "context", variables.chatId],
          context.previousChatContext,
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

export const useConversationChunkContentUrl = (
  conversationId: string,
  chunkId: string,
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: ["conversation", conversationId, "chunk", chunkId, "audio-url"],
    queryFn: async () => {
      const url = getConversationChunkContentLink(
        conversationId,
        chunkId,
        true,
      );
      return apiNoAuth.get<unknown, string>(url);
    },
    enabled,
    staleTime: 1000 * 60 * 30, // 30 minutes
    gcTime: 1000 * 60 * 60, // 1 hour
  });
};

export const useRetranscribeConversationMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      newConversationName,
    }: {
      conversationId: string;
      newConversationName: string;
    }) => retranscribeConversation(conversationId, newConversationName),
    onSuccess: (_data) => {
      // Invalidate all conversation related queries
      queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });

      // Toast success message
      toast.success(
        t`Retranscription started. New conversation will be available soon.`,
      );
    },
    onError: (error) => {
      toast.error(t`Failed to retranscribe conversation. Please try again.`);
      console.error("Retranscribe error:", error);
    },
  });
};

export const useConversationTranscriptString = (conversationId: string) => {
  return useQuery({
    queryKey: ["conversations", conversationId, "transcript"],
    queryFn: () => getConversationTranscriptString(conversationId),
  });
};

export const useConversationChunks = (
  conversationId: string,
  refetchInterval: number = 10000,
) => {
  return useQuery({
    queryKey: ["conversations", conversationId, "chunks"],
    queryFn: () =>
      directus.request(
        readItems("conversation_chunk", {
          filter: {
            conversation_id: {
              _eq: conversationId,
            },
          },
          sort: "timestamp",
        }),
      ),
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
  const TIME_INTERVAL_SECONDS = 40;
  
  return useQuery({
    queryKey: [
      "projects",
      projectId,
      "conversations",
      loadChunks ? "chunks" : "no-chunks",
      loadWhereTranscriptExists ? "transcript" : "no-transcript",
      query,
      filterBySource,
    ],
    queryFn: async () => {
      const conversations = await directus.request(
        readItems("conversation", {
          sort: "-updated_at",
          fields: [
            "*",
            {
              tags: [
                {
                  project_tag_id: ["id", "text", "created_at"],
                },
              ],
            },
            { chunks: ["*"] },
          ],
          deep: {
            // @ts-expect-error chunks is not typed
            chunks: {
              _limit: loadChunks ? 1000 : 1,
            },
          },
          filter: {
            project_id: {
              _eq: projectId,
            },
            chunks: {
              ...(loadWhereTranscriptExists && {
                _some: {
                  transcript: {
                    _nempty: true,
                  },
                },
              }),
            },
            ...(filterBySource && {
              source: {
                _in: filterBySource,
              },
            }),
          },
          limit: 1000,
          ...query,
        }),
      );

      // Add live field to each conversation based on recent chunk activity
      const cutoffTime = new Date(Date.now() - TIME_INTERVAL_SECONDS * 1000);
      
      return conversations.map((conversation: any) => {
        const hasRecentChunks = conversation.chunks?.some((chunk: any) => {
          // Skip upload chunks
          if (chunk.source === "DASHBOARD_UPLOAD") return false;
          
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
    refetchInterval: 30000,
  });
};

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
    queryKey: ["conversations", conversationId, loadConversationChunks, query],
    queryFn: () =>
      directus.request<Conversation>(
        readItem("conversation", conversationId, {
          fields: [
            "*",
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
                  project_tag_id: ["id", "text", "created_at"],
                },
              ],
            },
            ...(loadConversationChunks ? [{ chunks: ["*"] as any }] : []),
          ],
          ...query,
        }),
      ),
    ...useQueryOpts,
  });
};
