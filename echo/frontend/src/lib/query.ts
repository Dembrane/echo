// conventions
// query key uses the following format: projects , chats (plural)
// mutation key uses the following format: projects , chats (plural)
import {
  UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import * as Sentry from "@sentry/react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
  addChatContext,
  api,
  apiNoAuth,
  checkUnsubscribeStatus,
  createProjectReport,
  deleteChatContext,
  deleteConversationById,
  deleteResourceById,
  generateProjectLibrary as generateProjectLibrary,
  generateProjectView,
  getChatHistory,
  getConversationChunkContentLink,
  getConversationTranscriptString,
  getLatestProjectAnalysisRunByProjectId,
  getProjectChatContext,
  getProjectConversationCounts,
  getProjectViews,
  getResourceById,
  getResourcesByProjectId,
  initiateAndUploadConversationChunk,
  initiateConversation,
  lockConversations,
  retranscribeConversation,
  submitNotificationParticipant,
  updateResourceById,
  uploadConversationChunk,
  uploadConversationText,
  uploadResourceByProjectId,
} from "./api";
import { toast } from "@/components/common/Toaster";
import { directus } from "./directus";
import {
  Query,
  aggregate,
  createItem,
  createItems,
  deleteItem,
  passwordRequest,
  passwordReset,
  readItem,
  readItems,
  readUser,
  registerUser,
  registerUserVerify,
  updateItem,
  deleteItems,
} from "@directus/sdk";
import { ADMIN_BASE_URL } from "@/config";
import { AxiosError } from "axios";
import { t } from "@lingui/core/macro";
import { useState, useCallback, useEffect, useRef } from "react";

// always throws a error with a message
function throwWithMessage(e: unknown): never {
  if (
    e &&
    typeof e === "object" &&
    "errors" in e &&
    Array.isArray((e as any).errors)
  ) {
    // Handle Directus error format
    const message = (e as any).errors[0].message;
    console.log(message);
    throw new Error(message);
  } else if (e instanceof Error) {
    // Handle generic errors
    console.log(e.message);
    throw new Error(e.message);
  } else {
    // Handle unknown errors
    console.log("An unknown error occurred");
    throw new Error("Something went wrong");
  }
}

export const useProjects = ({
  query,
}: {
  query: Partial<Query<CustomDirectusTypes, Project>>;
}) => {
  return useQuery({
    queryKey: ["projects", query],
    queryFn: () =>
      directus.request(
        readItems("project", {
          fields: [
            "*",
            {
              tags: ["*"],
            },
          ],
          deep: {
            // @ts-expect-error tags is not typed
            tags: {
              _sort: "sort",
            },
          },
          ...query,
        }),
      ),
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

// todo: add redirection logic here
export const useLoginMutation = () => {
  return useMutation({
    mutationFn: (payload: Parameters<typeof directus.login>) => {
      return directus.login(...payload);
    },
    onSuccess: () => {
      toast.success("Login successful");
    },
  });
};

export const useRegisterMutation = () => {
  const navigate = useI18nNavigate();
  return useMutation({
    mutationFn: async (payload: Parameters<typeof registerUser>) => {
      try {
        const response = await directus.request(registerUser(...payload));
        return response;
      } catch (e) {
        try {
          throwWithMessage(e);
        } catch (inner) {
          if (inner instanceof Error) {
            if (inner.message === "You don't have permission to access this.") {
              throw new Error(
                "Oops! It seems your email is not eligible for registration at this time. Please consider joining our waitlist for future updates!",
              );
            }
          }
        }
      }
    },
    onSuccess: () => {
      toast.success("Please check your email to verify your account.");
      navigate("/check-your-email");
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
};

export const useVerifyMutation = (doRedirect: boolean = true) => {
  const navigate = useI18nNavigate();

  return useMutation({
    mutationFn: async (data: { token: string }) => {
      try {
        const response = await directus.request(registerUserVerify(data.token));
        return response;
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onSuccess: () => {
      toast.success("Email verified successfully.");
      if (doRedirect) {
        setTimeout(() => {
          // window.location.href = `/login?new=true`;
          navigate(`/login?new=true`);
        }, 4500);
      }
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
};

export const useRequestPasswordResetMutation = () => {
  const navigate = useI18nNavigate();
  return useMutation({
    mutationFn: async (email: string) => {
      try {
        const response = await directus.request(
          passwordRequest(email, `${ADMIN_BASE_URL}/password-reset`),
        );
        return response;
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onSuccess: () => {
      toast.success("Password reset email sent successfully");
      navigate("/check-your-email");
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
};

export const useResetPasswordMutation = () => {
  const navigate = useI18nNavigate();
  return useMutation({
    mutationFn: async ({
      token,
      password,
    }: {
      token: string;
      password: string;
    }) => {
      try {
        const response = await directus.request(passwordReset(token, password));
        return response;
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onSuccess: () => {
      toast.success(
        "Password reset successfully. Please login with new password.",
      );
      navigate("/login");
    },
    onError: (e) => {
      try {
        toast.error(e.message);
      } catch (e) {
        toast.error("Error resetting password. Please contact support.");
      }
    },
  });
};

export const useLogoutMutation = () => {
  const queryClient = useQueryClient();
  const navigate = useI18nNavigate();

  return useMutation({
    mutationFn: async ({
      next: _,
    }: {
      next?: string;
      reason?: string;
      doRedirect: boolean;
    }) => {
      try {
        await directus.logout();
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onMutate: async ({ next, reason, doRedirect }) => {
      queryClient.resetQueries();
      if (doRedirect) {
        navigate(
          "/login" +
            (next ? `?next=${encodeURIComponent(next)}` : "") +
            (reason ? `&reason=${reason}` : ""),
        );
      }
    },
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

export const useProjectViews = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "views"],
    queryFn: () => getProjectViews(projectId),
    refetchInterval: 20000,
  });
};

export const useViewById = (projectId: string, viewId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "views", viewId],
    queryFn: () =>
      directus.request<View>(
        readItem("view", viewId, {
          fields: [
            "*",
            {
              aspects: ["*", "count(aspect_segment)"],
            },
          ],
          deep: {
            // get the aspects that have at least one aspect segment
            aspects: {
              _sort: "-count(aspect_segment)",
            } as any,
          },
        }),
      ),
  });
};

export const useAspectById = (projectId: string, aspectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "aspects", aspectId],
    queryFn: () =>
      directus.request<Aspect>(
        readItem("aspect", aspectId, {
          fields: [
            "*",
            {
              "aspect_segment": [
                "*",
                { 
                  "segment": [
                    "*",
                  ]
                }
              ]
            }
          ],
        }),
      ),
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

export const useResourceById = (resourceId: string) => {
  return useQuery({
    queryKey: ["resources", resourceId],
    queryFn: () => getResourceById(resourceId),
  });
};

export const useResourcesByProjectId = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "resources"],
    queryFn: () => getResourcesByProjectId(projectId),
  });
};

export const useUploadResourceByProjectIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadResourceByProjectId,
    retry: 3,
    onSuccess: (_values, variables) => {
      const projectId = variables.projectId;
      queryClient.invalidateQueries({
        queryKey: ["projects", projectId, "resources"],
      });
      toast.success("Resource uploaded successfully");
    },
  });
};

export const useUpdateResourceByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateResourceById,
    onSuccess: (_values, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["resources", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      toast.success("Resource updated successfully");
    },
  });
};

export const useDeleteResourceByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteResourceById,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["resources"],
      });
      toast.success("Resource deleted successfully");
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

export const useDeleteConversationChunkByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chunkId: string) =>
      directus.request(deleteItem("conversation_chunk", chunkId)),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });
    },
  });
};

export const useProjectConversationCounts = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "conversation-counts"],
    queryFn: () => getProjectConversationCounts(projectId),
    refetchInterval: 15000,
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

export const useUploadConversation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: {
      projectId: string;
      pin: string;
      namePrefix: string;
      tagIdList: string[];
      chunks: Blob[];
      timestamps: Date[];
      email?: string;
      onProgress?: (fileName: string, progress: number) => void;
    }) => initiateAndUploadConversationChunk(payload),
    onMutate: () => {
      // When the mutation starts, cancel any in-progress queries
      // to prevent them from overwriting our optimistic update
      queryClient.cancelQueries({ queryKey: ["conversations"] });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      toast.success("Conversation(s) uploaded successfully");
    },
    onError: (error) => {
      toast.error(
        `Upload failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    },
    retry: 3, // Reduced retry count to avoid too many duplicate attempts
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

export const useGenerateProjectLibraryMutation = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: generateProjectLibrary,
    onSuccess: (_, variables) => {
      toast.success("Analysis requested successfully");
      client.invalidateQueries({ queryKey: ["projects", variables.projectId] });
    },
  });
};

export const useGenerateProjectViewMutation = () => {
  return useMutation({
    mutationFn: generateProjectView,
    onSuccess: () => {
      toast.success("Analysis requested successfully");
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

export const useCurrentUser = () =>
  useQuery({
    queryKey: ["users", "me"],
    queryFn: () => {
      try {
        return directus.request(readUser("me"));
      } catch (error) {
        return null;
      }
    },
  });

export const useConversationTranscriptString = (conversationId: string) => {
  return useQuery({
    queryKey: ["conversations", conversationId, "transcript"],
    queryFn: () => getConversationTranscriptString(conversationId),
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

export const useProjectChats = (
  projectId: string,
  query?: Partial<Query<CustomDirectusTypes, ProjectChat>>,
) => {
  return useQuery({
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

export const useProjectChatContext = (chatId: string) => {
  return useQuery({
    queryKey: ["chats", "context", chatId],
    queryFn: () => getProjectChatContext(chatId),
    enabled: chatId !== "",
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

export const useChatHistory = (chatId: string) => {
  return useQuery({
    queryKey: ["chats", "history", chatId],
    queryFn: () => getChatHistory(chatId ?? ""),
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

export const useLatestProjectReport = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "report"],
    queryFn: async () => {
      const reports = await directus.request(
        readItems("project_report", {
          filter: {
            project_id: {
              _eq: projectId,
            },
          },
          fields: ["*"],
          sort: "-date_created",
          limit: 1,
        }),
      );

      if (reports.length === 0) {
        return null;
      }

      return reports[0];
    },
    refetchInterval: 30000,
  });
};

export const useProjectReportViews = (reportId: number) => {
  return useQuery({
    queryKey: ["reports", reportId, "views"],
    queryFn: async () => {
      const report = await directus.request(
        readItem("project_report", reportId, {
          fields: ["project_id"],
        }),
      );

      const total = await directus.request(
        aggregate("project_report_metric", {
          aggregate: {
            count: "*",
          },
          query: {
            filter: {
              project_report_id: {
                project_id: {
                  _eq: report.project_id,
                },
              },
            },
          },
        }),
      );

      const recent = await directus.request(
        aggregate("project_report_metric", {
          aggregate: {
            count: "*",
          },
          query: {
            filter: {
              project_report_id: {},
              // in the last 10 mins
              date_created: {
                // @ts-ignore
                _gte: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
              },
            },
          },
        }),
      );

      return {
        total: total[0].count,
        recent: recent[0].count,
      };
    },
    refetchInterval: 30000,
  });
};

export const useProjectReport = (reportId: number) => {
  return useQuery({
    queryKey: ["reports", reportId],
    queryFn: () => directus.request(readItem("project_report", reportId)),
    refetchInterval: 30000,
  });
};

// always give the project_id in payload used for invalidation
export const useUpdateProjectReportMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      reportId,
      payload,
    }: {
      reportId: number;
      payload: Partial<ProjectReport>;
    }) => directus.request(updateItem("project_report", reportId, payload)),
    onSuccess: (_, vars) => {
      const projectId = vars.payload.project_id;
      const projectIdValue =
        typeof projectId === "object" && projectId !== null
          ? projectId.id
          : projectId;

      queryClient.invalidateQueries({
        queryKey: ["projects", projectIdValue, "report"],
      });
      queryClient.invalidateQueries({
        queryKey: ["reports"],
      });
    },
  });
};

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

export const useCreateProjectReportMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProjectReport,
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", vars.projectId, "report"],
      });
      queryClient.invalidateQueries({
        queryKey: ["reports"],
      });
    },
  });
};

export const useDoesProjectReportNeedUpdate = (projectReportId: number) => {
  return useQuery({
    queryKey: ["reports", projectReportId, "needsUpdate"],
    queryFn: async () => {
      const reports = await directus.request(
        readItems("project_report", {
          filter: {
            id: {
              _eq: projectReportId,
            },
            status: {
              _eq: "published",
            },
          },
          fields: ["id", "date_created", "project_id"],
          sort: "-date_created",
          limit: 1,
        }),
      );

      if (reports.length === 0) {
        return false;
      }

      const latestReport = reports[0];

      const latestConversation = await directus.request(
        readItems("conversation", {
          filter: {
            project_id: {
              _eq: latestReport.project_id,
            },
          },
          fields: ["id", "created_at"],
          sort: "-created_at",
          limit: 1,
        }),
      );

      if (latestConversation.length === 0) {
        return false;
      }

      return (
        new Date(latestConversation[0].created_at!) >
        new Date(latestReport.date_created!)
      );
    },
  });
};

// always give the project_report_id in payload used for invalidation
export const usePostProjectReportMetricMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      reportId: number;
      payload: Partial<ProjectReportMetric>;
    }) => directus.request(createItem("project_report_metric", payload as any)),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["projects", vars.payload.project_report_id, "report"],
      });
      queryClient.invalidateQueries({
        queryKey: ["reports", vars.reportId],
      });
    },
  });
};

/**
 * Gathers data needed to build a timeline chart of:
 * 1) Project creation (vertical reference line).
 * 2) This specific project report creation (vertical reference line).
 * 3) Green "stem" lines representing Conversations created (height = number of conversation chunks). Uses Directus aggregate() to get counts.
 * 4) Blue line points representing Project Report Metrics associated with the given project_report_id (e.g., "views", "score", etc.).
 *
 * Based on Mantine Charts docs: https://mantine.dev/charts/line-chart/#reference-lines
 *
 * NOTES:
 * - Make sure you match your date fields in Directus (e.g., "date_created" vs. "created_at").
 * - For any chart "stems", you typically create two data points with the same X but different Y values.
 */
export const useProjectReportTimelineData = (projectReportId: string) => {
  return useQuery({
    queryKey: ["reports", projectReportId, "timelineData"],
    queryFn: async () => {
      // 1. Fetch the project report so we know the projectId and the report's creation date
      const projectReport = await directus.request<ProjectReport>(
        readItem("project_report", projectReportId, {
          fields: ["id", "date_created", "project_id"],
        }),
      );

      if (!projectReport?.project_id) {
        throw new Error("No project_id found on this report");
      }

      const allProjectReports = await directus.request(
        readItems("project_report", {
          filter: {
            project_id: {
              _eq: projectReport.project_id,
            },
          },
          limit: 1000,
          sort: "date_created",
        }),
      );

      // 2. Fetch the project to get the creation date
      //    Adjust fields to match your date field naming
      const project = await directus.request<Project>(
        readItem("project", projectReport.project_id.toString(), {
          fields: ["id", "created_at"], // or ["id", "created_at"]
        }),
      );

      // 3. Fetch all Conversations and use an aggregate to count conversation_chunks
      const conversations = await directus.request<Conversation[]>(
        readItems("conversation", {
          fields: ["id", "created_at"], // or ["id", "date_created"]
          filter: {
            project_id: {
              _eq: projectReport.project_id,
            },
          },
          limit: 1000, // adjust to your needs
        }),
      );

      // Aggregate chunk counts per conversation with Directus aggregator
      let conversationChunkAgg: { conversation_id: string; count: number }[] =
        [];
      if (conversations.length > 0) {
        const conversationIds = conversations.map((c) => c.id);
        const chunkCountsAgg = await directus.request<
          Array<{ conversation_id: string; count: number }>
        >(
          readItems("conversation_chunk", {
            aggregate: { count: "*" },
            groupBy: ["conversation_id"],
            filter: { conversation_id: { _in: conversationIds } },
          }),
        );

        // chunkCountsAgg shape is [{ conversation_id: '...', count: 5 }, ...]
        conversationChunkAgg = chunkCountsAgg;
      }

      // 4. Fetch all Project Report Metrics for this project_report_id
      //    (e.g., type "view", "score," etc. – adapt as needed)
      const projectReportMetrics = await directus.request<
        ProjectReportMetric[]
      >(
        readItems("project_report_metric", {
          fields: ["id", "date_created", "project_report_id"],
          filter: {
            project_report_id: {
              project_id: {
                _eq: project.id,
              },
            },
          },
          sort: "date_created",
          limit: 1000,
        }),
      );

      // Return all structured data. The consuming component can then create the chart data arrays.
      return {
        projectCreatedAt: project.created_at,
        reportCreatedAt: projectReport.date_created,
        allReports: allProjectReports.map((r) => ({
          id: r.id,
          createdAt: r.date_created,
        })),
        conversations: conversations,
        conversationChunks: conversations.map((conv) => {
          const aggRow = conversationChunkAgg.find(
            (row) => row.conversation_id === conv.id,
          );
          return {
            conversationId: conv.id,
            createdAt: conv.created_at,
            chunkCount: aggRow?.count ?? 0,
          };
        }),
        projectReportMetrics,
      };
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

// Higher-level hook for managing conversation uploads with better state control
export const useConversationUploader = () => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  );
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const uploadMutation = useUploadConversation();
  // Use a ref to track if we've completed the upload to avoid multiple state updates
  const hasCompletedRef = useRef(false);
  // Use refs to track previous state to avoid unnecessary updates
  const progressRef = useRef<Record<string, number>>({});
  const errorsRef = useRef<Record<string, string>>({});

  // Clean up function to reset states
  const resetUpload = useCallback(() => {
    hasCompletedRef.current = false;
    progressRef.current = {};
    errorsRef.current = {};
    setIsUploading(false);
    setUploadProgress({});
    setUploadErrors({});
    uploadMutation.reset();
  }, [uploadMutation]);

  // Handle real progress updates with debouncing
  const handleProgress = useCallback((fileName: string, progress: number) => {
    // Only update if progress actually changed by at least 1%
    if (Math.abs((progressRef.current[fileName] || 0) - progress) < 1) {
      return; // Skip tiny updates that don't matter visually
    }

    // Update the ref and then the state
    progressRef.current = {
      ...progressRef.current,
      [fileName]: progress,
    };

    setUploadProgress((prev) => ({
      ...prev,
      [fileName]: progress,
    }));
  }, []);

  // Upload files with real progress tracking
  const uploadFiles = useCallback(
    (payload: {
      projectId: string;
      pin: string;
      namePrefix: string;
      tagIdList: string[];
      chunks: Blob[];
      timestamps: Date[];
      email?: string;
    }) => {
      // Don't start if already uploading
      if (isUploading || uploadMutation.isPending) {
        return;
      }

      hasCompletedRef.current = false;

      // Initialize progress tracking for all files
      const initialProgress: Record<string, number> = {};
      payload.chunks.forEach((chunk) => {
        const name =
          chunk instanceof File
            ? chunk.name
            : `chunk-${payload.chunks.indexOf(chunk)}`;
        initialProgress[name] = 0;
      });

      // Update refs first
      progressRef.current = initialProgress;
      errorsRef.current = {};

      // Then update state
      setUploadProgress(initialProgress);
      setUploadErrors({});
      setIsUploading(true);

      // Start the upload with progress tracking
      uploadMutation.mutate({
        ...payload,
        onProgress: handleProgress,
      });
    },
    [isUploading, uploadMutation, handleProgress],
  );

  // Handle success state - separate from error handling to prevent cycles
  useEffect(() => {
    // Skip if conditions aren't right
    if (!isUploading || !uploadMutation.isSuccess || hasCompletedRef.current) {
      return;
    }

    // Set flag to prevent repeated updates
    hasCompletedRef.current = true;

    // Mark all files as complete when successful
    const fileNames = Object.keys(progressRef.current);
    if (fileNames.length > 0) {
      // Update refs first
      const completed = { ...progressRef.current };
      fileNames.forEach((key) => {
        completed[key] = 100;
      });
      progressRef.current = completed;

      // Then update state - do this once rather than per file
      setUploadProgress(completed);
    }
  }, [uploadMutation.isSuccess, isUploading]);

  // Handle error state separately
  useEffect(() => {
    // Skip if conditions aren't right
    if (!isUploading || !uploadMutation.isError) {
      return;
    }

    // Only do this once
    if (Object.keys(errorsRef.current).length > 0) {
      return;
    }

    // Set errors on failure
    const fileNames = Object.keys(progressRef.current);
    if (fileNames.length > 0) {
      // Update refs first
      const newErrors = { ...errorsRef.current };
      const errorMessage = uploadMutation.error?.message || "Upload failed";

      fileNames.forEach((key) => {
        newErrors[key] = errorMessage;
      });
      errorsRef.current = newErrors;

      // Then update state - do this once rather than per file
      setUploadErrors(newErrors);
    }
  }, [uploadMutation.isError, isUploading, uploadMutation.error]);

  return {
    uploadFiles,
    resetUpload,
    isUploading,
    uploadProgress,
    uploadErrors,
    isSuccess: uploadMutation.isSuccess,
    isError: uploadMutation.isError,
    isPending: uploadMutation.isPending,
    error: uploadMutation.error,
  };
};

export const useCheckUnsubscribeStatus = (token: string, projectId: string) => {
  return useQuery<{ eligible: boolean }>({
    queryKey: ["checkUnsubscribe", token, projectId],
    queryFn: async () => {
      if (!token || !projectId) {
        throw new Error("Invalid or missing unsubscribe link.");
      }
      const response = await checkUnsubscribeStatus(token, projectId);
      return response.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
};

export const useGetProjectParticipants = (project_id: string) => {
  return useQuery({
    queryKey: ["projectParticipants", project_id],
    queryFn: async () => {
      if (!project_id) return 0;

      const submissions = await directus.request(
        readItems("project_report_notification_participants", {
          filter: {
            _and: [
              { project_id: { _eq: project_id } },
              { email_opt_in: { _eq: true } },
            ],
          },
          fields: ["id"],
        }),
      );

      return submissions.length;
    },
    enabled: !!project_id, // Only run query if project_id exists
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
