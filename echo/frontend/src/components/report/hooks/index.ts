import { createProjectReport, getProjectConversationCounts } from "@/lib/api";
import { directus } from "@/lib/directus";
import { aggregate, readItem, readItems, updateItem } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export const useProjectReport = (reportId: number) => {
  return useQuery({
    queryKey: ["reports", reportId],
    queryFn: () => directus.request(readItem("project_report", reportId)),
    refetchInterval: 30000,
  });
};

export const useProjectConversationCounts = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "conversation-counts"],
    queryFn: () => getProjectConversationCounts(projectId),
    refetchInterval: 15000,
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
