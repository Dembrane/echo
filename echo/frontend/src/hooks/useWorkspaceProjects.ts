import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { WorkspaceAccessDeniedError } from "@/lib/accessDenied";
import { ApiRequestError } from "@/lib/errors/read";

export interface ProjectAccessPreview {
	display_name: string;
	avatar: string | null;
}

interface V2ProjectSummary {
	id: string;
	name: string | null;
	updated_at: string | null;
	language: string | null;
	pin_order: number | null;
	conversations_count: number;
	audio_hours?: number;
	visibility?: "workspace" | "private";
	access_preview?: ProjectAccessPreview[];
	access_count?: number;
}

interface V2ProjectsResponse {
	pinned: V2ProjectSummary[];
	projects: V2ProjectSummary[];
	total_count: number;
	has_more: boolean;
	is_admin: boolean;
}

async function fetchWorkspaceProjects(
	workspaceId: string,
	offset: number,
	limit: number,
	search?: string,
): Promise<V2ProjectsResponse> {
	const params = new URLSearchParams();
	params.set("offset", String(offset));
	params.set("limit", String(limit));
	if (search) params.set("search", search);

	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/projects?${params}`,
		{ credentials: "include" },
	);
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		throw new WorkspaceAccessDeniedError(res.status);
	}
	if (!res.ok) {
		return {
			has_more: false,
			is_admin: false,
			pinned: [],
			projects: [],
			total_count: 0,
		};
	}
	return res.json();
}

async function createWorkspaceProject(
	workspaceId: string,
	name: string,
	language: string,
): Promise<{ id: string; name: string; workspace_id: string }> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/projects`,
		{
			body: JSON.stringify({ language, name }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

export const useWorkspaceProjects = ({
	search,
	limit = 15,
}: {
	search?: string;
	limit?: number;
}) => {
	const { workspaceId } = useWorkspace();

	return useInfiniteQuery({
		enabled: !!workspaceId,
		getNextPageParam: (
			lastPage: V2ProjectsResponse,
			_allPages,
			lastPageParam,
		) => (lastPage.has_more ? lastPageParam + 1 : undefined),
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			if (!workspaceId)
				return {
					has_more: false,
					is_admin: false,
					pinned: [],
					projects: [],
					total_count: 0,
				};
			return fetchWorkspaceProjects(
				workspaceId,
				pageParam * limit,
				limit,
				search,
			);
		},
		queryKey: ["v2", "workspace-projects", workspaceId, search],
		// Other members' creates/deletes show up within 30s without
		// needing a manual refresh. Idle tabs skip the poll.
		refetchInterval: 30_000,
		refetchIntervalInBackground: false,
		// 403/404 is stable — skip retries so the panel surfaces instantly.
		retry: (failureCount, err) =>
			err instanceof WorkspaceAccessDeniedError ? false : failureCount < 3,
	});
};

export const useCreateWorkspaceProject = () => {
	const { workspaceId } = useWorkspace();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			name,
			language,
		}: {
			name: string;
			language: string;
		}) => {
			if (!workspaceId) throw new Error("No workspace selected");
			return createWorkspaceProject(workspaceId, name, language);
		},
		onError: (error: Error) => {
			void notifyError(error);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
		},
	});
};
