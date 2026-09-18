import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { BookOpenIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";

type ProjectHostGuideLinkProps = {
	projectId?: string;
};

export const ProjectHostGuideLink = ({
	projectId: explicitProjectId,
}: ProjectHostGuideLinkProps) => {
	const { workspaceId, projectId: routeProjectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	const projectId = explicitProjectId ?? routeProjectId;

	if (!workspaceId || !projectId) return null;

	return (
		<Button
			component={I18nLink}
			to={`/w/${workspaceId}/projects/${projectId}/host-guide`}
			variant="subtle"
			size="sm"
			leftSection={<BookOpenIcon size={16} />}
		>
			<Trans>Host guide</Trans>
		</Button>
	);
};
