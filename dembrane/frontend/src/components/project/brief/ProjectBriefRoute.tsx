import { t } from "@lingui/core/macro";
import { Divider, Stack, Text, Title } from "@mantine/core";
import { useMemo } from "react";
import { useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { ProjectGoalSection } from "@/components/goal/ProjectGoalSection";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProjectMemorySection } from "@/components/memory/ProjectMemorySection";
import { ProjectMethodologySection } from "@/components/methodology/ProjectMethodologySection";
import { useProjectById } from "@/components/project/hooks";
import ProjectBasicEdit from "@/components/project/ProjectBasicEdit";
import { useSettingsCatalog } from "@/components/project/portal-editor/i18n";
import { useWorkspace } from "@/hooks/useWorkspace";
import { canUseChat, isReadOnlyRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";
import { ProjectKeyTermsSection } from "./ProjectKeyTermsSection";

/**
 * Brief (ECHO-1060): what the project is about, on one calm page. Name and context, goal,
 * key terms, the analysis methodology and memory, each section saving itself as it did on
 * the old General page and in the portal editor.
 */
export const ProjectBriefRoute = () => {
	const { projectId } = useParams();
	const ready = useSettingsCatalog();
	const query = useMemo(
		() => ({
			fields: [
				"id",
				"name",
				"context",
				"visibility",
				"workspace_id",
				"methodology_version_id",
				"updated_at",
				"language",
				"default_conversation_transcript_prompt",
			],
		}),
		[],
	);
	const projectQuery = useProjectById({ projectId: projectId ?? "", query });
	const { workspace } = useWorkspace();
	// Observers lack project:update: sections show read-only rather than answer with a 403.
	const canEdit = !!workspace && !isReadOnlyRole(workspace.role);
	// Project memory is listed with chat:use.
	const canSeeMemory = !!workspace && canUseChat(workspace.role);
	// biome-ignore lint/correctness/useExhaustiveDependencies: one project per id, so a refetch after a save does not reset the key terms being typed
	const project = useMemo(() => projectQuery.data, [projectQuery.data?.id]);

	return (
		<PageContainer>
			<Stack gap="xl" {...testId("project-brief")}>
				<Stack gap="xs" px={{ base: "md", md: "lg" }}>
					<Title order={2}>{ready ? t`Brief` : null}</Title>
					{ready && (
						<Text size="sm">
							{t`What this project is about. dembrane reads it for transcripts, summaries, chats and reports.`}
						</Text>
					)}
				</Stack>
				{(projectQuery.isLoading || !ready) && <BeautifulLoading />}
				{projectQuery.isError && (
					<ErrorNotice
						error={projectQuery.error}
						title={t`Error loading project`}
					/>
				)}
				{project && ready && projectId && (
					<>
						<ProjectBasicEdit project={project} readOnly={!canEdit} />
						<Divider />
						<ProjectGoalSection projectId={projectId} readOnly={!canEdit} />
						<Divider />
						<ProjectKeyTermsSection project={project} readOnly={!canEdit} />
						<Divider />
						<ProjectMethodologySection project={project} readOnly={!canEdit} />
						{canSeeMemory && (
							<>
								<Divider />
								<ProjectMemorySection projectId={projectId} />
							</>
						)}
					</>
				)}
			</Stack>
		</PageContainer>
	);
};
