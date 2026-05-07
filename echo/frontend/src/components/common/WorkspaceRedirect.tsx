import { Loader, Stack } from "@mantine/core";
import { Trans } from "@lingui/react/macro";
import { Navigate } from "react-router";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { useWorkspace } from "@/hooks/useWorkspace";

// Routes legacy /projects: resolved workspace → /w/:id/projects, multi-workspace → /w, none → fall through.
export const WorkspaceRedirect = () => {
	const { workspaceId, workspaces, isLoading, isError, refetch } =
		useWorkspace();

	if (isLoading) {
		return (
			<Stack align="center" justify="center" h="50vh">
				<Loader size="sm" color="gray" />
			</Stack>
		);
	}

	// Without this, a failed fetch reads as "no workspaces" — same UI as a brand-new account.
	if (isError) {
		return (
			<FetchErrorPanel
				onRetry={refetch}
				message={
					<Trans>
						We couldn't load your workspaces. Check your connection and try
						again.
					</Trans>
				}
			/>
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
