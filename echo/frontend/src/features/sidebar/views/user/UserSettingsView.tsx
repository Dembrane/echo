import { Trans } from "@lingui/react/macro";
import {
	BuildingsIcon,
	PaletteIcon,
	ScalesIcon,
	ShieldStarIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

// Logout lives in the sidebar footer UserMenu, not here.
export const UserSettingsView = () => {
	const { data: accessData } = useQuery<{
		organisations: Array<{ id: string }>;
	} | null>({
		queryFn: async () => {
			const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
				credentials: "include",
			});
			if (!res.ok) return null;
			return res.json();
		},
		queryKey: ["v2", "workspaces"],
		staleTime: 60_000,
	});
	const isExternalOnly =
		accessData != null ? accessData.organisations.length === 0 : false;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to="/o" label={<Trans>Settings</Trans>} />
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
			{!isExternalOnly && (
				<NavItem
					to="/settings/project-defaults"
					label={<Trans>Project defaults</Trans>}
					icon={ScalesIcon}
				/>
			)}
		</nav>
	);
};
