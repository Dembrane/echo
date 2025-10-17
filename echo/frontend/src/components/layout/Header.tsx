import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Menu, Paper, Stack, Text } from "@mantine/core";
import * as Sentry from "@sentry/react";
import {
	IconBug,
	IconLogout,
	IconNotes,
	IconSettings,
} from "@tabler/icons-react";
import { useParams } from "react-router";
import {
	useAuthenticated,
	useCurrentUser,
	useLogoutMutation,
} from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { ENABLE_ANNOUNCEMENTS } from "@/config";
import { AnnouncementIcon } from "../announcement/AnnouncementIcon";
import { Announcements } from "../announcement/Announcements";
import { TopAnnouncementBar } from "../announcement/TopAnnouncementBar";
import { Logo } from "../common/Logo";
import { LanguagePicker } from "../language/LanguagePicker";

const User = ({ name, email }: { name: string; email: string }) => (
	<div
		className="px-2"
		style={{
			borderRadius: "var(--mantine-radius-sm)",
			color: "var(--mantine-color-text)",
		}}
	>
		<Group gap="sm">
			<div style={{ flex: 1 }} className="hidden md:block">
				<Text size="sm" fw={500}>
					{name}
				</Text>

				<Text c="dimmed" size="xs">
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

export const Header = () => {
	const { language } = useParams();

	const logoutMutation = useLogoutMutation();
	const { loading, isAuthenticated } = useAuthenticated();
	const { data: user } = useCurrentUser();

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
		await logoutMutation.mutateAsync({
			doRedirect: true,
		});
	};

	return (
		<>
			{isAuthenticated && user && ENABLE_ANNOUNCEMENTS && (
				<TopAnnouncementBar />
			)}
			<Paper
				component="header"
				shadow="xs"
				radius="0"
				className="z-30 h-full w-full px-4"
				bg={{ dark: "dark.8", light: "white" }}
			>
				<Group
					justify="space-between"
					align="center"
					className="h-full min-h-[58px] w-full"
				>
					<Group gap="md">
						<I18nLink to="/projects">
							<Group align="center">
								<Logo
									hideTitle={false}
									textAfterLogo={
										<span className="text-xl font-normal">ECHO</span>
									}
								/>
							</Group>
						</I18nLink>
					</Group>

					{!loading && isAuthenticated && user ? (
						<Group>
							{ENABLE_ANNOUNCEMENTS && (
								<>
									<AnnouncementIcon />
									<Announcements />
								</>
							)}
							<Menu withArrow arrowPosition="center">
								<Menu.Target>
									<ActionIcon color="gray" variant="transparent">
										<IconSettings />
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
											rightSection={<IconNotes />}
											component="a"
											href={docUrl}
											target="_blank"
										>
											<Group>
												<Trans>Documentation</Trans>
											</Group>
										</Menu.Item>

										<CreateFeedbackButton />

										<Menu.Item
											rightSection={<IconLogout />}
											onClick={handleLogout}
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
