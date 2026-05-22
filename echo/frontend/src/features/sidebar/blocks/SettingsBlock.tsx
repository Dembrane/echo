import { Trans } from "@lingui/react/macro";
import { Gear } from "@phosphor-icons/react";
import { useSidebarView } from "../hooks/useSidebarView";
import { NavItem } from "../primitives/NavItem";

export const SettingsBlock = () => {
	const { view } = useSidebarView();

	return (
		<NavItem
			to="/settings/account"
			label={<Trans>Settings</Trans>}
			icon={Gear}
			pushes
			active={view === "user-settings"}
		/>
	);
};
