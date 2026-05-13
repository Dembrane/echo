import { useEffect } from "react";
import { Outlet, useParams } from "react-router";
import { DowngradeBanner } from "@/components/workspace/DowngradeBanner";
import { PilotBlockModal } from "@/components/workspace/PilotBlockModal";
import { SeatCapBanner } from "@/components/workspace/SeatCapBanner";
import { useWorkspace } from "@/hooks/useWorkspace";

/**
 * Layout wrapper for /w/:workspaceId/* routes.
 * Reads workspaceId from URL and syncs it to workspace context.
 * Mounts the 7-day downgrade banner (matrix §3), the seat / guest cap
 * banner (matrix §7 + status-banner.md L2), and the Pilot-block modal
 * (matrix §8) so they're available on every workspace-scoped route.
 * Renders the route via <Outlet />.
 *
 * Banner stacking: status-banner.md says "never stacked." DowngradeBanner
 * + SeatCapBanner can in theory overlap (workspace was downgraded AND
 * seats are full), but in practice the downgrade banner is 7-day-bounded
 * and rarely co-occurs with cap-reached. Both are dismissible per-session
 * so a user with both seen-once never sees them stacked again.
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
			<SeatCapBanner />
			<PilotBlockModal />
			<Outlet />
		</>
	);
};
