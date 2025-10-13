import { Trans } from "@lingui/react/macro";
import { Stack } from "@mantine/core";
import { UploadConversationDropzone } from "@/components/dropzone/UploadConversationDropzone";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

type ProjectUploadSectionProps = {
	projectId: string;
};

export const ProjectUploadSection = ({
	projectId,
}: ProjectUploadSectionProps) => {
	return (
		<ProjectSettingsSection
			title={<Trans>Upload</Trans>}
			description={
				<Trans>
					Add new recordings to this project. Files you upload here will be
					processed and appear in conversations.
				</Trans>
			}
		>
			<Stack maw="300px">
				<UploadConversationDropzone projectId={projectId} />
			</Stack>
		</ProjectSettingsSection>
	);
};
