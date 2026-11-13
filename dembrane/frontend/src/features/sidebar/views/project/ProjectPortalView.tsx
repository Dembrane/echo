import { Trans } from "@lingui/react/macro";
import {
	ChatCircleDotsIcon,
	FlagCheckeredIcon,
	HandWavingIcon,
	type Icon,
	SealCheckIcon,
	ShieldCheckIcon,
	UserCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import {
	SECTION_KEYS,
	type SectionKey,
} from "@/components/project/portal-editor/sectionKeys";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

const PAGES: Record<SectionKey, { label: ReactNode; icon: Icon }> = {
	about: { icon: UserCircleIcon, label: <Trans>About</Trans> },
	explore: { icon: ChatCircleDotsIcon, label: <Trans>Explore</Trans> },
	finish: { icon: FlagCheckeredIcon, label: <Trans>Finish</Trans> },
	privacy: { icon: ShieldCheckIcon, label: <Trans>Privacy</Trans> },
	verify: {
		icon: SealCheckIcon,
		label: <Trans id="dashboard.dembrane.verify.title">Verify</Trans>,
	},
	welcome: { icon: HandWavingIcon, label: <Trans>Welcome</Trans> },
};

/**
 * The portal editor's own menu (ECHO-1060), pushed from the project like Manage: one page
 * per part of the portal, in the order a participant meets them (SECTION_KEYS).
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
			{SECTION_KEYS.map((section) => (
				<NavItem
					key={section}
					to={`${base}/${section}`}
					label={PAGES[section].label}
					icon={PAGES[section].icon}
				/>
			))}
		</nav>
	);
};
