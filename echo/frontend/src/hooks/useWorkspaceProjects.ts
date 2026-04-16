import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { t } from "@lingui/core/macro";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";

interface V2ProjectSummary {
	id: string;
	name: string | null;
	updated_at: string | null;
	language: string | null;
	pin_order: number | null;
	conversations_count: number;
}

interface V2ProjectsResponse {
	projects: V2ProjectSummary[];
	total_count: number;
	has_more: boolean;
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
	if (!res.ok) {
		return { projects: [], total_count: 0, has_more: false };
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
			body: JSON.stringify({ name, language }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to create project");
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
		queryKey: ["v2", "workspace-projects", workspaceId, search],
		enabled: !!workspaceId,
		initialPageParam: 0,
		getNextPageParam: (lastPage: V2ProjectsResponse, _allPages, lastPageParam) =>
			lastPage.has_more ? lastPageParam + 1 : undefined,
		queryFn: async ({ pageParam = 0 }) => {
			if (!workspaceId) return { projects: [], total_count: 0, has_more: false };
			return fetchWorkspaceProjects(workspaceId, pageParam * limit, limit, search);
		},
	});
};

export const useCreateWorkspaceProject = () => {
	const { workspaceId } = useWorkspace();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ name, language }: { name: string; language: string }) => {
			if (!workspaceId) throw new Error("No workspace selected");
			return createWorkspaceProject(workspaceId, name, language);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
		},
		onError: (error: Error) => {
			toast.error(error.message || t`Failed to create project`);
		},
	});
};
