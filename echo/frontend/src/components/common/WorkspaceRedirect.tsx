import { Navigate } from "react-router";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Loader, Stack } from "@mantine/core";

/**
 * Redirects /projects to /w/:workspaceId/projects when workspace context exists.
 * Falls through to old behavior if no workspace (un-onboarded user).
 */
export const WorkspaceRedirect = () => {
	const { workspaceId, isLoading } = useWorkspace();

	if (isLoading) {
		return (
			<Stack align="center" justify="center" h="50vh">
				<Loader size="sm" color="gray" />
			</Stack>
		);
	}

	if (workspaceId) {
		return <Navigate to={`/w/${workspaceId}/projects`} replace />;
	}

	// No workspace — fall through to legacy /projects
	return null;
};
