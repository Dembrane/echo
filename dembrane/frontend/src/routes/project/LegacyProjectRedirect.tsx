import { useQuery } from "@tanstack/react-query";
import { matchPath, Navigate, useLocation, useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import {
	API_BASE_URL,
	ENABLE_CANVAS,
	ENABLE_MONITOR,
	ENABLE_PRESENT,
} from "@/config";

const UUID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Project pages under /w/:workspaceId/projects/:projectId, gated as in Router.tsx.
const CURRENT_PATHS = [
	"access",
	"chats/:id",
	"chats/:id/debug",
	"chats/new",
	"conversations",
	"conversations/:id",
	"conversations/:id/debug",
	"debug",
	"export",
	"home",
	"host-guide",
	"integrations",
	"map",
	"overview",
	"portal-editor",
	"report",
	"sharing",
	"upload",
	"usage",
	...(ENABLE_MONITOR ? ["monitor"] : []),
	...(ENABLE_PRESENT
		? [
				"analysis",
				"analysis/:tab",
				"analysis/recipes/:id",
				"present",
				"present/:id/edit",
			]
		: []),
	...(ENABLE_CANVAS ? ["canvases/:id", "library", "library/popcorn"] : []),
];

const isCurrent = (path: string) =>
	CURRENT_PATHS.some((pattern) => matchPath(`/${pattern}`, `/${path}`));

/** Maps a pre-v3 project sub-path (after /projects/:projectId) to today's. */
export const mapLegacyProjectPath = (rest: string): string => {
	const segments = rest.split("/").filter(Boolean);
	const [head, id, tail] = segments;
	if (head === "conversation" || head === "conversations") {
		if (!id) return "conversations";
		return tail === "debug"
			? `conversations/${id}/debug`
			: `conversations/${id}`;
	}
	const path = segments.join("/");
	if (isCurrent(path)) return path;
	return head && isCurrent(head) ? head : "home";
};

async function fetchWorkspaceId(projectId: string): Promise<string | null> {
	const res = await fetch(`${API_BASE_URL}/v2/projects/${projectId}`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	const project: { workspace_id: string | null } = await res.json();
	return project.workspace_id;
}

export const LegacyProjectRedirect = () => {
	const { language, projectId, "*": rest = "" } = useParams();
	const { search, hash } = useLocation();
	const prefix = language ? `/${language}` : "";
	const valid = !!projectId && UUID_RE.test(projectId);

	const { data: workspaceId, isLoading } = useQuery({
		enabled: valid,
		queryFn: () => fetchWorkspaceId(projectId as string).catch(() => null),
		queryKey: ["legacy-project-workspace", projectId],
		retry: false,
	});

	if (valid && isLoading) return <BeautifulLoading />;

	if (!valid || !workspaceId) return <Navigate to={`${prefix}/`} replace />;

	return (
		<Navigate
			to={`${prefix}/w/${workspaceId}/projects/${projectId}/${mapLegacyProjectPath(rest)}${search}${hash}`}
			replace
		/>
	);
};
