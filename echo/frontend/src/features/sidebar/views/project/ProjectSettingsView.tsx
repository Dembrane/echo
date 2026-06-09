import { Trans } from "@lingui/react/macro";
import { Gear, Plugs, UsersThree } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const ProjectSettingsView = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();

	if (!workspaceId || !projectId) return null;
	const base = `/w/${workspaceId}/projects/${projectId}`;

	return (
		<nav className="flex flex-col gap-0.5 p-1.5">
			<BackButton to={`${base}/home`} label={<Trans>Settings</Trans>} center />
			<NavItem
				to={`${base}/overview`}
				label={<Trans>General</Trans>}
				icon={Gear}
			/>
			<NavItem
				to={`${base}/access`}
				label={<Trans>Access & sharing</Trans>}
				icon={UsersThree}
			/>
			<NavItem
				to={`${base}/integrations`}
				label={<Trans>Integrations & Export</Trans>}
				icon={Plugs}
			/>
		</nav>
	);
};
