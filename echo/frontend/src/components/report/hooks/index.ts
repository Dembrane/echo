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
import { bff } from "@/lib/bff";

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
			return 60000;
		},
	});
};

export const useProjectConversationCounts = (projectId: string) => {
	return useQuery({
		queryFn: () => getProjectConversationCounts(projectId),
		queryKey: ["projects", projectId, "conversation-counts"],
		refetchInterval: 60000,
	});
};

export const useProjectReportViews = (projectId: string, reportId: number) => {
	return useQuery({
		enabled: !!projectId && reportId > 0,
		queryFn: () => getProjectReportViews(projectId, reportId),
		queryKey: ["reports", reportId, "views"],
		refetchInterval: 60000,
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
			return 60000;
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
			// Scheduled reports poll at 30s to detect when generation starts.
			// Drafts are covered by useAllProjectReports at 5s, no need to duplicate.
			if (report && report.status === "scheduled") return 30000;
			return 60000;
		},
	});
};

export const useProjectReportTimelineData = (projectReportId: string) => {
	return useQuery({
		queryFn: async () => {
			// One BFF round-trip replaces the old 6-query sequence —
			// server-side access-checks the report then aggregates
			// siblings + conversations + chunk counts + metrics.
			const data = await bff.get<{
				report: { id: string; date_created: string; project_id: string };
				all_reports: { id: string; date_created: string }[];
				project_created_at: string | null;
				conversations: {
					id: string;
					created_at: string;
					chunk_count: number;
				}[];
				metrics: ProjectReportMetric[];
			}>(`/reports/${projectReportId}/timeline`);

			return {
				allReports: data.all_reports.map((r) => ({
					createdAt: r.date_created,
					id: r.id,
				})),
				conversationChunks: data.conversations.map((conv) => ({
					chunkCount: conv.chunk_count,
					conversationId: conv.id,
					createdAt: conv.created_at,
				})),
				conversations: data.conversations.map((c) => ({
					id: c.id,
					created_at: c.created_at,
				})) as unknown as Conversation[],
				projectCreatedAt: data.project_created_at,
				projectReportMetrics: data.metrics,
				reportCreatedAt: data.report.date_created,
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
		refetchInterval: 60000,
	});
};

export const usePublicProjectReport = (projectId: string, reportId: number) => {
	return useQuery({
		enabled: !!projectId && reportId > 0,
		queryFn: () => getPublicProjectReportDetail(projectId, reportId),
		queryKey: ["public", "reports", reportId],
		refetchInterval: 60000,
	});
};

export const usePublicProjectReportViews = (projectId: string) => {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getPublicProjectReportViews(projectId),
		queryKey: ["public", "projects", projectId, "views"],
		refetchInterval: 60000,
	});
};

export type { ReportProgressEvent } from "./useReportProgress";
export { useReportProgress } from "./useReportProgress";
