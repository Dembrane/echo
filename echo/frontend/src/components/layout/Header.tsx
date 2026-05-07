import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Menu,
	Paper,
	ScrollArea,
	Text,
	UnstyledButton,
} from "@mantine/core";
import * as Sentry from "@sentry/react";
import {
	IconBug,
	IconShieldLock,
	IconCheck,
	IconChevronDown,
	IconExternalLink,
	IconLogout,
	IconMessageCircle,
	IconNotes,
	IconSettings,
	IconMail,
	IconSparkles,
	IconUsers,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router";
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { isAuthPath } from "@/components/auth/utils/authPaths";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { I18nLink } from "@/components/common/i18nLink";
import {
	COMMUNITY_SLACK_URL,
	DIRECTUS_PUBLIC_URL,
	ENABLE_ANNOUNCEMENTS,
} from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";
import { analytics } from "@/lib/analytics";
import { logoUrl } from "@/lib/avatar";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { testId } from "@/lib/testUtils";
import { TopAnnouncementBar } from "../announcement/TopAnnouncementBar";
import { Inbox } from "../inbox/Inbox";
import { FeedbackPortalModal } from "../common/FeedbackPortalModal";
import { Logo } from "../common/Logo";
import { UserAvatar } from "../common/UserAvatar";
import { LanguagePicker } from "../language/LanguagePicker";
import { useTransitionCurtain } from "./TransitionCurtainProvider";

type HeaderViewProps = {
	isAuthenticated: boolean;
	loading: boolean;
};

function CreateFeedbackButton({ onFallback }: { onFallback: () => void }) {
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
		<Menu.Item leftSection={<IconBug size={14} />} onClick={handleClick}>
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
	const { data: meV2 } = useV2Me({ enabled: isAuthenticated });
	const needsOnboarding = meV2?.onboarding_completed === false;
	const hasPendingInvites = meV2?.has_pending_invites === true;
	const isStaff = meV2?.is_staff === true;
	const {
		workspaceId,
		workspaceName,
		workspace,
		workspaces,
		isLoading: workspaceLoading,
		setWorkspace,
	} = useWorkspace();
	const location = useLocation();
	// Hide workspace breadcrumb on selector, create-wizard, org, and admin pages.
	const pathNoLocale = location.pathname.replace(
		/^\/[a-z]{2}(-[A-Z]{2})?(?=\/)/,
		"",
	);
	const hideWorkspaceBreadcrumb =
		pathNoLocale === "/w" ||
		pathNoLocale === "/w/" ||
		pathNoLocale.startsWith("/w/new") ||
		pathNoLocale.startsWith("/o/") ||
		pathNoLocale.startsWith("/admin");
	const navigate = useI18nNavigate();
	const { runTransition } = useTransitionCurtain();
	const { setLogoUrl } = useWhitelabelLogo();

	useEffect(() => {
		const insideWorkspace = !hideWorkspaceBreadcrumb;

		// Wait for workspace data before resolving — avoids logo flash on refresh.
		if (insideWorkspace && workspaceLoading) return;

		const workspaceLogo = insideWorkspace
			? (logoUrl(workspace?.logo_url) ?? logoUrl(workspace?.org_logo_url))
			: undefined;
		const resolved =
			workspaceLogo ??
			(user?.whitelabel_logo
				? `${DIRECTUS_PUBLIC_URL}/assets/${user.whitelabel_logo}`
				: null);
		setLogoUrl(resolved ?? null);
	}, [
		hideWorkspaceBreadcrumb,
		workspaceLoading,
		workspace?.logo_url,
		workspace?.org_logo_url,
		user?.whitelabel_logo,
		setLogoUrl,
	]);

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

		// Preserve location so re-login lands back here, not on the lastStillValid auto-resume.
		const path = location.pathname + location.search + location.hash;

		await logoutMutation.mutateAsync({
			doRedirect: true,
			next: isAuthPath(location.pathname) ? undefined : path,
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
						{/* Logo click: inside a workspace → that workspace's project
						    list. Outside any workspace context → the workspace
						    selector (/w). Previously fell back to /projects, which
						    was the legacy dembrane home and confusing once organisations
						    existed. */}
						<I18nLink to="/w">
							<Group align="center">
								<Logo hideTitle={false} />
							</Group>
						</I18nLink>
						{workspaceName && isAuthenticated && !hideWorkspaceBreadcrumb && (
							<Menu
								withArrow
								arrowPosition="center"
								width={260}
								keepMounted
								position="bottom-start"
							>
								<Menu.Target>
									<UnstyledButton
										aria-label={t`Switch workspace`}
										style={{
											display: "inline-flex",
											alignItems: "center",
											gap: 6,
											padding: "4px 6px",
											borderRadius: 6,
										}}
									>
										<Text size="xs" c="dimmed" lh={1}>
											/
										</Text>
										<Text
											size="sm"
											c="dimmed"
											lineClamp={1}
											maw={180}
											lh={1}
										>
											{workspaceName}
										</Text>
										<IconChevronDown size={12} color="var(--mantine-color-gray-6)" />
									</UnstyledButton>
								</Menu.Target>
								<Menu.Dropdown>
									<Menu.Label>
										<Trans>Switch workspace</Trans>
									</Menu.Label>
									<ScrollArea.Autosize mah={320}>
										{/* Sort by organisation, then workspace name (2026-04-24).
										    Before: API order, which made the list feel
										    random. Now: predictable alphabetical grouping
										    so users can find "the X workspace on organisation Y". */}
										{[...workspaces]
											.sort((a, b) => {
												const t = (a.org_name || "").localeCompare(
													b.org_name || "",
												);
												if (t !== 0) return t;
												return (a.name || "").localeCompare(b.name || "");
											})
											.map((ws) => {
												const isCurrent = ws.id === workspaceId;
												return (
													<Menu.Item
														key={ws.id}
														rightSection={
															isCurrent ? (
																<IconCheck size={14} color="var(--mantine-color-blue-6)" />
															) : null
														}
														onClick={() => {
															if (isCurrent) return;
															setWorkspace(ws.id);
															navigate(`/w/${ws.id}/projects`);
														}}
													>
														<Box>
															<Text size="sm" lineClamp={1}>
																{ws.name}
															</Text>
															{ws.org_name && (
																<Text size="xs" c="dimmed" lineClamp={1}>
																	{ws.org_name}
																</Text>
															)}
														</Box>
													</Menu.Item>
												);
											})}
									</ScrollArea.Autosize>
									<Menu.Divider />
									<Menu.Item onClick={() => navigate("/w")}>
										<Trans>All workspaces</Trans>
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						)}
					</Group>

					{!loading && isAuthenticated && user ? (
						<Group align="center" gap="xs">
							{/* Staff shortcut — only visible when meV2.is_staff is
							    true. Purple so it reads as "out-of-model" vs. the
							    blue primary. Routes to /admin (billing rollup,
							    at-risk, partners, upgrades). */}
							{isStaff && (
								<Button
									component={I18nLink}
									to="/admin"
									size="xs"
									variant="light"
									color="violet"
									leftSection={<IconShieldLock size={12} />}
								>
									<Trans>Staff</Trans>
								</Button>
							)}
							{/* Unified Inbox — one bell, two tabs (For you +
							    Announcements). Replaces the prior split icons.
							    ENABLE_ANNOUNCEMENTS still controls whether the
							    broadcast channel is live, but the bell itself
							    stays so personal notifications remain reachable. */}
							<Inbox />
							<Menu withArrow arrowPosition="center" width={240} keepMounted>
								<Menu.Target>
									<ActionIcon
										color="gray"
										variant="transparent"
										radius="xl"
										size="lg"
										{...testId("header-settings-gear-button")}
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
													{...testId("header-user-name")}
												>
													{user.first_name ?? t`there`}
												</Text>
												<Text
													size="xs"
													c="dimmed"
													truncate
													{...testId("header-user-email")}
												>
													{user.email ?? ""}
												</Text>
											</Box>
										</Group>
									</Box>

									<Menu.Divider my={6} />

									{/* Primary */}
									{needsOnboarding && (
										<Menu.Item
											leftSection={<IconSparkles size={14} />}
											onClick={() => navigate("/onboarding")}
											color="blue"
										>
											<Trans>Set up workspace</Trans>
										</Menu.Item>
									)}
									{hasPendingInvites && (
										<Menu.Item
											leftSection={<IconMail size={14} />}
											onClick={() => navigate("/invites")}
											color="blue"
										>
											<Trans>You have a pending invite</Trans>
										</Menu.Item>
									)}
									<Menu.Item
										leftSection={<IconSettings size={14} />}
										onClick={handleSettingsClick}
										{...testId("header-settings-menu-item")}
									>
										<Trans>Settings</Trans>
									</Menu.Item>

									<Menu.Item
										leftSection={<IconNotes size={14} />}
										component="a"
										href={docUrl}
										target="_blank"
										rightSection={
											<IconExternalLink size={10} className="opacity-30" />
										}
										{...testId("header-documentation-menu-item")}
									>
										<Trans>Documentation</Trans>
									</Menu.Item>

									<Menu.Divider my={6} />

									{/* Community */}
									<Menu.Item
										leftSection={<IconMessageCircle size={14} />}
										onClick={() => setFeedbackPortalOpen(true)}
									>
										<Trans>Feedback portal</Trans>
									</Menu.Item>

									<CreateFeedbackButton
										onFallback={() => setFeedbackFallbackOpen(true)}
									/>

									<Menu.Item
										leftSection={<IconUsers size={14} />}
										component="a"
										href={COMMUNITY_SLACK_URL}
										target="_blank"
										onClick={() => {
											try {
												analytics.trackEvent(events.JOIN_SLACK_COMMUNITY);
											} catch (error) {
												console.warn("Analytics tracking failed:", error);
											}
										}}
										rightSection={
											<Badge size="xs" variant="light" color="blue">
												10+
											</Badge>
										}
										{...testId("header-join-community-menu-item")}
									>
										<Trans>Slack community</Trans>
									</Menu.Item>

									<Menu.Divider my={6} />

									{/* Utility */}
									<Box px="sm" py={4}>
										<LanguagePicker />
									</Box>

									<Menu.Item
										leftSection={<IconLogout size={14} />}
										onClick={handleLogout}
										color="red"
										{...testId("header-logout-menu-item")}
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

			<FeedbackPortalModal
				opened={feedbackFallbackOpen || feedbackPortalOpen}
				onClose={() => {
					setFeedbackFallbackOpen(false);
					setFeedbackPortalOpen(false);
				}}
				locale={language}
			/>
		</>
	);
};

export const Header = () => {
	const { loading, isAuthenticated } = useAuthenticated();
	return <HeaderView isAuthenticated={isAuthenticated} loading={loading} />;
};

export { HeaderView };
