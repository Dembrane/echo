import { useEffect } from "react";
import { Outlet, useParams } from "react-router";
import { useWorkspace } from "@/hooks/useWorkspace";

/**
 * Layout wrapper for /w/:workspaceId/* routes.
 * Reads workspaceId from URL and syncs it to workspace context.
 * Renders children via <Outlet />.
 */
export const WorkspaceLayout = () => {
	const { workspaceId: urlWorkspaceId } = useParams<{ workspaceId: string }>();
	const { workspaceId: contextWorkspaceId, setWorkspace } = useWorkspace();

	// Sync URL param to workspace context
	useEffect(() => {
		if (urlWorkspaceId && urlWorkspaceId !== contextWorkspaceId) {
			setWorkspace(urlWorkspaceId);
		}
	}, [urlWorkspaceId, contextWorkspaceId, setWorkspace]);

	return <Outlet />;
};
