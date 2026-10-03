import { plural, t } from "@lingui/core/macro";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	addChatContext,
	api,
	type CreateCustomTopicPayload,
	cloneProjectById,
	createCustomVerificationTopic,
	deleteCustomVerificationTopic,
	deleteProjectById,
	deleteTagById,
	getVerificationTopics,
	type UpdateCustomTopicPayload,
	updateCustomVerificationTopic,
	type VerificationTopicsResponse,
} from "@/lib/api";
import type { ListQuery } from "@/lib/listQuery";

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
		onError: (
			error: unknown,
			_vars,
			// Typed here: onError sorts before onMutate, which TanStack infers the context from.
			ctx: { snapshots?: [readonly unknown[], unknown][] } | undefined,
		) => {
			if (ctx?.snapshots) {
				for (const [key, data] of ctx.snapshots) {
					queryClient.setQueryData(key, data);
				}
			}
			void notifyError(error);
		},
		// Optimistic update: move the project between pinned / list
		// immediately so the UI responds to the click. Without this the
		// user waits on the full refetch before the card jumps — on a
		// slow connection it looks like nothing happened. Rolls back
		// on error.
		onMutate: async ({ projectId, pin_order }) => {
			await queryClient.cancelQueries({
				queryKey: ["v2", "workspace-projects"],
			});

			type PageShape = {
				pinned: Array<
					{ id: string; pin_order: number | null } & Record<string, unknown>
				>;
				projects: Array<
					{ id: string; pin_order: number | null } & Record<string, unknown>
				>;
			};
			type CacheShape = { pages: PageShape[]; pageParams: unknown[] };

			const applyOptimistic = (
				data: CacheShape | undefined,
			): CacheShape | undefined => {
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
								].sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)),
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
				queryKey: ["v2", "workspace-projects"],
			})) {
				snapshots.push([key, data]);
				queryClient.setQueryData(key, applyOptimistic(data));
			}
			return { snapshots };
		},
		onSettled: () => {
			// Reconcile with the server regardless — optimistic state is a
			// guess; this is the ground truth.
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
		},
	});
};

export const useDeleteProjectByIdMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (projectId: string) => deleteProjectById(projectId),
		onError: (error: Error) => {
			void notifyError(error);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["projects"],
			});
			queryClient.resetQueries();
			toast.success(t`Project deleted`);
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
			void notifyError(error);
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

export const useMoveProjectMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			projectId,
			targetWorkspaceId,
		}: {
			projectId: string;
			targetWorkspaceId: string;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/projects/${projectId}/move`, {
				body: JSON.stringify({ target_workspace_id: targetWorkspaceId }),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new ApiRequestError(res.status, data);
			}
			return (await res.json()) as {
				project_id: string;
				workspace_id: string;
			};
		},
		onError: (error: Error) => {
			void notifyError(error);
		},
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.projectId],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-projects"],
			});
			toast.success(t`Project moved`);
		},
	});
};

export const useBulkMoveProjectsMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			projectIds,
			targetWorkspaceId,
		}: {
			projectIds: string[];
			targetWorkspaceId: string;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/projects/bulk-move`, {
				body: JSON.stringify({
					project_ids: projectIds,
					target_workspace_id: targetWorkspaceId,
				}),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new ApiRequestError(res.status, data);
			}
			return (await res.json()) as { moved: string[]; count: number };
		},
		onError: (error: Error) => {
			void notifyError(error);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			toast.success(t`Projects moved`);
		},
	});
};

/** Creates a project tag through the BFF tags endpoint. Shared by the portal
 * editor tag input mutation and the agentic tag-suggestion card. */
export const createProjectTag = async (payload: {
	projectId: string;
	text: string;
	sort?: number;
}) => {
	const res = await fetch(`${API_BASE_URL}/v2/bff/tags`, {
		body: JSON.stringify({
			project_id: payload.projectId,
			sort: payload.sort,
			text: payload.text,
		}),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
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
		}) =>
			createProjectTag({
				projectId: payload.project_id.id,
				sort: payload.sort,
				text: payload.text,
			}),
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
				throw new ApiRequestError(res.status, data);
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
		onError: (error: Error) => {
			void notifyError(error);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["projects"],
			});
			toast.success(t`Tag deleted`);
		},
	});
};

export const useCreateChatMutation = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { workspaceId } = useParams();
	return useMutation({
		mutationFn: async (payload: {
			navigateToNewChat?: boolean;
			project_id: {
				id: string;
			};
			/** Draft behind the conversation picker: no "Chat created" toast. */
			silent?: boolean;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/bff/chats`, {
				body: JSON.stringify({
					project_id: payload.project_id.id,
				}),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new ApiRequestError(res.status, data);
			}
			const chat = (await res.json()) as { id: string };

			if (payload.navigateToNewChat && chat?.id) {
				navigate(
					`/w/${workspaceId}/projects/${payload.project_id.id}/chats/${chat.id}`,
				);
			}

			return chat;
		},
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.project_id.id, "chats"],
			});
			if (variables.silent) return;
			toast.success(t`Chat created`);
		},
	});
};

/**
 * Attaches conversations picked before the chat existed, in one request.
 *
 * One call, not one per conversation. The server walks the whole batch in
 * order against a single running token budget, so it can attach as much as
 * fits and tell us exactly why it stopped. Firing a request per conversation
 * instead lets each one read the same starting context and pass, which puts a
 * Specific Details chat over its context limit and breaks its next message.
 *
 * Call this after initialize-mode: the server skips the budget for agentic
 * chats, and it can only tell that a chat is agentic once chat_mode is set.
 */
export const useAttachChatConversationsMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (payload: {
			chatId: string;
			projectId: string;
			conversationIds: string[];
		}) => {
			return addChatContext(payload.chatId, {
				conversationIds: payload.conversationIds,
				project_id: payload.projectId,
			});
		},
		onError: () => {
			// The chat itself is fine, so keep it and say what did not happen.
			toast.error(t`Could not add your conversations to this chat`);
		},
		onSuccess: (response, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["chats", variables.chatId],
			});

			const skipped = response?.skipped ?? [];
			if (skipped.length === 0) return;

			// Say why, not just how many. The context limit is the one a host can
			// act on (drop a conversation, or ask a narrower question).
			const overLimit = skipped.filter(
				(item) =>
					item.reason === "context_limit_reached" || item.reason === "too_long",
			).length;
			const empty = skipped.filter((item) => item.reason === "empty").length;

			if (overLimit > 0) {
				toast.error(
					plural(overLimit, {
						one: "# conversation did not fit in this chat. Start another chat to cover the rest.",
						other:
							"# conversations did not fit in this chat. Start another chat to cover the rest.",
					}),
				);
				return;
			}

			if (empty === skipped.length) {
				toast.error(
					plural(empty, {
						one: "# conversation has no transcript yet, so it was left out.",
						other:
							"# conversations have no transcript yet, so they were left out.",
					}),
				);
				return;
			}

			toast.error(
				plural(skipped.length, {
					one: "# conversation could not be added to this chat.",
					other: "# conversations could not be added to this chat.",
				}),
			);
		},
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
				throw new ApiRequestError(res.status, data);
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

// Autosaves the shared host guide on the project; success is silent
export const useUpdateProjectHostGuideMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			id,
			hostGuide,
		}: {
			id: string;
			hostGuide: Record<string, unknown> | null;
		}) => {
			const res = await fetch(`${API_BASE_URL}/v2/bff/projects/${id}`, {
				body: JSON.stringify({ host_guide: hostGuide }),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new ApiRequestError(res.status, data);
			}
			return (await res.json()) as Project;
		},
		onError: () => {
			toast.error(t`Could not save the host guide`);
		},
		onSuccess: (_values, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["projects", variables.id],
			});
		},
	});
};

export const useInfiniteProjects = ({
	query,
	options = {
		initialLimit: 15,
	},
}: {
	query: Partial<ListQuery<Project>>;
	options?: {
		initialLimit?: number;
		// What the BFF list understands; `query` itself is not forwarded.
		search?: string;
		workspaceId?: string | null;
		excludeProjectId?: string;
	};
}) => {
	const { initialLimit = 15, search, workspaceId, excludeProjectId } = options;

	return useInfiniteQuery({
		getNextPageParam: (lastPage: { nextOffset?: number }) =>
			lastPage.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			const params = new URLSearchParams({
				limit: String(initialLimit),
				offset: String(pageParam * initialLimit),
			});
			if (search) params.set("search", search);
			if (workspaceId) params.set("workspace_id", workspaceId);
			const response = await fetch(
				`${API_BASE_URL}/v2/bff/projects?${params}`,
				{ credentials: "include" },
			);
			if (!response.ok) {
				return { nextOffset: undefined, projects: [] as Project[] };
			}
			const data = (await response.json()) as Project[];
			return {
				nextOffset: data.length === initialLimit ? pageParam + 1 : undefined,
				projects: excludeProjectId
					? data.filter((p) => p.id !== excludeProjectId)
					: data,
			};
		},
		queryKey: ["projects", query, search, workspaceId, excludeProjectId],
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
	query?: Partial<ListQuery<Project>>;
}) => {
	return useQuery({
		// Skip the fetch when projectId hasn't resolved yet — otherwise we
		// hammer /api/v2/projects//bff with an empty id during transient
		// renders (sidebar mounts before scope params land).
		enabled: !!projectId,
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
			const scalarFields = rawFields.filter(
				(f): f is string => typeof f === "string" && f !== "*" && f !== "tags",
			);
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
				throw new ApiRequestError(res.status, data);
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
			void notifyError(error);
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
			void notifyError(error);
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
			void notifyError(error);
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

import { notifyError } from "@/components/error/notifyError";
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
import { ApiRequestError } from "@/lib/errors/read";

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
			void notifyError(error);
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
			void notifyError(error);
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
			void notifyError(error);
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
			void notifyError(error);
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
