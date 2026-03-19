import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Container,
	Divider,
	Group,
	NavLink,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import {
	IconArrowLeft,
	IconPalette,
	IconScale,
	IconShieldLock,
} from "@tabler/icons-react";
import { useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { AccountSettingsCard } from "@/components/settings/AccountSettingsCard";
import { AuditLogsCard } from "@/components/settings/AuditLogsCard";
import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";
import { FontSettingsCard } from "@/components/settings/FontSettingsCard";
import { FontSizeSettingsCard } from "@/components/settings/FontSizeSettingsCard";
import { LegalBasisSettingsCard } from "@/components/settings/LegalBasisSettingsCard";
import { TwoFactorSettingsCard } from "@/components/settings/TwoFactorSettingsCard";
import { WhitelabelLogoCard } from "@/components/settings/WhitelabelLogoCard";
import { UserAvatar } from "@/components/common/UserAvatar";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

type SectionId = "account" | "appearance" | "project-defaults";

const SECTIONS: Array<{
	id: SectionId;
	icon: typeof IconShieldLock;
	label: () => string;
}> = [
	{
		id: "account",
		icon: IconShieldLock,
		label: () => t`Account & Security`,
	},
	{ id: "appearance", icon: IconPalette, label: () => t`Appearance` },
	{
		id: "project-defaults",
		icon: IconScale,
		label: () => t`Project Defaults`,
	},
];

export const UserSettingsRoute = () => {
	useDocumentTitle(t`Settings | Dembrane`);
	const { data: user, isLoading } = useCurrentUser();
	const navigate = useI18nNavigate();
	const [activeSection, setActiveSection] = useState<SectionId>("account");

	const isTwoFactorEnabled = Boolean(user?.tfa_secret);

	return (
		<Container size="xl" py="xl">
			<Stack gap="lg">
				{/* Header */}
				<Group gap="sm" align="center">
					<ActionIcon
						variant="subtle"
						color="gray"
						onClick={() => navigate("..")}
						aria-label={t`Go back`}
					>
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={2}>
						<Trans>Settings</Trans>
					</Title>
				</Group>

				{/* Two-column layout */}
				<Group align="flex-start" gap="xl" wrap="nowrap">
					{/* Sidebar */}
					<Box
						className="shrink-0"
						w={220}
						style={{
							position: "sticky",
							top: 80,
						}}
					>
						<Stack gap={4}>
							{/* User identity in sidebar */}
							<Group gap="sm" className="px-3 py-2">
								<UserAvatar size={36} />
								<Box className="min-w-0 flex-1">
									<Text size="sm" fw={500} truncate>
										{(user?.first_name as string) ??
											"User"}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{user?.email ?? ""}
									</Text>
								</Box>
							</Group>

							<Divider my="xs" />

							{SECTIONS.map((section) => (
								<NavLink
									key={section.id}
									label={section.label()}
									leftSection={
										<section.icon size={16} />
									}
									active={activeSection === section.id}
									onClick={() =>
										setActiveSection(section.id)
									}
									variant="light"
									style={{ borderRadius: 8 }}
								/>
							))}
						</Stack>
					</Box>

					{/* Content */}
					<Box className="min-w-0 flex-1">
						<ScrollArea>
							{activeSection === "account" && (
								<Stack gap="lg">
									<Title order={3}>
										<Trans>Account & Security</Trans>
									</Title>

									<AccountSettingsCard />

									<ChangePasswordCard />

									<TwoFactorSettingsCard
										isLoading={isLoading}
										isTwoFactorEnabled={
											isTwoFactorEnabled
										}
									/>

									<AuditLogsCard />
								</Stack>
							)}

							{activeSection === "appearance" && (
								<Stack gap="lg">
									<Title order={3}>
										<Trans>Appearance</Trans>
									</Title>

									<FontSettingsCard />
									<FontSizeSettingsCard />
								</Stack>
							)}

							{activeSection === "project-defaults" && (
								<Stack gap="lg">
									<Title order={3}>
										<Trans>Project Defaults</Trans>
									</Title>

									<WhitelabelLogoCard />
									<LegalBasisSettingsCard />
								</Stack>
							)}
						</ScrollArea>
					</Box>
				</Group>
			</Stack>
		</Container>
	);
};
