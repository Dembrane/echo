import {
	createItem,
	deleteItem,
	type Query,
	readItem,
	readItems,
	updateItem,
} from "@directus/sdk";
import { t } from "@lingui/core/macro";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { useAddChatContextMutation } from "@/components/conversation/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	api,
	type CreateCustomTopicPayload,
	cloneProjectById,
	createCustomVerificationTopic,
	deleteCustomVerificationTopic,
	getLatestProjectAnalysisRunByProjectId,
	getVerificationTopics,
	type UpdateCustomTopicPayload,
	updateCustomVerificationTopic,
	type VerificationTopicsResponse,
} from "@/lib/api";
import { directus } from "@/lib/directus";

// ── BFF: Projects Home ──────────────────────────────────────────────────

interface BffProjectSummary {
	id: string;
	name: string | null;
	updated_at: string | null;
	language: string | null;
	pin_order: number | null;
	conversations_count: number;
	owner_name?: string;
	owner_email?: string;
}

interface BffProjectsHomeResponse {
	pinned: BffProjectSummary[];
	projects: BffProjectSummary[];
	total_count: number;
	has_more: boolean;
	is_admin: boolean;
}

export const useProjectsHome = ({
	search,
	limit = 15,
}: {
	search?: string;
	limit?: number;
}) => {
	return useInfiniteQuery({
		queryKey: ["projects", "home", search],
		initialPageParam: 0,
		getNextPageParam: (lastPage: BffProjectsHomeResponse, _allPages, lastPageParam) =>
			lastPage.has_more ? lastPageParam + 1 : undefined,
		queryFn: async ({ pageParam = 0 }) => {
			const params = new URLSearchParams();
			if (search) params.set("search", search);
			params.set("offset", String(pageParam * limit));
			params.set("limit", String(limit));
			const resp = await api.get<unknown, BffProjectsHomeResponse>(
				`/projects/home?${params.toString()}`,
			);
			return resp;
		},
	});
};

export const useTogglePinMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			projectId,
			pin_order,
		}: {
			projectId: string;
			pin_order: number | null;
		}) => {
			return api.patch(`/projects/${projectId}/pin`, { pin_order });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
		},
		onError: (error: any) => {
			const detail = error?.response?.data?.detail;
			toast.error(detail ?? t`Failed to update pin`);
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

export const useCloneProjectByIdMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			payload,
		}: {
			id: string;
			payload?: { name?: string; language?: string };
		}) =>
			cloneProjectById({
				projectId: id,
				...(payload ?? {}),
			}),
		onError: (error) => {
			console.error(error);
			toast.error("Error cloning project");
		},
		onSuccess: (newProjectId, variables) => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			if (variables?.id) {
				queryClient.invalidateQueries({ queryKey: ["projects", variables.id] });
			}
			if (newProjectId) {
				queryClient.invalidateQueries({
					queryKey: ["projects", newProjectId],
				});
			}
			toast.success("Project cloned successfully");
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
				readItem("project", payload.project_id.id, {
					fields: ["is_enhanced_audio_processing_enabled"],
				}),
			);

			const chat = await directus.request(
				createItem("project_chat", {
					// Don't set chat_mode here - use initialize-mode endpoint instead
					auto_select:
						payload.conversationId &&
						project.is_enhanced_audio_processing_enabled
							? false
							: !!project.is_enhanced_audio_processing_enabled,
					project_id: payload.project_id,
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
		queryFn: () => getLatestProjectAnalysisRunByProjectId(projectId),
		queryKey: ["projects", projectId, "latest_analysis"],
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
		onError: (e) => {
			console.error(e);
			toast.error("Error creating project");
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			toast.success("Project created successfully");
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
		getNextPageParam: (lastPage: { nextOffset?: number }) =>
			lastPage.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			const response = await directus.request(
				readItems("project", {
					...query,
					limit: initialLimit,
					offset: pageParam * initialLimit,
				}),
			);

			return {
				nextOffset:
					response.length === initialLimit ? pageParam + 1 : undefined,
				projects: response.map((r) => ({
					...r,
				})),
			};
		},
		queryKey: ["projects", query],
	});
};

export const useProjectById = ({
	projectId,
	query = {
		deep: {
			tags: {
				_sort: "sort",
			},
		},
		fields: [
			"*",
			{
				tags: ["id", "created_at", "text", "sort"],
			},
		],
	},
}: {
	projectId: string;
	query?: Partial<Query<CustomDirectusTypes, Project>>;
}) => {
	return useQuery({
		queryFn: () =>
			directus.request<Project>(readItem("project", projectId, query)),
		queryKey: ["projects", projectId, query],
	});
};

export const useVerificationTopicsQuery = (projectId: string | undefined) => {
	return useQuery({
		enabled: !!projectId,
		// biome-ignore lint/style/noNonNullAssertion: <this is guaranteed to be defined>
		queryFn: () => getVerificationTopics(projectId!),
		queryKey: ["verify", "topics", projectId],
	});
};

export const useCreateCustomTopicMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			payload,
		}: {
			projectId: string;
			payload: CreateCustomTopicPayload;
		}) => createCustomVerificationTopic(projectId, payload),
		onError: (error: any) => {
			toast.error(
				error?.response?.data?.detail || t`Failed to create custom topic`,
			);
		},
		onSuccess: (data: VerificationTopicsResponse, variables) => {
			queryClient.setQueryData(["verify", "topics", variables.projectId], data);
			queryClient.invalidateQueries({
				queryKey: ["verify", "topics", variables.projectId],
			});
			toast.success(t`Topic created successfully`);
		},
	});
};

export const useUpdateCustomTopicMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			topicKey,
			payload,
		}: {
			projectId: string;
			topicKey: string;
			payload: UpdateCustomTopicPayload;
		}) => updateCustomVerificationTopic(projectId, topicKey, payload),
		onError: (error: any) => {
			toast.error(
				error?.response?.data?.detail || t`Failed to update custom topic`,
			);
		},
		onSuccess: (data: VerificationTopicsResponse, variables) => {
			queryClient.setQueryData(["verify", "topics", variables.projectId], data);
			queryClient.invalidateQueries({
				queryKey: ["verify", "topics", variables.projectId],
			});
			toast.success(t`Topic updated successfully`);
		},
	});
};

export const useDeleteCustomTopicMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			topicKey,
		}: {
			projectId: string;
			topicKey: string;
		}) => deleteCustomVerificationTopic(projectId, topicKey),
		onError: (error: any) => {
			toast.error(
				error?.response?.data?.detail || t`Failed to delete custom topic`,
			);
		},
		onSuccess: (data: VerificationTopicsResponse, variables) => {
			queryClient.setQueryData(["verify", "topics", variables.projectId], data);
			queryClient.invalidateQueries({
				queryKey: ["verify", "topics", variables.projectId],
			});
			toast.success(t`Topic deleted successfully`);
		},
	});
};

// =============================================================================
// Webhook Hooks
// =============================================================================

import {
	createProjectWebhook,
	deleteProjectWebhook,
	getCopyableWebhooks,
	getProjectWebhooks,
	testProjectWebhook,
	updateProjectWebhook,
	type WebhookCreatePayload,
	type WebhookUpdatePayload,
} from "@/lib/api";

export const useProjectWebhooks = (projectId: string | undefined) => {
	return useQuery({
		enabled: !!projectId,
		// biome-ignore lint/style/noNonNullAssertion: <this is guaranteed to be defined>
		queryFn: () => getProjectWebhooks(projectId!),
		queryKey: ["projects", projectId, "webhooks"],
	});
};

export const useCopyableWebhooks = (projectId: string | undefined) => {
	return useQuery({
		enabled: !!projectId,
		// biome-ignore lint/style/noNonNullAssertion: <this is guaranteed to be defined>
		queryFn: () => getCopyableWebhooks(projectId!),
		queryKey: ["projects", projectId, "webhooks", "copyable"],
	});
};

export const useCreateWebhookMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			payload,
		}: {
			projectId: string;
			payload: WebhookCreatePayload;
		}) => createProjectWebhook(projectId, payload),
		onError: (error: any) => {
			const message =
				error?.response?.data?.detail || "Failed to create webhook";
			toast.error(message);
		},
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.projectId, "webhooks"],
			});
			toast.success("Webhook created successfully");
		},
	});
};

export const useUpdateWebhookMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			webhookId,
			payload,
		}: {
			projectId: string;
			webhookId: string;
			payload: WebhookUpdatePayload;
		}) => updateProjectWebhook(projectId, webhookId, payload),
		onError: (error: any) => {
			const message =
				error?.response?.data?.detail || "Failed to update webhook";
			toast.error(message);
		},
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.projectId, "webhooks"],
			});
			toast.success("Webhook updated successfully");
		},
	});
};

export const useDeleteWebhookMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			webhookId,
		}: {
			projectId: string;
			webhookId: string;
		}) => deleteProjectWebhook(projectId, webhookId),
		onError: (error: any) => {
			const message =
				error?.response?.data?.detail || "Failed to delete webhook";
			toast.error(message);
		},
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.projectId, "webhooks"],
			});
			toast.success("Webhook deleted successfully");
		},
	});
};

export const useTestWebhookMutation = () => {
	return useMutation({
		mutationFn: ({
			projectId,
			webhookId,
		}: {
			projectId: string;
			webhookId: string;
		}) => testProjectWebhook(projectId, webhookId),
		onError: (error: any) => {
			const message = error?.response?.data?.detail || "Failed to test webhook";
			toast.error(message);
		},
		onSuccess: (result) => {
			if (result.success) {
				toast.success(result.message);
			} else {
				toast.error(result.message);
			}
		},
	});
};
