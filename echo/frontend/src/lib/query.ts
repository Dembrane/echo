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
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
  api,
  getLatestProjectAnalysisRunByProjectId,
  getProjectChatContext,
} from "./api";
import { toast } from "@/components/common/Toaster";
import { directus } from "./directus";
import {
  Query,
  aggregate,
  readItem,
  readItems,
  readUser,
  updateItem,
} from "@directus/sdk";

// always throws a error with a message
export function throwWithMessage(e: unknown): never {
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

export const useConversationsByProjectId = (
  projectId: string,
  loadChunks?: boolean,
  // unused
  loadWhereTranscriptExists?: boolean,
  query?: Partial<Query<CustomDirectusTypes, Conversation>>,
  filterBySource?: string[],
) => {
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
    queryFn: () =>
      directus.request(
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
      ),
    refetchInterval: 30000,
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
