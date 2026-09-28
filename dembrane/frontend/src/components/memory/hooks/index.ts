import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bff } from "@/lib/bff";

export type MemoryScope = "user" | "project" | "workspace";

export type AgentMemory = {
	id: string;
	scope: MemoryScope;
	memory_key: string | null;
	content: string | null;
	source: string | null;
	created_at: string | null;
	updated_at: string | null;
};

// One key family for every scope so a delete can invalidate all memory
// queries with the ["memory"] prefix.
export const memoryQueryKeys = {
	all: ["memory"] as const,
	project: (projectId: string) => ["memory", "project", projectId] as const,
	user: () => ["memory", "user"] as const,
	workspace: (workspaceId: string) =>
		["memory", "workspace", workspaceId] as const,
};

export const useUserMemories = () =>
	useQuery({
		queryFn: () => bff.get<AgentMemory[]>("/memory/user"),
		queryKey: memoryQueryKeys.user(),
	});

export const useProjectMemories = (projectId: string) =>
	useQuery({
		enabled: !!projectId,
		queryFn: () => bff.get<AgentMemory[]>(`/memory/project/${projectId}`),
		queryKey: memoryQueryKeys.project(projectId),
	});

export const useWorkspaceMemories = (workspaceId: string) =>
	useQuery({
		enabled: !!workspaceId,
		queryFn: () => bff.get<AgentMemory[]>(`/memory/workspace/${workspaceId}`),
		queryKey: memoryQueryKeys.workspace(workspaceId),
	});

export const useDeleteMemoryMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (memoryId: string) =>
			bff.delete<{ status: string }>(`/memory/${memoryId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all });
		},
	});
};
