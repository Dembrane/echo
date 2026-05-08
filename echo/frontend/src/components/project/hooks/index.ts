import type { Query } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { useAddChatContextMutation } from "@/components/conversation/hooks";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	api,
	type CreateCustomTopicPayload,
	cloneProjectById,
	createCustomVerificationTopic,
	deleteCustomVerificationTopic,
	deleteProjectById,
	deleteTagById,
	getLatestProjectAnalysisRunByProjectId,
	getVerificationTopics,
	type UpdateCustomTopicPayload,
	updateCustomVerificationTopic,
	type VerificationTopicsResponse,
} from "@/lib/api";

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
	workspaceId,
}: {
	search?: string;
	limit?: number;
	workspaceId?: string | null;
}) => {
	return useInfiniteQuery({
		queryKey: ["projects", "home", workspaceId ?? null, search],
		initialPageParam: 0,
		getNextPageParam: (lastPage: BffProjectsHomeResponse, _allPages, lastPageParam) =>
			lastPage.has_more ? lastPageParam + 1 : undefined,
		queryFn: async ({ pageParam = 0 }) => {
			const params = new URLSearchParams();
			if (search) params.set("search", search);
			if (workspaceId) params.set("workspace_id", workspaceId);
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
		// Optimistic update: move the project between pinned / list
		// immediately so the UI responds to the click. Without this the
		// user waits on the full refetch before the card jumps — on a
		// slow connection it looks like nothing happened. Rolls back
		// on error. Applies to BOTH the v1 (/projects/home) cache and
		// the v2 workspace-projects cache — pre-fix the mutation only
		// invalidated v1, so pinning on /w/:id/projects looked broken.
		onMutate: async ({ projectId, pin_order }) => {
			await queryClient.cancelQueries({ queryKey: ["projects", "home"] });
			await queryClient.cancelQueries({ queryKey: ["v2", "workspace-projects"] });

			type PageShape = {
				pinned: Array<{ id: string; pin_order: number | null } & Record<string, unknown>>;
				projects: Array<{ id: string; pin_order: number | null } & Record<string, unknown>>;
			};
			type CacheShape = { pages: PageShape[]; pageParams: unknown[] };

			const applyOptimistic = (data: CacheShape | undefined): CacheShape | undefined => {
				if (!data?.pages?.length) return data;
				const firstPage = data.pages[0];
				const moving =
					firstPage.pinned.find((p) => p.id === projectId) ??
					data.pages.flatMap((p) => p.projects).find((p) => p.id === projectId);
				if (!moving) return data;

				const nextFirst: PageShape = {
					...firstPage,
					pinned:
						pin_order == null
							? firstPage.pinned.filter((p) => p.id !== projectId)
							: [
									...firstPage.pinned.filter((p) => p.id !== projectId),
									{ ...moving, pin_order },
								].sort(
									(a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0),
								),
					projects: firstPage.projects.map((p) =>
						p.id === projectId ? { ...p, pin_order } : p,
					),
				};
				const nextPages = [nextFirst, ...data.pages.slice(1)].map((page, i) =>
					i === 0
						? page
						: {
								...page,
								projects: page.projects.map((p) =>
									p.id === projectId ? { ...p, pin_order } : p,
								),
							},
				);
				return { ...data, pages: nextPages };
			};

			const snapshots: Array<[readonly unknown[], CacheShape | undefined]> = [];
			for (const [key, data] of queryClient.getQueriesData<CacheShape>({
				queryKey: ["projects", "home"],
			})) {
				snapshots.push([key, data]);
				queryClient.setQueryData(key, applyOptimistic(data));
			}
			for (const [key, data] of queryClient.getQueriesData<CacheShape>({
				queryKey: ["v2", "workspace-projects"],
			})) {
				snapshots.push([key, data]);
				queryClient.setQueryData(key, applyOptimistic(data));
			}
			return { snapshots };
		},
		onError: (error: any, _vars, ctx) => {
			if (ctx?.snapshots) {
				for (const [key, data] of ctx.snapshots) {
					queryClient.setQueryData(key, data);
				}
			}
			const detail = error?.response?.data?.detail;
			toast.error(detail ?? t`Failed to update pin`);
		},
		onSettled: () => {
			// Reconcile with the server regardless — optimistic state is a
			// guess; this is the ground truth. Both caches must be busted;
			// the v1 invalidate-alone version pre-fix missed the v2 key
			// and was the reported "pinned projects doesn't work without
			// refresh" bug.
			queryClient.invalidateQueries({ queryKey: ["projects", "home"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
		},
	});
};

export const useDeleteProjectByIdMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (projectId: string) => deleteProjectById(projectId),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["projects"],
			});
			queryClient.resetQueries();
			toast.success(t`Project deleted`);
		},
		onError: (error: Error) => {
			toast.error(error.message || t`Failed to delete project`);
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
		mutationFn: async (payload: {
			project_id: {
				id: string;
				directus_user_id: string;
			};
			text: string;
			sort?: number;
		}) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/bff/tags`,
				{
					body: JSON.stringify({
						project_id: payload.project_id.id,
						text: payload.text,
						sort: payload.sort,
					}),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to create tag");
			}
			return res.json();
		},
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
		mutationFn: async ({
			id,
			payload,
		}: {
			id: string;
			project_id: string;
			payload: Partial<ProjectTag>;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/bff/tags/${id}`, {
				body: JSON.stringify(payload),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to update tag");
			}
			return (await res.json()) as ProjectTag;
		},
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
		mutationFn: (payload: { tagId: string; projectId: string }) =>
			deleteTagById(payload.projectId, payload.tagId),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["projects"],
			});
			toast.success(t`Tag deleted`);
		},
		onError: (error: Error) => {
			toast.error(error.message || t`Failed to delete tag`);
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
			// BFF picks up auto_select default from the project's enhanced
			// audio flag when we don't force a value. Only override when a
			// specific conversation was passed — same rule as before.
			const res = await fetch(`${API_BASE_URL}/v2/bff/chats`, {
				body: JSON.stringify({
					project_id: payload.project_id.id,
					auto_select: payload.conversationId ? false : undefined,
				}),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to create chat");
			}
			const chat = (await res.json()) as { id: string };

			if (payload.navigateToNewChat && chat?.id) {
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
		mutationFn: async ({
			id,
			payload,
		}: {
			id: string;
			payload: Partial<Project>;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/bff/projects/${id}`, {
				body: JSON.stringify(payload),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to update project");
			}
			return (await res.json()) as Project;
		},
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
			void query; // advanced filter shapes not forwarded to BFF
			const response = await fetch(
				`${API_BASE_URL}/v2/bff/projects?limit=${initialLimit}&offset=${pageParam * initialLimit}`,
				{ credentials: "include" },
			);
			if (!response.ok) {
				return { nextOffset: undefined, projects: [] as Project[] };
			}
			const data = (await response.json()) as Project[];
			return {
				nextOffset: data.length === initialLimit ? pageParam + 1 : undefined,
				projects: data,
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
		// BFF migration (2026-04-24): the frontend used to call Directus
		// directly via readItem("project", ...), but Directus row-level
		// ACL doesn't know about our v2 inheritance/sharing model — a
		// workspace member reaching a project through a derived organisation
		// admin row was 403'ing on the Directus read. The /bff endpoint
		// runs the access check through get_user_project_access and
		// returns the full project row (with sorted tags) under the
		// admin client. Keeps the same return shape so callers don't
		// change.
		queryFn: async () => {
			const rawFields = Array.isArray(query?.fields) ? query.fields : [];
			const includeTags = rawFields.some(
				(f) =>
					(typeof f === "string" && f === "tags") ||
					(typeof f === "object" && f !== null && "tags" in f),
			);
			// Collect scalar field names (ignore wildcard `*` and tag
			// relation entries). When a caller passes a narrow list we
			// forward it to the BFF so the response stays small — used
			// by summary-card callers who just need one boolean. Empty
			// or `*` means "give me everything".
			const scalarFields = rawFields
				.filter((f): f is string => typeof f === "string" && f !== "*" && f !== "tags");
			const url = new URL(
				`${API_BASE_URL}/v2/projects/${projectId}/bff`,
				window.location.origin,
			);
			if (!includeTags) url.searchParams.set("include_tags", "false");
			if (scalarFields.length > 0) {
				url.searchParams.set("fields", scalarFields.join(","));
			}
			const res = await fetch(url.toString(), { credentials: "include" });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to load project");
			}
			return (await res.json()) as Project;
		},
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
