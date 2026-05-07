import { Loader, Stack } from "@mantine/core";
import { Navigate } from "react-router";
import { useWorkspace } from "@/hooks/useWorkspace";

// Routes legacy /projects: resolved workspace → /w/:id/projects, multi-workspace → /w, none → fall through.
export const WorkspaceRedirect = () => {
	const { workspaceId, workspaces, isLoading } = useWorkspace();

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

	if (workspaces.length > 0) {
		return <Navigate to="/w" replace />;
	}

	return null;
};
