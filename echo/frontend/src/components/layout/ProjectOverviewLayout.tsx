import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Divider,
	Group,
	LoadingOverlay,
	Stack,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconLock } from "@tabler/icons-react";
import { useParams } from "react-router";
import { useProjectById } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";
import { OngoingConversationsSummaryCard } from "../conversation/OngoingConversationsSummaryCard";
import { OpenForParticipationSummaryCard } from "../conversation/OpenForParticipationSummaryCard";
import { ProjectQRCode } from "../project/ProjectQRCode";
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
				"workspace_id",
				"is_conversation_allowed",
				"default_conversation_title",
			],
		},
	});

	useDocumentTitle(t`Project Overview | Dembrane`);
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
			{project && (isPrivate || project.language) && (
				<Group gap={8} align="center" wrap="nowrap" px="xs">
					{isPrivate && (
						<Tooltip label={t`Private · only invited people can see this`}>
							<IconLock size={16} color="var(--mantine-color-gray-6)" />
						</Tooltip>
					)}
					{project.language && (
						<Badge size="xs" variant="light" color="gray">
							{String(project.language).toUpperCase()}
						</Badge>
					)}
				</Group>
			)}
			<div className="grid grid-cols-12 place-content-stretch gap-3">
				<Box visibleFrom="lg" className="col-span-6 h-full">
					<ProjectQRCode project={projectQuery.data} />
				</Box>
				<Stack gap="sm" className="col-span-12 h-full lg:col-span-6">
					<OpenForParticipationSummaryCard projectId={projectId ?? ""} />
					<OngoingConversationsSummaryCard projectId={projectId ?? ""} />
				</Stack>
			</div>
			<Divider />
			<TabsWithRouter
				basePath="/projects/:projectId"
				tabs={[
					{ label: t`Portal Editor`, value: "portal-editor" },
					{ label: t`Project Settings`, value: "overview" },
				]}
				loading={projectQuery.isLoading}
				{...testId("project-overview-tabs")}
			/>
		</Stack>
	);
};
