import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Container,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { AccountSettingsCard } from "@/components/settings/AccountSettingsCard";
import { AssistantMemoryCard } from "@/components/settings/AssistantMemoryCard";
import { AuditLogsCard } from "@/components/settings/AuditLogsCard";
import { BetaFeaturesCard } from "@/components/settings/BetaFeaturesCard";
import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";
import { ColorSchemeSettingsCard } from "@/components/settings/ColorSchemeSettingsCard";
import { FontSizeSettingsCard } from "@/components/settings/FontSizeSettingsCard";
import { LanguageSettingsCard } from "@/components/settings/LanguageSettingsCard";
import { MyAccessCard } from "@/components/settings/MyAccessCard";
import { TwoFactorSettingsCard } from "@/components/settings/TwoFactorSettingsCard";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

type SectionId = "account" | "access" | "appearance" | "assistant";

const resolveSection = (section?: string): SectionId =>
	section === "access" || section === "appearance" || section === "assistant"
		? section
		: "account";

export const UserSettingsRoute = () => {
	useDocumentTitle(t`Settings | dembrane`);
	const { data: user, isLoading } = useCurrentUser();
	const navigate = useI18nNavigate();
	const { section: urlSection } = useParams<{ section?: string }>();

	const activeSection = resolveSection(urlSection);
	const isTwoFactorEnabled = Boolean(user?.tfa_enabled);

	return (
		<Container size="xl" px="lg" py="xl">
			<Stack gap="lg">
				<div className="flex items-center">
					<div className="hidden md:flex w-14 shrink-0 items-center">
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => navigate("..")}
							aria-label={t`Go back`}
						>
							<ArrowLeftIcon size={20} />
						</ActionIcon>
					</div>
					<Title order={2}>
						<Trans>Settings</Trans>
					</Title>
				</div>

				{/* Inner sidebar retired — section navigation lives in the main
				    AppSidebar. The page renders only the active section. */}
				<Box className="min-w-0 flex-1">
					<ScrollArea>
						{activeSection === "account" && (
							<Stack gap="lg">
								<Title order={4}>
									<Trans>Account & security</Trans>
								</Title>

								<AccountSettingsCard />

								<ChangePasswordCard />

								<TwoFactorSettingsCard
									isLoading={isLoading}
									isTwoFactorEnabled={isTwoFactorEnabled}
								/>

								<AuditLogsCard />
							</Stack>
						)}

						{activeSection === "access" && (
							<Stack gap="lg">
								<Stack gap={4}>
									<Title order={4}>
										<Trans>My access</Trans>
									</Title>
									<Text size="sm" c="dimmed">
										<Trans>
											This is a map of every organisation and workspace you are
											a member of.
										</Trans>
									</Text>
								</Stack>
								<MyAccessCard />
							</Stack>
						)}

						{activeSection === "appearance" && (
							<Stack gap="lg">
								<Title order={4}>
									<Trans>Appearance</Trans>
								</Title>

								<ColorSchemeSettingsCard />
								<FontSizeSettingsCard />
								<LanguageSettingsCard />
								<BetaFeaturesCard />
							</Stack>
						)}

						{activeSection === "assistant" && (
							<Stack gap="lg">
								<Title order={4}>
									<Trans>Assistant</Trans>
								</Title>

								<AssistantMemoryCard />
							</Stack>
						)}
					</ScrollArea>
				</Box>
			</Stack>
		</Container>
	);
};
