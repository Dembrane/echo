import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { testId } from "@/lib/testUtils";
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
			{...testId("project-export-section")}
		>
			<Button
				component="a"
				maw="300px"
				href={exportLink}
				download={`${projectName ?? "Project"}-Transcripts.zip`}
				rightSection={<IconDownload />}
				variant="outline"
				{...testId("project-export-transcripts-button")}
			>
				<Trans>Download All Transcripts</Trans>
			</Button>
		</ProjectSettingsSection>
	);
};
