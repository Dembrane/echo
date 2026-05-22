import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import {
	ArrowUpRight,
	Bug,
	ChatCircle,
	Envelope,
	Gear,
	Note,
	ShieldStar,
	SignOut,
	Sparkle,
	Users,
} from "@phosphor-icons/react";
import * as Sentry from "@sentry/react";
import { useState } from "react";
import { useLocation, useParams } from "react-router";
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import { FeedbackPortalModal } from "@/components/common/FeedbackPortalModal";
import { UserAvatar } from "@/components/common/UserAvatar";
import { LanguagePicker } from "@/components/language/LanguagePicker";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { COMMUNITY_SLACK_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";

const ReportIssueItem = ({ onFallback }: { onFallback: () => void }) => {
	const handleClick = async () => {
		const feedback = Sentry.getFeedback();
		if (feedback) {
			const form = await feedback.createForm();
			if (form) {
				form.appendToDom();
				form.open();
				return;
			}
		}
		onFallback();
	};
	return (
		<Menu.Item leftSection={<Bug size={14} />} onClick={handleClick}>
			<Trans>Report an issue</Trans>
		</Menu.Item>
	);
};

export const UserMenu = () => {
	const { isAuthenticated } = useAuthenticated();
	const { data: user } = useCurrentUser({ enabled: isAuthenticated });
	const { data: meV2 } = useV2Me({ enabled: isAuthenticated });
	const logoutMutation = useLogoutMutation();
	const { language } = useParams();
	const location = useLocation();
	const navigate = useI18nNavigate();
	const { runTransition } = useTransitionCurtain();
	const [feedbackOpen, setFeedbackOpen] = useState(false);

	if (!isAuthenticated || !user) return null;

	const needsOnboarding = meV2?.onboarding_completed === false;
	const hasPendingInvites = meV2?.has_pending_invites === true;
	const isStaff = meV2?.is_staff === true;

	const docUrl =
		language === "nl-NL"
			? "https://docs.dembrane.com/nl-NL"
			: "https://docs.dembrane.com/en-US";

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
		<>
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
					</UnstyledButton>
				</Menu.Target>

				<Menu.Dropdown className="py-2 [&_.mantine-Menu-item]:my-0.5">
					{needsOnboarding && (
						<Menu.Item
							leftSection={<Sparkle size={14} />}
							onClick={() => navigate("/onboarding")}
							color="blue"
						>
							<Trans>Set up workspace</Trans>
						</Menu.Item>
					)}
					{hasPendingInvites && (
						<Menu.Item
							leftSection={<Envelope size={14} />}
							onClick={() => navigate("/invites")}
							color="blue"
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
					<Menu.Item
						className="group"
						leftSection={<Note size={14} />}
						rightSection={
							<ArrowUpRight
								size={11}
								className="opacity-0 transition-opacity group-hover:opacity-55"
							/>
						}
						component="a"
						href={docUrl}
						target="_blank"
					>
						<Trans>Documentation</Trans>
					</Menu.Item>

					<Menu.Divider my={6} />

					<Menu.Item
						leftSection={<ChatCircle size={14} />}
						onClick={() => setFeedbackOpen(true)}
					>
						<Trans>Feedback portal</Trans>
					</Menu.Item>
					<ReportIssueItem onFallback={() => setFeedbackOpen(true)} />
					<Menu.Item
						className="group"
						leftSection={<Users size={14} />}
						rightSection={
							<ArrowUpRight
								size={11}
								className="opacity-0 transition-opacity group-hover:opacity-55"
							/>
						}
						component="a"
						href={COMMUNITY_SLACK_URL}
						target="_blank"
					>
						<Trans>Slack community</Trans>
					</Menu.Item>

					<Menu.Divider my={6} />

					{isStaff && (
						<Menu.Item
							leftSection={<ShieldStar size={14} />}
							onClick={() => navigate("/admin")}
						>
							<Trans>Staff</Trans>
						</Menu.Item>
					)}

					<Box px="sm" py={4}>
						<Group justify="space-between" align="center">
							<Text size="xs" c="dimmed">
								<Trans>Language</Trans>
							</Text>
							<LanguagePicker />
						</Group>
					</Box>

					<Menu.Item
						leftSection={<SignOut size={14} />}
						onClick={handleLogout}
						color="red"
					>
						<Trans>Logout</Trans>
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			<FeedbackPortalModal
				opened={feedbackOpen}
				onClose={() => setFeedbackOpen(false)}
				locale={language}
			/>
		</>
	);
};
