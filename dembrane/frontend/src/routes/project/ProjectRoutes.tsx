import { t } from "@lingui/core/macro";
import { Stack } from "@mantine/core";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { ProjectConversationsPanel } from "@/components/conversation/ProjectConversationsPanel";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { PageContainer } from "@/components/layout/PageContainer";
import { useProjectById } from "@/components/project/hooks";
import { ProjectExportSection } from "@/components/project/ProjectExportSection";
import { ProjectUploadSection } from "@/components/project/ProjectUploadSection";
import {
	ProjectAccess,
	ProjectUsage,
} from "@/components/project/ProjectUsageAndSharing";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { getProjectTranscriptsLink } from "@/lib/api";
import { isReadOnlyRole } from "@/lib/roles";

// Observers lack project:update, so editing and upload controls are hidden or
// read-only rather than shown and answered with a 403.
const useCanEditProject = () => {
	const { workspace } = useWorkspace();
	return !!workspace && !isReadOnlyRole(workspace.role);
};

export const ProjectConversationsRoute = () => {
	const { projectId, workspaceId } = useParams();
	const navigate = useI18nNavigate();
	const canEdit = useCanEditProject();
	// Off by default so the page keeps browsing normally (full row actions,
	// click-through to the conversation). Turning it on swaps in the same
	// checkbox picker used inside a chat, plus "Ask about these" to start a
	// new chat pre-focused on the pick, before any chat exists.
	const [pickerMode, setPickerMode] = useState(false);
	const [selectedConversationIds, setSelectedConversationIds] = useState<
		string[]
	>([]);

	if (!projectId) return null;

	return (
		<PageContainer width="xl">
			<Stack gap="md">
				<ProjectConversationsPanel
					projectId={projectId}
					workspaceId={workspaceId}
					showUpload={canEdit}
					showAudioNotice
					selectionMode={pickerMode}
					selection={selectedConversationIds}
					onSelectionChange={setSelectedConversationIds}
					onToggleSelectionMode={() => {
						if (pickerMode) setSelectedConversationIds([]);
						setPickerMode((current) => !current);
					}}
					onAskAboutSelection={() => {
						navigate(`/w/${workspaceId}/projects/${projectId}/chats/new`, {
							state: { selectedConversationIds },
						});
					}}
				/>
			</Stack>
		</PageContainer>
	);
};

export const ProjectUploadRoute = () => {
	const { projectId } = useParams();

	if (!projectId) return null;

	return (
		<PageContainer>
			<ProjectUploadSection projectId={projectId} />
		</PageContainer>
	);
};

export const ProjectExportRoute = () => {
	const { projectId } = useParams();
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "name"] },
	});

	return (
		<PageContainer>
			<Stack gap="xl">
				{projectQuery.isLoading && <BeautifulLoading />}
				{projectQuery.isError && (
					<ErrorNotice
						error={projectQuery.error}
						title={t`Error loading project`}
					/>
				)}
				{projectQuery.data && projectId && (
					<ProjectExportSection
						exportLink={getProjectTranscriptsLink(projectId)}
						projectName={projectQuery.data.name}
					/>
				)}
			</Stack>
		</PageContainer>
	);
};

export const ProjectAccessRoute = () => {
	const { projectId } = useParams();
	const query = useMemo(
		() => ({
			fields: ["id", "name", "visibility"],
		}),
		[],
	);
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query,
	});

	return (
		<PageContainer>
			<Stack gap="xl">
				{projectQuery.isLoading && <BeautifulLoading />}
				{projectQuery.isError && (
					<ErrorNotice
						error={projectQuery.error}
						title={t`Error loading project`}
					/>
				)}
				{projectQuery.data && projectId && (
					<ProjectAccess
						projectId={projectId}
						visibility={
							(projectQuery.data.visibility as "workspace" | "private") ??
							"workspace"
						}
					/>
				)}
			</Stack>
		</PageContainer>
	);
};

export const ProjectUsageRoute = () => {
	const { projectId } = useParams();

	return (
		<PageContainer>
			<Stack gap="xl">
				{projectId && <ProjectUsage projectId={projectId} />}
			</Stack>
		</PageContainer>
	);
};
