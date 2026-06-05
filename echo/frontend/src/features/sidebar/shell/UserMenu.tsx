import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import {
	DotsThree,
	Envelope,
	Gear,
	ShieldStar,
	SignOut,
	Sparkle,
} from "@phosphor-icons/react";
import { useLocation } from "react-router";
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import { UserAvatar } from "@/components/common/UserAvatar";
import { LanguagePicker } from "@/components/language/LanguagePicker";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";

// Docs, Slack, and feedback intentionally live in HelpBlock (rendered
// directly above this row in the sidebar footer), so this menu only
// carries user-scoped actions: settings, language, staff, logout.
export const UserMenu = () => {
	const { isAuthenticated } = useAuthenticated();
	const { data: user } = useCurrentUser({ enabled: isAuthenticated });
	const { data: meV2 } = useV2Me({ enabled: isAuthenticated });
	const logoutMutation = useLogoutMutation();
	const location = useLocation();
	const navigate = useI18nNavigate();
	const { runTransition } = useTransitionCurtain();

	if (!isAuthenticated || !user) return null;

	const needsOnboarding = meV2?.onboarding_completed === false;
	const hasPendingInvites = meV2?.has_pending_invites === true;
	const isStaff = meV2?.is_staff === true;

	const handleLogout = async () => {
		if (logoutMutation.isPending) return;
		await runTransition({ description: null, message: t`See you soon` });
		const path = location.pathname + location.search + location.hash;
		await logoutMutation.mutateAsync({
			doRedirect: true,
			next: isAuthPath(location.pathname) ? undefined : path,
		});
	};

	return (
		<Menu
			withArrow
			arrowPosition="center"
			width={240}
			position="right-end"
			offset={8}
			keepMounted
		>
			<Menu.Target>
				<UnstyledButton
					className="flex h-[36px] w-full items-center gap-2 rounded-md px-2 transition-colors hover:bg-black/[0.04]"
					style={{ color: "#2d2d2c" }}
				>
					<UserAvatar size={22} />
					<Box className="min-w-0 flex-1 text-left">
						<Text size="xs" lh={1.1} truncate>
							{user.first_name ?? t`there`}
						</Text>
						<Text size="xs" c="dimmed" lh={1.1} truncate>
							{user.email ?? ""}
						</Text>
					</Box>
					{/* Visible affordance that the row opens a menu (settings +
					    logout). The whole row is the menu target; the dots just
					    signal it. */}
					<DotsThree
						size={18}
						weight="bold"
						className="shrink-0"
						style={{ color: "rgba(45, 45, 44, 0.55)" }}
						aria-hidden="true"
					/>
				</UnstyledButton>
			</Menu.Target>

			<Menu.Dropdown className="py-2 [&_.mantine-Menu-item]:my-0.5">
				{needsOnboarding && (
					<Menu.Item
						leftSection={<Sparkle size={14} />}
						onClick={() => navigate("/onboarding")}
						color="primary"
					>
						<Trans>Set up workspace</Trans>
					</Menu.Item>
				)}
				{hasPendingInvites && (
					<Menu.Item
						leftSection={<Envelope size={14} />}
						onClick={() => navigate("/invites")}
						color="primary"
					>
						<Trans>You have a pending invite</Trans>
					</Menu.Item>
				)}
				<Menu.Item
					leftSection={<Gear size={14} />}
					onClick={() => navigate("/settings")}
				>
					<Trans>Settings</Trans>
				</Menu.Item>
				{isStaff && (
					<Menu.Item
						leftSection={<ShieldStar size={14} />}
						onClick={() => navigate("/admin")}
					>
						<Trans>Staff</Trans>
					</Menu.Item>
				)}

				<Menu.Divider my={6} />

				<Box px="sm" py={4}>
					<Group justify="space-between" align="center">
						<Text size="xs" c="dimmed">
							<Trans>Language</Trans>
						</Text>
						<LanguagePicker />
					</Group>
				</Box>

				<Menu.Divider my={6} />

				<Menu.Item
					leftSection={<SignOut size={14} />}
					onClick={handleLogout}
					color="red"
				>
					<Trans>Logout</Trans>
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
};
