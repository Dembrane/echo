import { createContext, useCallback, useContext, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
	/** Currently selected workspace ID. Null if not onboarded or no workspaces. */
	workspaceId: string | null;
	/** Currently selected workspace name. */
	workspaceName: string | null;
	/** Full workspace object if available. */
	workspace: WorkspaceSummary | null;
	/** All workspaces the user has access to. */
	workspaces: WorkspaceSummary[];
	/** Whether workspace data is still loading. */
	isLoading: boolean;
	/** Select a workspace by ID. */
	setWorkspace: (id: string) => void;
	/** Clear selection (go back to selector). */
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

/**
 * Selection is stored in sessionStorage (survives refresh, clears on tab close).
 * This is intentional — it's a UI preference, not persistent state.
 * If the user opens a new tab, they get the default workspace.
 */
const SESSION_KEY = "dembrane_ws_selected";

export function useWorkspaceProvider(enabled: boolean): WorkspaceContextValue {
	const queryClient = useQueryClient();

	const { data: workspaces = [], isLoading } = useQuery({
		queryKey: ["v2", "workspaces-context"],
		queryFn: fetchWorkspaces,
		enabled,
		staleTime: 60_000,
		retry: false,
	});

	// Read selection from sessionStorage
	const storedId = typeof window !== "undefined"
		? sessionStorage.getItem(SESSION_KEY)
		: null;

	// Resolve current workspace:
	// 1. If user selected one → use it (if still valid)
	// 2. If only 1 workspace → auto-select
	// 3. Otherwise → null (show selector)
	const resolved = useMemo(() => {
		if (workspaces.length === 0) return null;

		// Check if stored selection is still valid
		if (storedId) {
			const found = workspaces.find((w) => w.id === storedId);
			if (found) return found;
		}

		// Auto-select if only one workspace
		if (workspaces.length === 1) return workspaces[0];

		// Look for default workspace
		const defaultWs = workspaces.find((w) => w.is_default);
		if (defaultWs) return defaultWs;

		return null;
	}, [workspaces, storedId]);

	const setWorkspace = useCallback(
		(id: string) => {
			sessionStorage.setItem(SESSION_KEY, id);
			// Force re-render by invalidating the query
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
		},
		[queryClient],
	);

	const clearWorkspace = useCallback(() => {
		sessionStorage.removeItem(SESSION_KEY);
		queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
	}, [queryClient]);

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
