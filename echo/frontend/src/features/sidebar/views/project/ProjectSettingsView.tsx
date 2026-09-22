import { Trans } from "@lingui/react/macro";
import {
	ChartLineIcon,
	DownloadSimpleIcon,
	GearIcon,
	UsersThreeIcon,
} from "@phosphor-icons/react";
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
			<BackButton to={`${base}/home`} label={<Trans>Manage</Trans>} center />
			<NavItem
				to={`${base}/overview`}
				label={<Trans>General</Trans>}
				icon={GearIcon}
			/>
			<NavItem
				to={`${base}/access`}
				label={<Trans>Access</Trans>}
				icon={UsersThreeIcon}
			/>
			<NavItem
				to={`${base}/usage`}
				label={<Trans>Usage</Trans>}
				icon={ChartLineIcon}
			/>
			<NavItem
				to={`${base}/export`}
				label={<Trans>Export</Trans>}
				icon={DownloadSimpleIcon}
			/>
		</nav>
	);
};
