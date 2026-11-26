import { Trans } from "@lingui/react/macro";
import {
	CreditCard,
	Gear,
	GraduationCapIcon,
	Warning,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { ENABLE_TRAINING } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isAdminRole } from "@/lib/roles";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const WorkspaceSettingsView = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const { workspaces } = useWorkspace();
	// The settings page's own query, read from the cache: a support visit carries the admin
	// role but may not delete, so its my_policies has no settings:manage.
	const { data: settings } = useQuery<{ my_policies?: string[] }>({
		enabled: false,
		queryKey: ["v2", "workspace-settings", workspaceId],
	});

	if (!workspaceId) return null;
	const base = `/w/${workspaceId}/settings`;

	const workspace = workspaces.find((w) => w.id === workspaceId);
	const isAdmin = isAdminRole(workspace?.role);
	const mayDelete =
		isAdmin && (settings?.my_policies?.includes("settings:manage") ?? true);

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton
				to={`/w/${workspaceId}/home`}
				label={<Trans>Settings</Trans>}
				center
			/>
			{isAdmin && (
				<NavItem
					to={`${base}/general`}
					label={<Trans>General</Trans>}
					icon={Gear}
				/>
			)}
			<NavItem
				to={`${base}/billing`}
				label={<Trans>Usage and billing</Trans>}
				icon={CreditCard}
			/>
			{isAdmin && ENABLE_TRAINING && (
				<NavItem
					to={`${base}/training`}
					label={<Trans>Training</Trans>}
					icon={GraduationCapIcon}
				/>
			)}
			{mayDelete && (
				<NavItem
					to={`${base}/danger`}
					label={<Trans>Danger zone</Trans>}
					icon={Warning}
				/>
			)}
		</nav>
	);
};
