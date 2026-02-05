import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { IconPresentation } from "@tabler/icons-react";

interface HostGuideDownloadProps {
	project: Project;
}

export const HostGuideDownload = ({ project }: HostGuideDownloadProps) => {
	const handleOpenHostGuide = () => {
		if (!project) return;
		// Open host guide in new tab
		const hostGuideUrl = `/projects/${project.id}/host-guide`;
		window.open(hostGuideUrl, "_blank");
	};

	if (!project?.is_conversation_allowed) {
		return null;
	}

	return (
		<Button
			onClick={handleOpenHostGuide}
			rightSection={<IconPresentation />}
			variant="outline"
			maw="300px"
		>
			<Trans>Open Host Guide</Trans>
		</Button>
	);
};
