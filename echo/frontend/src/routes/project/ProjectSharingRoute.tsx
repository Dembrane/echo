import { Trans } from "@lingui/react/macro";
import { Alert, Stack, Title } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router";
import { useProjectById } from "@/components/project/hooks";
import { ProjectSharingStrip } from "@/components/project/ProjectSharingStrip";

/**
 * The project Sharing tab. Host for the "Shared with" strip (always on) and
 * the "Who can see this project?" controls (visibility toggle + share list).
 *
 * Sibling of /portal-editor and /overview under /projects/:projectId.
 */
export const ProjectSharingRoute = () => {
	const { projectId } = useParams();
	const query = useMemo(
		() => ({
			fields: ["id", "name", "visibility", "workspace_id"],
		}),
		[],
	);
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		// @ts-expect-error visibility not in the generated Directus type yet
		query,
	});

	if (projectQuery.isError || !projectQuery.data) {
		return (
			<Stack px={{ base: "1rem", md: "2rem" }} py={{ base: "2rem", md: "4rem" }}>
				<Alert color="red" variant="outline">
					<Trans>We couldn't load this project. Try again.</Trans>
				</Alert>
			</Stack>
		);
	}

	const visibility =
		((projectQuery.data as unknown) as { visibility?: string }).visibility ===
		"private"
			? "private"
			: "workspace";

	return (
		<Stack
			gap="xl"
			px={{ base: "1rem", md: "2rem" }}
			py={{ base: "2rem", md: "3rem" }}
		>
			<Stack gap={4}>
				<Title order={4} fw={500}>
					<Trans>Sharing</Trans>
				</Title>
				<Stack gap={0}>
					<Trans>
						Decide who can see this project. Workspace-visible projects are
						open to everyone in the workspace; private projects are shared
						with specific people.
					</Trans>
				</Stack>
			</Stack>
			{projectId && (
				<ProjectSharingStrip projectId={projectId} visibility={visibility} />
			)}
		</Stack>
	);
};

export default ProjectSharingRoute;
