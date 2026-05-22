import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Buildings,
	Palette,
	Scales,
	ShieldStar,
	SignOut,
} from "@phosphor-icons/react";
import { useLocation } from "react-router";
import { useLogoutMutation } from "@/components/auth/hooks";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { BackButton } from "../../primitives/BackButton";
import { NavButton } from "../../primitives/NavButton";
import { NavItem } from "../../primitives/NavItem";

export const UserSettingsView = () => {
	const logoutMutation = useLogoutMutation();
	const location = useLocation();
	const { runTransition } = useTransitionCurtain();

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
				icon={ShieldStar}
			/>
			<NavItem
				to="/settings/access"
				label={<Trans>My access</Trans>}
				icon={Buildings}
			/>
			<NavItem
				to="/settings/appearance"
				label={<Trans>Appearance</Trans>}
				icon={Palette}
			/>
			<NavItem
				to="/settings/project-defaults"
				label={<Trans>Project defaults</Trans>}
				icon={Scales}
			/>
			<NavButton
				label={<Trans>Log out</Trans>}
				icon={SignOut}
				onClick={handleLogout}
				disabled={logoutMutation.isPending}
				destructive
			/>
		</nav>
	);
};
