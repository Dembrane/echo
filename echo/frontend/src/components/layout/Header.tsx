import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Menu,
	Modal,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import * as Sentry from "@sentry/react";
import {
	IconBug,
	IconExternalLink,
	IconLogout,
	IconMessageCircle,
	IconNotes,
	IconSettings,
	IconUsers,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import {
	COMMUNITY_SLACK_URL,
	DIRECTUS_PUBLIC_URL,
	ENABLE_ANNOUNCEMENTS,
	PRODUCT_FEEDBACK_URL,
} from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { testId } from "@/lib/testUtils";
import { AnnouncementIcon } from "../announcement/AnnouncementIcon";
import { Announcements } from "../announcement/Announcements";
import { TopAnnouncementBar } from "../announcement/TopAnnouncementBar";
import { Logo } from "../common/Logo";
import { UserAvatar } from "../common/UserAvatar";
import { LanguagePicker } from "../language/LanguagePicker";
import { useTransitionCurtain } from "./TransitionCurtainProvider";

type HeaderViewProps = {
	isAuthenticated: boolean;
	loading: boolean;
};

function CreateFeedbackButton({
	onFallback,
}: {
	onFallback: () => void;
}) {
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
		<Menu.Item
			leftSection={<IconBug size={14} />}
			onClick={handleClick}
		>
			<Trans>Report an issue</Trans>
		</Menu.Item>
	);
}

const HeaderView = ({ isAuthenticated, loading }: HeaderViewProps) => {
	const { language } = useParams();
	const [feedbackFallbackOpen, setFeedbackFallbackOpen] = useState(false);
	const [feedbackPortalOpen, setFeedbackPortalOpen] = useState(false);

	const logoutMutation = useLogoutMutation();
	const { data: user } = useCurrentUser({ enabled: isAuthenticated });
	const navigate = useI18nNavigate();
	const { runTransition } = useTransitionCurtain();
	const { setLogoUrl } = useWhitelabelLogo();

	useEffect(() => {
		if (user?.whitelabel_logo) {
			setLogoUrl(`${DIRECTUS_PUBLIC_URL}/assets/${user.whitelabel_logo}`);
		} else {
			setLogoUrl(null);
		}
	}, [user?.whitelabel_logo, setLogoUrl]);

	let docUrl: string;
	switch (language) {
		case "nl-NL":
			docUrl = "https://docs.dembrane.com/nl-NL";
			break;
		default:
			docUrl = "https://docs.dembrane.com/en-US";
			break;
	}

	const handleLogout = async () => {
		if (logoutMutation.isPending) return;

		await runTransition({
			description: null,
			message: t`See you soon`,
		});

		await logoutMutation.mutateAsync({
			doRedirect: true,
		});
	};

	const handleSettingsClick = () => {
		navigate("/settings");
	};

	return (
		<>
			{isAuthenticated && user && ENABLE_ANNOUNCEMENTS && (
				<TopAnnouncementBar />
			)}
			<Paper
				component="header"
				radius="0"
				className="z-30 w-full"
				shadow="xs"
				withBorder={false}
				style={{
					backgroundColor: "var(--app-background)",
					borderLeft: "1px solid var(--mantine-color-default-border)",
					borderRight: "1px solid var(--mantine-color-default-border)",
				}}
			>
				<Group
					justify="space-between"
					align="center"
					className="w-full"
					h={60}
					px="md"
				>
					<Group gap="md">
						<I18nLink to="/projects">
							<Group align="center">
								<Logo hideTitle={false} />
							</Group>
						</I18nLink>
					</Group>

					{!loading && isAuthenticated && user ? (
						<Group align="center">
							{ENABLE_ANNOUNCEMENTS && (
								<>
									<AnnouncementIcon />
									<Announcements />
								</>
							)}
							<Menu
								withArrow
								arrowPosition="center"
								width={240}
							>
								<Menu.Target>
									<ActionIcon
										color="gray"
										variant="transparent"
										radius="xl"
										size="lg"
										{...testId(
											"header-settings-gear-button",
										)}
									>
										<UserAvatar size={32} />
									</ActionIcon>
								</Menu.Target>
								<Menu.Dropdown className="py-2 [&_.mantine-Menu-item]:my-0.5">
									{/* Identity */}
									<Box px="sm" py="xs">
										<Group gap="sm" wrap="nowrap">
											<UserAvatar size={32} />
											<Box className="min-w-0 flex-1">
												<Text
													size="sm"
													fw={500}
													truncate
													{...testId(
														"header-user-name",
													)}
												>
													{user.first_name ?? "User"}
												</Text>
												<Text
													size="xs"
													c="dimmed"
													truncate
													{...testId(
														"header-user-email",
													)}
												>
													{user.email ?? ""}
												</Text>
											</Box>
										</Group>
									</Box>

									<Menu.Divider my={6} />

									{/* Primary */}
									<Menu.Item
										leftSection={
											<IconSettings size={14} />
										}
										onClick={handleSettingsClick}
										{...testId(
											"header-settings-menu-item",
										)}
									>
										<Trans>Settings</Trans>
									</Menu.Item>

									<Menu.Item
										leftSection={
											<IconNotes size={14} />
										}
										component="a"
										href={docUrl}
										target="_blank"
										rightSection={
											<IconExternalLink
												size={10}
												className="opacity-30"
											/>
										}
										{...testId(
											"header-documentation-menu-item",
										)}
									>
										<Trans>Documentation</Trans>
									</Menu.Item>

									<Menu.Divider my={6} />

									{/* Community */}
									<Menu.Item
										leftSection={
											<IconMessageCircle size={14} />
										}
										onClick={() =>
											setFeedbackPortalOpen(true)
										}
									>
										<Trans>Feedback portal</Trans>
									</Menu.Item>

									<CreateFeedbackButton onFallback={() => setFeedbackFallbackOpen(true)} />

									<Menu.Item
										leftSection={
											<IconUsers size={14} />
										}
										component="a"
										href={COMMUNITY_SLACK_URL}
										target="_blank"
										onClick={() => {
											try {
												analytics.trackEvent(
													events.JOIN_SLACK_COMMUNITY,
												);
											} catch (error) {
												console.warn(
													"Analytics tracking failed:",
													error,
												);
											}
										}}
										rightSection={
											<Badge
												size="xs"
												variant="light"
												color="blue"
											>
												10+
											</Badge>
										}
										{...testId(
											"header-join-community-menu-item",
										)}
									>
										<Trans>Slack community</Trans>
									</Menu.Item>

									<Menu.Divider my={6} />

									{/* Utility */}
									<Box px="sm" py={4}>
										<LanguagePicker />
									</Box>

									<Menu.Item
										leftSection={
											<IconLogout size={14} />
										}
										onClick={handleLogout}
										color="red"
										{...testId(
											"header-logout-menu-item",
										)}
									>
										<Trans>Logout</Trans>
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						</Group>
					) : (
						<Group>
							<LanguagePicker />
						</Group>
					)}
				</Group>
			</Paper>

			<Modal
				opened={feedbackFallbackOpen}
				onClose={() => setFeedbackFallbackOpen(false)}
				title={t`Report an issue`}
				centered
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							The built-in issue reporter could not be loaded.
							You can still let us know what went wrong through
							our feedback portal. It helps us fix things
							faster than not submitting a report.
						</Trans>
					</Text>
					<Group justify="flex-end">
						<Button
							variant="default"
							onClick={() => setFeedbackFallbackOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							component="a"
							href={PRODUCT_FEEDBACK_URL}
							target="_blank"
							onClick={() => setFeedbackFallbackOpen(false)}
						>
							<Trans>Go to feedback portal</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={feedbackPortalOpen}
				onClose={() => setFeedbackPortalOpen(false)}
				title={t`Feedback portal`}
				centered
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							We'd love to hear from you. Whether you have an
							idea for something new, you've hit a bug, spotted
							a translation that feels off, or just want to
							share how things have been going.
						</Trans>
					</Text>
					<Text size="sm">
						<Trans>
							To help us act on it, try to include where it
							happened and what you were trying to do. For bugs,
							tell us what went wrong. For ideas, tell us what
							need it would solve for you.
						</Trans>
					</Text>
					<Text size="sm">
						<Trans>
							Just talk or type naturally. Your input goes
							directly to our product team and genuinely helps us
							make dembrane better. We read everything.
						</Trans>
					</Text>
					<Text size="sm" c="dimmed">
						<Trans>
							Prefer to chat directly?{" "}
							<Anchor
								href="https://cal.com/sameer-dembrane"
								target="_blank"
								size="sm"
							>
								Book a call with me
							</Anchor>
						</Trans>
					</Text>
					<Group justify="flex-end">
						<Button
							variant="default"
							onClick={() => setFeedbackPortalOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							component="a"
							href={PRODUCT_FEEDBACK_URL}
							target="_blank"
							onClick={() => setFeedbackPortalOpen(false)}
						>
							<Trans>Open feedback portal</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
};

export const Header = () => {
	const { loading, isAuthenticated } = useAuthenticated();
	return <HeaderView isAuthenticated={isAuthenticated} loading={loading} />;
};

export { HeaderView };
