import { Trans } from "@lingui/react/macro";
import { Button, type ButtonVariant } from "@mantine/core";
import { BookOpenIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";

type ProjectHostGuideLinkProps = {
	projectId?: string;
	// Match the buttons beside it: outline in the project home's action row,
	// subtle next to the portal editor's preview toggle.
	variant?: ButtonVariant;
};

export const ProjectHostGuideLink = ({
	projectId: explicitProjectId,
	variant = "subtle",
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
			variant={variant}
			size="sm"
			leftSection={<BookOpenIcon size={16} />}
		>
			<Trans>Host guide</Trans>
		</Button>
	);
};
