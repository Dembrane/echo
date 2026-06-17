import { t } from "@lingui/core/macro";
import { Badge, Group, LoadingOverlay, Stack, Tooltip } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconLock } from "@tabler/icons-react";
import { useParams } from "react-router";
import { useProjectById } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";
import { TabsWithRouter } from "./TabsWithRouter";

export const ProjectOverviewLayout = () => {
	const projectId = useParams().projectId;
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: [
				"id",
				"name",
				"language",
				"visibility",
				"is_conversation_allowed",
				"default_conversation_title",
			],
		},
	});

	useDocumentTitle(t`Project Overview | dembrane`);
	const project = projectQuery.data;
	const isPrivate = project?.visibility === "private";
	// The project name already lives in the sidebar title (ProjectSidebar).
	// Usage / tier info deliberately absent — project pages are where
	// participants work, not where billing happens. Usage lives on the
	// workspace settings surface.

	return (
		<Stack
			className="relative px-2 py-4"
			style={{ backgroundColor: "var(--app-background)" }}
		>
			<LoadingOverlay visible={projectQuery.isLoading} />
			{project && isPrivate && (
				<Group gap={8} align="center" wrap="nowrap" px="xs">
					<Tooltip label={t`Private · only invited people can see this`}>
						<IconLock size={16} color="var(--mantine-color-gray-6)" />
					</Tooltip>
				</Group>
			)}
			<TabsWithRouter
				basePath="/w/:workspaceId/projects/:projectId"
					tabs={[
						{ label: t`Portal Editor`, value: "portal-editor" },
						{ label: t`Project Settings`, value: "overview" },
						{ label: t`Access`, value: "access" },
						{ label: t`Usage`, value: "usage" },
					]}
				loading={projectQuery.isLoading}
				{...testId("project-overview-tabs")}
			/>
		</Stack>
	);
};
