import { Trans } from "@lingui/react/macro";
import {
	BuildingsIcon,
	PaletteIcon,
	ShieldStarIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

// Logout lives in the sidebar footer UserMenu, not here.
export const UserSettingsView = () => {
	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to="/o" label={<Trans>Settings</Trans>} center />
			<NavItem
				to="/settings/account"
				label={<Trans>Account & security</Trans>}
				icon={ShieldStarIcon}
			/>
			<NavItem
				to="/settings/access"
				label={<Trans>My access</Trans>}
				icon={BuildingsIcon}
			/>
			<NavItem
				to="/settings/appearance"
				label={<Trans>Appearance</Trans>}
				icon={PaletteIcon}
			/>
			<NavItem
				to="/settings/assistant"
				label={<Trans>Assistant</Trans>}
				icon={SparkleIcon}
			/>
		</nav>
	);
};
