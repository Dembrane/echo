import { Trans } from "@lingui/react/macro";
import { CreditCard, Gear, Users, Warning } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const WorkspaceSettingsView = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();

	if (!workspaceId) return null;
	const base = `/w/${workspaceId}/settings`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton
				to={`/w/${workspaceId}/home`}
				label={<Trans>Settings</Trans>}
			/>
			<NavItem
				to={`${base}/general`}
				label={<Trans>General</Trans>}
				icon={Gear}
			/>
			<NavItem
				to={`${base}/members`}
				label={<Trans>Members</Trans>}
				icon={Users}
			/>
			<NavItem
				to={`${base}/billing`}
				label={<Trans>Usage and billing</Trans>}
				icon={CreditCard}
			/>
			<NavItem
				to={`${base}/danger`}
				label={<Trans>Danger zone</Trans>}
				icon={Warning}
			/>
		</nav>
	);
};
