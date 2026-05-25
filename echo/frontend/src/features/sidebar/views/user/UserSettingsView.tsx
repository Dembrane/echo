import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	BuildingsIcon,
	PaletteIcon,
	ScalesIcon,
	ShieldStarIcon,
	SignOutIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { useLogoutMutation } from "@/components/auth/hooks";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { API_BASE_URL } from "@/config";
import { BackButton } from "../../primitives/BackButton";
import { NavButton } from "../../primitives/NavButton";
import { NavItem } from "../../primitives/NavItem";

export const UserSettingsView = () => {
	const logoutMutation = useLogoutMutation();
	const location = useLocation();
	const { runTransition } = useTransitionCurtain();

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
	const isExternalOnly = (accessData?.organisations.length ?? 0) === 0;

	const handleLogout = async () => {
		if (logoutMutation.isPending) return;
		await runTransition({ description: null, message: t`See you soon` });
		const path = location.pathname + location.search + location.hash;
		await logoutMutation.mutateAsync({
			doRedirect: true,
			next: path.startsWith("/login") ? undefined : path,
		});
	};

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to="/w" label={<Trans>Settings</Trans>} />
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
			<NavButton
				label={<Trans>Log out</Trans>}
				icon={SignOutIcon}
				onClick={handleLogout}
				disabled={logoutMutation.isPending}
				destructive
			/>
		</nav>
	);
};
