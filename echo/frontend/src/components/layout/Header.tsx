import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Menu, Paper, Stack, Text } from "@mantine/core";
import { GearSixIcon } from "@phosphor-icons/react";
import * as Sentry from "@sentry/react";
import {
	IconBug,
	IconLogout,
	IconNotes,
	IconShieldLock,
	IconWorld,
} from "@tabler/icons-react";
import { useEffect } from "react";
import { useParams } from "react-router";
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { DIRECTUS_PUBLIC_URL, ENABLE_ANNOUNCEMENTS } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";
import { testId } from "@/lib/testUtils";
import { AnnouncementIcon } from "../announcement/AnnouncementIcon";
import { Announcements } from "../announcement/Announcements";
import { TopAnnouncementBar } from "../announcement/TopAnnouncementBar";
import { Logo } from "../common/Logo";
import { LanguagePicker } from "../language/LanguagePicker";
import { useTransitionCurtain } from "./TransitionCurtainProvider";

type HeaderViewProps = {
	isAuthenticated: boolean;
	loading: boolean;
};

const User = ({ name, email }: { name: string; email: string }) => (
	<div
		className="px-2"
		style={{
			borderRadius: "var(--mantine-radius-sm)",
			color: "var(--mantine-color-text)",
		}}
		{...testId("header-user-info")}
	>
		<Group gap="sm">
			<div style={{ flex: 1 }} className="hidden md:block">
				<Text size="sm" fw={500} {...testId("header-user-name")}>
					{name}
				</Text>

				<Text c="dimmed" size="xs" {...testId("header-user-email")}>
					{email}
				</Text>
			</div>

			{/* <Avatar src={image} radius="xl" /> */}
		</Group>
	</div>
);

function CreateFeedbackButton() {
	const feedback = Sentry.getFeedback();

	if (!feedback) {
		return null;
	}

	return (
		<Menu.Item
			rightSection={<IconBug />}
			onClick={async () => {
				const form = await feedback?.createForm();
				if (form) {
					form.appendToDom();
					form.open();
				}
			}}
		>
			<Trans>Report an issue</Trans>
		</Menu.Item>
	);
}

const HeaderView = ({ isAuthenticated, loading }: HeaderViewProps) => {
	const { language } = useParams();

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

	// maybe useEffect(params) / useState is better here?
	// but when we change language, we reload the page (check LanguagePicker.tsx)
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
						<Group align="baseline">
							{ENABLE_ANNOUNCEMENTS && (
								<>
									<AnnouncementIcon />
									<Announcements />
								</>
							)}
							<Menu withArrow arrowPosition="center">
								<Menu.Target>
									<ActionIcon
										color="gray"
										variant="transparent"
										{...testId("header-settings-gear-button")}
									>
										<GearSixIcon size={24} color="var(--app-text)" />
									</ActionIcon>
								</Menu.Target>
								<Menu.Dropdown className="py-4">
									<Stack gap="md" className="px-2">
										<User
											// image={typeof user.avatar === "string" ? user.avatar : ""}
											name={t`Hi, ${user.first_name ?? "User"}`}
											email={user.email ?? ""}
										/>

										<Menu.Divider />

										<Menu.Item
											rightSection={<IconShieldLock />}
											onClick={handleSettingsClick}
											{...testId("header-settings-menu-item")}
										>
											<Group>
												<Trans>Settings</Trans>
											</Group>
										</Menu.Item>

										<Menu.Item
											rightSection={<IconNotes />}
											component="a"
											href={docUrl}
											target="_blank"
											{...testId("header-documentation-menu-item")}
										>
											<Group>
												<Trans>Documentation</Trans>
											</Group>
										</Menu.Item>

										<CreateFeedbackButton />

										<Menu.Item
											rightSection={<IconWorld />}
											component="a"
											href="https://tally.so/r/PdprZV"
											target="_blank"
											{...testId("header-help-translate-menu-item")}
										>
											<Trans>Help us translate</Trans>
										</Menu.Item>

										<Menu.Item
											rightSection={<IconLogout />}
											onClick={handleLogout}
											{...testId("header-logout-menu-item")}
										>
											<Trans>Logout</Trans>
										</Menu.Item>

										<Menu.Divider />

										<LanguagePicker />
									</Stack>
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
		</>
	);
};

export const Header = () => {
	const { loading, isAuthenticated } = useAuthenticated();
	return <HeaderView isAuthenticated={isAuthenticated} loading={loading} />;
};

export { HeaderView };
