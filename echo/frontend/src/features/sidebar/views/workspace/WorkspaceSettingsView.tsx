import { Trans } from "@lingui/react/macro";
import { CreditCard, Gear, Users, Warning } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isAdminRole } from "@/lib/roles";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const WorkspaceSettingsView = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const { workspaces } = useWorkspace();

	if (!workspaceId) return null;
	const base = `/w/${workspaceId}/settings`;

	const workspace = workspaces.find((w) => w.id === workspaceId);
	const isAdmin = isAdminRole(workspace?.role);

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton
				to={`/w/${workspaceId}/home`}
				label={<Trans>Settings</Trans>}
			/>
			{isAdmin && (
				<NavItem
					to={`${base}/general`}
					label={<Trans>General</Trans>}
					icon={Gear}
				/>
			)}
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
			{isAdmin && (
				<NavItem
					to={`${base}/danger`}
					label={<Trans>Danger zone</Trans>}
					icon={Warning}
				/>
			)}
		</nav>
	);
};
