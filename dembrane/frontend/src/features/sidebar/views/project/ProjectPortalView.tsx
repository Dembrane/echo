import { Trans } from "@lingui/react/macro";
import {
	ChatCircleDotsIcon,
	FlagCheckeredIcon,
	HandWavingIcon,
	SealCheckIcon,
	ShieldCheckIcon,
	UserCircleIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

/**
 * The portal editor's own menu (ECHO-1060), pushed from the project like Manage: one page
 * per part of the portal, in the order a participant meets them.
 */
export const ProjectPortalView = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();

	if (!workspaceId || !projectId) return null;
	const base = `/w/${workspaceId}/projects/${projectId}/portal`;

	return (
		<nav
			className="flex flex-col gap-0.5 p-1.5"
			data-testid="sidebar-portal-editor"
		>
			<BackButton
				to={`/w/${workspaceId}/projects/${projectId}/home`}
				label={<Trans>Portal editor</Trans>}
				center
			/>
			<NavItem
				to={`${base}/welcome`}
				label={<Trans>Welcome</Trans>}
				icon={HandWavingIcon}
			/>
			<NavItem
				to={`${base}/privacy`}
				label={<Trans>Privacy</Trans>}
				icon={ShieldCheckIcon}
			/>
			<NavItem
				to={`${base}/about`}
				label={<Trans>About</Trans>}
				icon={UserCircleIcon}
			/>
			<NavItem
				to={`${base}/explore`}
				label={<Trans>Explore</Trans>}
				icon={ChatCircleDotsIcon}
			/>
			<NavItem
				to={`${base}/verify`}
				label={<Trans id="dashboard.dembrane.verify.title">Verify</Trans>}
				icon={SealCheckIcon}
			/>
			<NavItem
				to={`${base}/finish`}
				label={<Trans>Finish</Trans>}
				icon={FlagCheckeredIcon}
			/>
		</nav>
	);
};
