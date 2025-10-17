import {
	createItem,
	deleteItem,
	type Query,
	readItem,
	readItems,
	updateItem,
} from "@directus/sdk";
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
	cloneProjectById,
	getLatestProjectAnalysisRunByProjectId,
} from "@/lib/api";
import { directus } from "@/lib/directus";

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
				readItem("project", payload.project_id.id),
			);

			const chat = await directus.request(
				createItem("project_chat", {
					...(payload as any),
					auto_select:
						payload.conversationId &&
						project.is_enhanced_audio_processing_enabled
							? false
							: !!project.is_enhanced_audio_processing_enabled,
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
				projects: response,
			};
		},
		queryKey: ["projects", query],
	});
};

export const useProjectById = ({
	projectId,
	query = {
		deep: {
			// @ts-expect-error tags won't be typed
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
