import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { IconPresentation } from "@tabler/icons-react";
import { useParams } from "react-router";

interface HostGuideDownloadProps {
	project: Project;
}

export const HostGuideDownload = ({ project }: HostGuideDownloadProps) => {
	const { workspaceId } = useParams();
	const handleOpenHostGuide = () => {
		if (!project) return;
		// Open host guide in new tab
		const hostGuideUrl = `/w/${workspaceId}/projects/${project.id}/host-guide`;
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
			<Trans>Open host guide</Trans>
		</Button>
	);
};
