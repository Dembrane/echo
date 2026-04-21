import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

// Mirrors ProjectShareResponse in server/dembrane/api/v2/project_sharing.py
export interface ProjectShare {
	user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	role: "viewer" | "editor";
	granted_by: string | null;
	created_at: string | null;
}

async function fetchShares(projectId: string): Promise<ProjectShare[]> {
	const res = await fetch(`${API_BASE_URL}/v2/projects/${projectId}/members`, {
		credentials: "include",
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

export const useProjectShares = (projectId: string | undefined) =>
	useQuery({
		queryKey: ["v2", "project-shares", projectId],
		queryFn: () => fetchShares(projectId as string),
		enabled: Boolean(projectId),
		staleTime: 30_000,
	});

export const useAddProjectShare = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (vars: { email: string; role: "viewer" | "editor" }) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/members`,
				{
					body: JSON.stringify(vars),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't add person");
			}
			return res.json() as Promise<ProjectShare>;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-shares", projectId],
			});
		},
	});
};

export const useChangeProjectShareRole = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (vars: { userId: string; role: "viewer" | "editor" }) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/members/${vars.userId}`,
				{
					body: JSON.stringify({ role: vars.role }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't change role");
			}
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-shares", projectId],
			});
		},
	});
};

export const useRevokeProjectShare = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (userId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/members/${userId}`,
				{ credentials: "include", method: "DELETE" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't revoke");
			}
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-shares", projectId],
			});
		},
	});
};

export const useSetProjectVisibility = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (visibility: "workspace" | "private") => {
			const res = await fetch(
				`${API_BASE_URL}/v2/projects/${projectId}/visibility`,
				{
					body: JSON.stringify({ visibility }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Couldn't change visibility");
			}
			return res.json() as Promise<{ status: string; visibility: string }>;
		},
		onSuccess: () => {
			// Project fetches live under ["projects", ...] (plural) —
			// see frontend/src/components/project/hooks/index.ts:365.
			// Invalidating the singular key was a silent no-op (round-2 audit).
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "project-shares", projectId],
			});
		},
	});
};
