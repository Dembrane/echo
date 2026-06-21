import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { AUTH_CACHE_BOUNDARY_EVENT } from "@/lib/authCacheBoundary";

// Per-user so login routing never sends a user to the previous user's workspace.
export function lastWorkspaceKey(userId: string): string {
	return `dembrane_last_workspace_id:${userId}`;
}

// ── Types ──

interface WorkspaceUsageGates {
	over_cap_active: boolean;
	uploads_locked: boolean;
	upgrade_cta_tier: string | null;
}

interface WorkspaceUsageSummary {
	audio_hours: number;
	conversation_count: number;
	audio_hours_this_month: number;
	conversations_this_month: number;
	hours_included: number | null;
	hours_pct: number | null;
	at_cap: boolean;
	approaching_cap: boolean;
	usage_gates: WorkspaceUsageGates;
}

interface WorkspaceSummary {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	role: string;
	is_default: boolean;
	tier: string;
	// True when the current user is the named data owner of this external-client
	// workspace (ISSUE-026).
	is_data_owner?: boolean;
	logo_url: string | null;
	org_logo_url: string | null;
	project_count: number;
	member_count: number;
	usage?: WorkspaceUsageSummary;
	// Matrix v1.1 §3 downgrade banner fields.
	downgraded_at?: string | null;
	downgraded_from_tier?: string | null;
}

export interface WorkspaceContextValue {
	workspaceId: string | null;
	workspaceName: string | null;
	workspace: WorkspaceSummary | null;
	workspaces: WorkspaceSummary[];
	isLoading: boolean;
	// Distinct from "0 workspaces" so callers can show an error banner.
	isError: boolean;
	refetch: () => void;
	setWorkspace: (id: string) => void;
	clearWorkspace: () => void;
}

// ── Context ──

export const WorkspaceContext = createContext<WorkspaceContextValue>({
	clearWorkspace: () => {},
	isError: false,
	isLoading: true,
	refetch: () => {},
	setWorkspace: () => {},
	workspace: null,
	workspaceId: null,
	workspaceName: null,
	workspaces: [],
});

export const useWorkspace = () => useContext(WorkspaceContext);

// ── Provider hook ──

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	if (res.status === 401 || res.status === 403) {
		return [];
	}
	if (!res.ok) {
		throw new Error(`Workspaces request failed (${res.status})`);
	}
	const data = await res.json();
	return data.workspaces ?? [];
}

const SESSION_KEY = "dembrane_ws_selected";

// Pull a workspace UUID out of /w/:id/... paths so the provider can
// resolve before WorkspaceLayout mounts and fires its sync effect.
// Without this, a direct link to /w/<id>/projects renders the header
// with no workspace name until the next tick — the 2026-04-23 bug
// "don't see the workspace on the nav bar".
const UUID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function readWorkspaceIdFromPath(): string | null {
	if (typeof window === "undefined") return null;
	const segments = window.location.pathname.split("/").filter(Boolean);
	// Strip locale prefix (en-US, nl-NL, …)
	if (segments[0] && /^[a-z]{2}(-[A-Z]{2})?$/.test(segments[0])) {
		segments.shift();
	}
	if (segments[0] !== "w" || !segments[1]) return null;
	return UUID_RE.test(segments[1]) ? segments[1] : null;
}

export function useWorkspaceProvider(enabled: boolean): WorkspaceContextValue {
	const [authEpoch, setAuthEpoch] = useState(0);
	const { data: me } = useV2Me({ enabled });
	const userId = me?.directus_user_id ?? null;

	useEffect(() => {
		const onAuthBoundary = () => setAuthEpoch((epoch) => epoch + 1);
		window.addEventListener(AUTH_CACHE_BOUNDARY_EVENT, onAuthBoundary);
		return () =>
			window.removeEventListener(AUTH_CACHE_BOUNDARY_EVENT, onAuthBoundary);
	}, []);

	// Selection state — drives re-renders when user switches. Seed with
	// (1) current URL's workspace id if present, (2) session, or (3) null.
	// URL wins over session so deep-linking into another workspace doesn't
	// briefly flash the previously-selected one.
	const [selectedId, setSelectedId] = useState<string | null>(() => {
		const fromUrl = readWorkspaceIdFromPath();
		if (fromUrl) return fromUrl;
		return typeof window !== "undefined"
			? sessionStorage.getItem(SESSION_KEY)
			: null;
	});

	const {
		data: workspaces = [],
		isLoading,
		isError,
		refetch,
	} = useQuery({
		enabled,
		queryFn: fetchWorkspaces,
		queryKey: ["v2", "workspaces-context", authEpoch],
		// One retry — this query wraps the entire app, so retry: false was app-wide brittle.
		retry: 1,
		staleTime: 60_000,
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

	const setWorkspace = useCallback(
		(id: string) => {
			sessionStorage.setItem(SESSION_KEY, id);
			// Persist across sessions so login can route back to last-used.
			if (userId) {
				localStorage.setItem(lastWorkspaceKey(userId), id);
			}
			setSelectedId(id); // triggers re-render
		},
		[userId],
	);

	const clearWorkspace = useCallback(() => {
		sessionStorage.removeItem(SESSION_KEY);
		setSelectedId(null);
	}, []);

	return {
		clearWorkspace,
		isError,
		isLoading,
		refetch: () => {
			refetch();
		},
		setWorkspace,
		workspace: resolved,
		workspaceId: resolved?.id ?? null,
		workspaceName: resolved?.name ?? null,
		workspaces,
	};
}
