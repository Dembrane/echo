import { Trans } from "@lingui/react/macro";
import { Stack } from "@mantine/core";
import { UploadConversationDropzone } from "@/components/dropzone/UploadConversationDropzone";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import { ProjectSettingsSection } from "./ProjectSettingsSection";
import { UploadLockedCard } from "./UploadLockedCard";

type ProjectUploadSectionProps = {
	projectId: string;
};

export const ProjectUploadSection = ({
	projectId,
}: ProjectUploadSectionProps) => {
	const projectQuery = useProjectById({
		projectId,
		query: { fields: ["id", "workspace_id"] },
	});
	const workspaceId =
		(projectQuery.data as { workspace_id?: string | null } | undefined)
			?.workspace_id ?? null;

	const { usageGates } = useWorkspaceUsage(workspaceId);

	return (
		<ProjectSettingsSection
			title={<Trans>Upload</Trans>}
			description={
				!usageGates.uploads_locked ? (
					<Trans>
						Add new recordings to this project. Files you upload here will be
						processed and appear in conversations.
					</Trans>
				) : undefined
			}
		>
			{usageGates.uploads_locked && workspaceId ? (
				<UploadLockedCard
					workspaceId={workspaceId}
					upgradeTier={usageGates.upgrade_cta_tier}
				/>
			) : (
				<Stack maw="300px">
					<UploadConversationDropzone projectId={projectId} />
				</Stack>
			)}
		</ProjectSettingsSection>
	);
};
