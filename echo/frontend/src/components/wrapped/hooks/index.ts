import { aggregate, readItems } from "@directus/sdk";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { directus } from "@/lib/directus";

export type WrappedStats = {
	totalProjects: number;
	totalConversations: number;
	totalChunks: number;
	totalChats: number;
	totalChatMessages: number;
	firstProjectDate: string | null;
	mostActiveProject: {
		id: string;
		name: string;
		conversationCount: number;
	} | null;
	longestConversation: {
		id: string;
		name: string;
		duration: number;
	} | null;
	favoriteLanguage: string | null;
	totalRecordingMinutes: number;
	memberSince: string | null;
	topTags: Array<{ text: string; count: number }>;
};

export const useWrappedStats = (enabled = false) => {
	const { data: user } = useCurrentUser();

	return useQuery({
		enabled: enabled && !!user?.id,
		queryFn: async (): Promise<WrappedStats> => {
			// Calculate date range for previous year
			const year = new Date().getUTCFullYear() - 1;
			const startDate = `${year}-01-01T00:00:00.000Z`;
			const endDate = `${year}-12-31T23:59:59.999Z`;

			// Fetch all user's projects created in previous year
			const projects = await directus.request(
				readItems("project", {
					fields: [
						"id",
						"name",
						"created_at",
						"language",
						"count(conversations)",
					],
					filter: {
						created_at: {
							_gte: startDate,
							_lte: endDate,
						},
					},
					limit: -1,
					sort: "created_at",
				}),
			);

			const totalProjects = projects.length;
			const firstProjectDate = projects[0]?.created_at ?? null;

			// Find most active project
			let mostActiveProject = null;
			let maxConversations = 0;
			for (const project of projects) {
				const count =
					(project as any).conversations_count ??
					project.conversations?.length ??
					0;
				if (count > maxConversations) {
					maxConversations = count;
					mostActiveProject = {
						conversationCount: count,
						id: project.id,
						name: project.name ?? "Unnamed Project",
					};
				}
			}

			// Get project IDs
			const projectIds = projects.map((p) => p.id);

			// Fetch conversations for these projects
			let conversations: any[] = [];
			let totalConversations = 0;

			if (projectIds.length > 0) {
				const conversationResult = await directus.request(
					aggregate("conversation", {
						aggregate: { count: "*" },

						filter: {
							created_at: {
								_gte: startDate,
								_lte: endDate,
							},
							project_id: { _in: projectIds },
						},
					}),
				);
				totalConversations = Number(conversationResult[0]?.count ?? 0);

				// Get conversations with duration for longest conversation
				conversations = await directus.request(
					readItems("conversation", {
						fields: ["id", "participant_name", "duration", "project_id"],
						filter: {
							created_at: {
								_gte: startDate,
								_lte: endDate,
							},
							duration: { _nnull: true },
							project_id: { _in: projectIds },
						},
						limit: 1,
						sort: "-duration",
					}),
				);
			}

			const longestConversation =
				conversations.length > 0
					? {
							duration: conversations[0].duration ?? 0,
							id: conversations[0].id,
							name: conversations[0].participant_name ?? "Unnamed",
						}
					: null;

			// Fetch chunks count
			let totalChunks = 0;
			if (projectIds.length > 0) {
				const chunkResult = await directus.request(
					aggregate("conversation_chunk", {
						aggregate: { count: "*" },
						query: {
							filter: {
								conversation_id: {
									created_at: {
										_gte: startDate,
										_lte: endDate,
									},
									project_id: { _in: projectIds },
								},
							},
						},
					}),
				);
				totalChunks = Number(chunkResult[0]?.count ?? 0);
			}

			// Fetch chats count (only chats with messages)
			let totalChats = 0;
			let totalChatMessages = 0;
			if (projectIds.length > 0) {
				const chatResult = await directus.request(
					aggregate("project_chat", {
						aggregate: { count: "*" },
						query: {
							filter: {
								"count(project_chat_messages)": {
									_gt: 0,
								},
								date_created: {
									_gte: startDate,
									_lte: endDate,
								},
								project_id: { _in: projectIds },
							},
						},
					}),
				);
				totalChats = Number(chatResult[0]?.count ?? 0);

				// Fetch chat messages count
				const chatMessagesResult = await directus.request(
					aggregate("project_chat_message", {
						aggregate: { count: "*" },
						query: {
							filter: {
								date_created: {
									_gte: startDate,
									_lte: endDate,
								},
								project_chat_id: {
									project_id: { _in: projectIds },
								},
							},
						},
					}),
				);
				totalChatMessages = Number(chatMessagesResult[0]?.count ?? 0);
			}

			// Calculate favorite language
			const languageCounts: Record<string, number> = {};
			for (const project of projects) {
				const lang = project.language ?? "en";
				languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;
			}
			const favoriteLanguage =
				Object.entries(languageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
				null;

			// Calculate total recording minutes from conversation durations
			let totalRecordingMinutes = 0;
			if (projectIds.length > 0) {
				const durationResult = await directus.request(
					aggregate("conversation", {
						aggregate: { sum: ["duration"] },
						filter: {
							filter: {
								created_at: {
									_gte: startDate,
									_lte: endDate,
								},
								duration: { _nnull: true },
								project_id: { _in: projectIds },
							},
						},
					}),
				);
				const totalSeconds = Number(
					(durationResult[0] as any)?.sum?.duration ?? 0,
				);
				totalRecordingMinutes = Math.round(totalSeconds / 60);
			}

			// Fetch top tags
			let topTags: Array<{ text: string; count: number }> = [];
			if (projectIds.length > 0) {
				const tags = await directus.request(
					readItems("project_tag", {
						fields: ["id", "text", "count(conversations)"],
						filter: {
							project_id: { _in: projectIds },
						},
						limit: 5,
					}),
				);
				topTags = tags
					.filter((t) => t.text)
					.map((t) => ({
						count: (t as any).conversations_count ?? 0,
						text: t.text ?? "",
					}))
					.sort((a, b) => b.count - a.count);
			}

			return {
				favoriteLanguage,
				firstProjectDate: firstProjectDate?.toString() ?? null,
				longestConversation,
				memberSince: (user as any)?.date_created?.toString() ?? null,
				mostActiveProject,
				topTags,
				totalChatMessages,
				totalChats,
				totalChunks,
				totalConversations,
				totalProjects,
				totalRecordingMinutes,
			};
		},
		queryKey: ["wrapped", "stats", user?.id],
		staleTime: 1000 * 60 * 30, // 30 minutes - wrapped data doesn't change frequently
	});
};

// Drawer state management
export const useWrappedDrawer = () => {
	const [isOpen, setIsOpen] = useState(false);

	const open = useCallback(() => setIsOpen(true), []);
	const close = useCallback(() => setIsOpen(false), []);
	const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

	return {
		close,
		isOpen,
		open,
		toggle,
	};
};
