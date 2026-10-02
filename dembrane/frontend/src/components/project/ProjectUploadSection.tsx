import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { UploadConversationDropzone } from "@/components/dropzone/UploadConversationDropzone";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import { isReadOnlyRole } from "@/lib/roles";
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

	const { workspace } = useWorkspace();
	// Observers are read-only: no dropzone, and no usage fetch (it 403s for them).
	const canUpload = !!workspace && !isReadOnlyRole(workspace.role);

	const { usageGates } = useWorkspaceUsage(workspaceId, { enabled: canUpload });

	if (!canUpload) {
		return (
			<ProjectSettingsSection title={<Trans>Upload</Trans>}>
				<Text size="sm" c="dimmed">
					<Trans>
						You have view-only access to this project, so you can't upload
						recordings.
					</Trans>
				</Text>
			</ProjectSettingsSection>
		);
	}

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
