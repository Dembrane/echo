import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

// ── Types ──

interface WorkspaceSummary {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	role: string;
	is_default: boolean;
	tier: string;
	project_count: number;
	member_count: number;
	is_external: boolean;
}

export interface WorkspaceContextValue {
	workspaceId: string | null;
	workspaceName: string | null;
	workspace: WorkspaceSummary | null;
	workspaces: WorkspaceSummary[];
	isLoading: boolean;
	setWorkspace: (id: string) => void;
	clearWorkspace: () => void;
}

// ── Context ──

export const WorkspaceContext = createContext<WorkspaceContextValue>({
	workspaceId: null,
	workspaceName: null,
	workspace: null,
	workspaces: [],
	isLoading: true,
	setWorkspace: () => {},
	clearWorkspace: () => {},
});

export const useWorkspace = () => useContext(WorkspaceContext);

// ── Provider hook ──

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	try {
		const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
			credentials: "include",
		});
		if (!res.ok) return [];
		const data = await res.json();
		return data.workspaces ?? [];
	} catch {
		return [];
	}
}

const SESSION_KEY = "dembrane_ws_selected";

export function useWorkspaceProvider(enabled: boolean): WorkspaceContextValue {
	// Selection state — drives re-renders when user switches
	const [selectedId, setSelectedId] = useState<string | null>(
		() => typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null,
	);

	const { data: workspaces = [], isLoading } = useQuery({
		queryKey: ["v2", "workspaces-context"],
		queryFn: fetchWorkspaces,
		enabled,
		staleTime: 60_000,
		retry: false,
	});

	const resolved = useMemo(() => {
		if (workspaces.length === 0) return null;

		// Check if selection is still valid
		if (selectedId) {
			const found = workspaces.find((w) => w.id === selectedId);
			if (found) return found;
		}

		// Auto-select if only one workspace
		if (workspaces.length === 1) return workspaces[0];

		// Look for default workspace
		const defaultWs = workspaces.find((w) => w.is_default);
		if (defaultWs) return defaultWs;

		return null;
	}, [workspaces, selectedId]);

	const setWorkspace = useCallback((id: string) => {
		sessionStorage.setItem(SESSION_KEY, id);
		// Also persist across sessions so login can route back to last-used
		localStorage.setItem("dembrane_last_workspace_id", id);
		setSelectedId(id); // triggers re-render
	}, []);

	const clearWorkspace = useCallback(() => {
		sessionStorage.removeItem(SESSION_KEY);
		setSelectedId(null);
	}, []);

	return {
		workspaceId: resolved?.id ?? null,
		workspaceName: resolved?.name ?? null,
		workspace: resolved,
		workspaces,
		isLoading,
		setWorkspace,
		clearWorkspace,
	};
}
