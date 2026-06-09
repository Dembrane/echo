import { useEffect } from "react";
import { Outlet, useParams } from "react-router";
import { DowngradeBanner } from "@/components/workspace/DowngradeBanner";
import { PilotBlockModal } from "@/components/workspace/PilotBlockModal";
import { useWorkspace } from "@/hooks/useWorkspace";

/**
 * Layout wrapper for /w/:workspaceId/* routes.
 * Reads workspaceId from URL and syncs it to workspace context.
 * Mounts the 7-day downgrade banner (matrix §3) and the Pilot-block modal
 * (matrix §8) so they're available on every workspace-scoped route.
 * SeatCapBanner lives inside BaseLayout's main column so it doesn't span
 * across the sidebar (it self-gates on workspaceId).
 * Renders the route via <Outlet />.
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

	return (
		<>
			<DowngradeBanner />
			<PilotBlockModal />
			<Outlet />
		</>
	);
};
