import { readItem, readItems } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	cancelScheduledReport,
	checkReportNeedsUpdate,
	createProjectReport,
	deleteProjectReport,
	getLatestProjectReport,
	getProjectConversationCounts,
	getProjectParticipantCount,
	getProjectReportDetail,
	getProjectReportViews,
	getPublicLatestProjectReport,
	getPublicProjectReportDetail,
	getPublicProjectReportViews,
	listProjectReports,
	updateProjectReport,
} from "@/lib/api";
import { directus } from "@/lib/directus";

export const useUpdateProjectReportMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			reportId,
			payload,
		}: {
			projectId: string;
			reportId: number;
			payload: Partial<ProjectReport>;
		}) => updateProjectReport(projectId, reportId, payload),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "report"],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "allReports"],
			});
			queryClient.invalidateQueries({
				queryKey: ["reports"],
			});
		},
	});
};

export const useDeleteProjectReportMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			reportId,
		}: {
			projectId: string;
			reportId: number;
		}) => deleteProjectReport(projectId, reportId),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "report"],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "allReports"],
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
				queryKey: ["projects", vars.projectId, "allReports"],
			});
			queryClient.invalidateQueries({
				queryKey: ["reports"],
			});
		},
	});
};

export const useCancelScheduledReportMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			reportId,
		}: {
			projectId: string;
			reportId: number;
		}) => cancelScheduledReport(projectId, reportId),
		onSuccess: (_, vars) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "report"],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects", vars.projectId, "allReports"],
			});
			queryClient.invalidateQueries({
				queryKey: ["reports"],
			});
		},
	});
};

export const useGetProjectParticipants = (projectId: string) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: async () => {
			if (!projectId) return 0;
			const result = await getProjectParticipantCount(projectId);
			return result.count;
		},
		queryKey: ["projectParticipants", projectId],
	});
};

export const useDoesProjectReportNeedUpdate = (
	projectId: string,
	reportId: number,
) => {
	return useQuery({
		enabled: !!projectId && reportId > 0,
		queryFn: async () => {
			const result = await checkReportNeedsUpdate(projectId, reportId);
			return result.needs_update;
		},
		queryKey: ["reports", reportId, "needsUpdate"],
	});
};

export const useProjectReport = (projectId: string, reportId: number) => {
	return useQuery({
		enabled: !!projectId && reportId > 0,
		queryFn: () => getProjectReportDetail(projectId, reportId),
		queryKey: ["reports", reportId],
		refetchInterval: (query) => {
			const report = query.state.data;
			if (report && report.status === "draft") return 5000;
			return 30000;
		},
	});
};

export const useProjectConversationCounts = (projectId: string) => {
	return useQuery({
		queryFn: () => getProjectConversationCounts(projectId),
		queryKey: ["projects", projectId, "conversation-counts"],
		refetchInterval: 15000,
	});
};

export const useProjectReportViews = (projectId: string, reportId: number) => {
	return useQuery({
		enabled: !!projectId && reportId > 0,
		queryFn: () => getProjectReportViews(projectId, reportId),
		queryKey: ["reports", reportId, "views"],
		refetchInterval: 30000,
	});
};

export const useAllProjectReports = (projectId: string) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => listProjectReports(projectId),
		queryKey: ["projects", projectId, "allReports"],
		refetchInterval: (query) => {
			const reports = query.state.data;
			if (reports?.some((r) => r.status === "draft")) return 5000;
			return 30000;
		},
	});
};

export const useLatestProjectReport = (projectId: string) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getLatestProjectReport(projectId),
		queryKey: ["projects", projectId, "report"],
		refetchInterval: (query) => {
			const report = query.state.data;
			if (
				report &&
				(report.status === "draft" || report.status === "scheduled")
			)
				return 5000;
			return 30000;
		},
	});
};

export const useProjectReportTimelineData = (projectReportId: string) => {
	return useQuery({
		queryFn: async () => {
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
					fields: ["id", "date_created"],
					filter: {
						project_id: { _eq: projectReport.project_id },
					},
					limit: 1000,
					sort: "date_created",
				}),
			);

			const project = await directus.request<Project>(
				readItem("project", projectReport.project_id.toString(), {
					fields: ["id", "created_at"],
				}),
			);

			const conversations = await directus.request<Conversation[]>(
				readItems("conversation", {
					fields: ["id", "created_at"],
					filter: {
						project_id: { _eq: projectReport.project_id },
					},
					limit: 1000,
				}),
			);

			let conversationChunkAgg: { conversation_id: string; count: number }[] =
				[];
			if (conversations.length > 0) {
				const conversationIds = conversations.map((c) => c.id);
				const chunkCountsAgg = await directus.request<
					Array<{ conversation_id: string; count: number }>
				>(
					readItems("conversation_chunk", {
						aggregate: { count: "*" },
						filter: { conversation_id: { _in: conversationIds } },
						groupBy: ["conversation_id"],
					}),
				);
				conversationChunkAgg = chunkCountsAgg;
			}

			const projectReportMetrics = await directus.request<
				ProjectReportMetric[]
			>(
				readItems("project_report_metric", {
					fields: ["id", "date_created", "project_report_id"],
					filter: {
						project_report_id: {
							project_id: { _eq: project.id },
						},
					},
					limit: 1000,
					sort: "date_created",
				}),
			);

			return {
				allReports: allProjectReports.map((r) => ({
					createdAt: r.date_created,
					id: r.id,
				})),
				conversationChunks: conversations.map((conv) => {
					const aggRow = conversationChunkAgg.find(
						(row) => row.conversation_id === conv.id,
					);
					return {
						chunkCount: aggRow?.count ?? 0,
						conversationId: conv.id,
						createdAt: conv.created_at,
					};
				}),
				conversations: conversations,
				projectCreatedAt: project.created_at,
				projectReportMetrics,
				reportCreatedAt: projectReport.date_created,
			};
		},
		queryKey: ["reports", projectReportId, "timelineData"],
	});
};

export const usePublicLatestProjectReport = (projectId: string) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getPublicLatestProjectReport(projectId),
		queryKey: ["public", "projects", projectId, "report"],
		refetchInterval: 30000,
	});
};

export const usePublicProjectReport = (projectId: string, reportId: number) => {
	return useQuery({
		enabled: !!projectId && reportId > 0,
		queryFn: () => getPublicProjectReportDetail(projectId, reportId),
		queryKey: ["public", "reports", reportId],
		refetchInterval: 30000,
	});
};

export const usePublicProjectReportViews = (projectId: string) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getPublicProjectReportViews(projectId),
		queryKey: ["public", "projects", projectId, "views"],
		refetchInterval: 30000,
	});
};

export type { ReportProgressEvent } from "./useReportProgress";
export { useReportProgress } from "./useReportProgress";
