import { aggregate, readItem, readItems, updateItem } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createProjectReport, getProjectConversationCounts } from "@/lib/api";
import { directus } from "@/lib/directus";

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
		enabled: !!project_id,
		queryFn: async () => {
			if (!project_id) return 0;

			const result = await directus.request(
				aggregate("project_report_notification_participants", {
					aggregate: {
						count: "*",
					},
					query: {
						filter: {
							_and: [
								{ project_id: { _eq: project_id } },
								{ email_opt_in: { _eq: true } },
							],
						},
					},
				}),
			);
			return Number.parseInt(result[0]?.count ?? "0", 10) || 0;
		},
		queryKey: ["projectParticipants", project_id],
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
					fields: ["id", "date_created"],
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
						filter: { conversation_id: { _in: conversationIds } },
						groupBy: ["conversation_id"],
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
					limit: 1000,
					sort: "date_created",
				}),
			);

			// Return all structured data. The consuming component can then create the chart data arrays.
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

export const useDoesProjectReportNeedUpdate = (projectReportId: number) => {
	return useQuery({
		queryFn: async () => {
			const reports = await directus.request(
				readItems("project_report", {
					fields: ["id", "date_created", "project_id"],
					filter: {
						id: {
							_eq: projectReportId,
						},
						status: {
							_eq: "published",
						},
					},
					limit: 1,
					sort: "-date_created",
				}),
			);

			if (reports.length === 0) {
				return false;
			}

			const latestReport = reports[0];

			const latestConversation = await directus.request(
				readItems("conversation", {
					fields: ["id", "created_at"],
					filter: {
						project_id: {
							_eq: latestReport.project_id,
						},
					},
					limit: 1,
					sort: "-created_at",
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
		queryKey: ["reports", projectReportId, "needsUpdate"],
	});
};

export const useProjectReport = (reportId: number) => {
	return useQuery({
		queryFn: () =>
			directus.request(
				readItem("project_report", reportId, {
					fields: [
						"id",
						"status",
						"project_id",
						"content",
						"show_portal_link",
						"language",
						"date_created",
						"date_updated",
					],
				}),
			),
		queryKey: ["reports", reportId],
		refetchInterval: 30000,
	});
};

export const useProjectConversationCounts = (projectId: string) => {
	return useQuery({
		queryFn: () => getProjectConversationCounts(projectId),
		queryKey: ["projects", projectId, "conversation-counts"],
		refetchInterval: 15000,
	});
};

export const useProjectReportViews = (reportId: number) => {
	return useQuery({
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
							// in the last 10 mins
							date_created: {
								// @ts-expect-error
								_gte: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
							},
							project_report_id: {},
						},
					},
				}),
			);

			return {
				recent: recent[0].count,
				total: total[0].count,
			};
		},
		queryKey: ["reports", reportId, "views"],
		refetchInterval: 30000,
	});
};

export const useLatestProjectReport = (projectId: string) => {
	return useQuery({
		queryFn: async () => {
			const reports = await directus.request(
				readItems("project_report", {
					fields: ["id", "status", "project_id", "show_portal_link"],
					filter: {
						project_id: {
							_eq: projectId,
						},
					},
					limit: 1,
					sort: "-date_created",
				}),
			);

			if (reports.length === 0) {
				return null;
			}

			return reports[0];
		},
		queryKey: ["projects", projectId, "report"],
		refetchInterval: 30000,
	});
};
