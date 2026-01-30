import { t } from "@lingui/core/macro";
import { Box, Divider, LoadingOverlay, Stack } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
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
				"language",
				"is_conversation_allowed",
				"default_conversation_title",
			],
		},
	});

	useDocumentTitle(t`Project Overview | Dembrane`);

	return (
		<Stack
			className="relative px-2 py-4"
			style={{ backgroundColor: "var(--app-background)" }}
		>
			<LoadingOverlay visible={projectQuery.isLoading} />
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
