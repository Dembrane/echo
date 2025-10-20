import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

type ProjectExportSectionProps = {
	exportLink: string;
	projectName?: string | null;
};

export const ProjectExportSection = ({
	exportLink,
	projectName,
}: ProjectExportSectionProps) => {
	return (
		<ProjectSettingsSection
			title={<Trans>Export</Trans>}
			description={
				<Trans>
					Download all conversation transcripts generated for this project.
				</Trans>
			}
		>
			<Button
				component="a"
				maw="300px"
				href={exportLink}
				download={`${projectName ?? "Project"}-Transcripts.zip`}
				rightSection={<IconDownload />}
				variant="outline"
			>
				<Trans>Download All Transcripts</Trans>
			</Button>
		</ProjectSettingsSection>
	);
};
