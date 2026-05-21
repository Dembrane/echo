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
	IconBuildingCommunity,
	IconPalette,
	IconScale,
	IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { API_BASE_URL } from "@/config";
import { AccountSettingsCard } from "@/components/settings/AccountSettingsCard";
import { AuditLogsCard } from "@/components/settings/AuditLogsCard";
import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";
import { FontSettingsCard } from "@/components/settings/FontSettingsCard";
import { FontSizeSettingsCard } from "@/components/settings/FontSizeSettingsCard";
import { LegalBasisSettingsCard } from "@/components/settings/LegalBasisSettingsCard";
import { MyAccessCard } from "@/components/settings/MyAccessCard";
import { TwoFactorSettingsCard } from "@/components/settings/TwoFactorSettingsCard";
import { UserAvatar } from "@/components/common/UserAvatar";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

type SectionId =
	| "account"
	| "access"
	| "appearance"
	| "project-defaults";

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
	{
		id: "access",
		icon: IconBuildingCommunity,
		label: () => t`My access`,
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

	const isTwoFactorEnabled = Boolean(user?.tfa_enabled);

	const { data: accessData } = useQuery<{
		organisations: Array<{ id: string }>;
	} | null>({
		queryKey: ["v2", "workspaces"],
		queryFn: async () => {
			const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
				credentials: "include",
			});
			if (!res.ok) return null;
			return res.json();
		},
		staleTime: 60_000,
	});
	const isExternalOnly = (accessData?.organisations.length ?? 0) === 0;

	const visibleSections = useMemo(
		() => SECTIONS.filter((s) => !(isExternalOnly && s.id === "project-defaults")),
		[isExternalOnly],
	);

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

							{visibleSections.map((section) => (
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

							{activeSection === "access" && (
								<Stack gap="lg">
									<Title order={3}>
										<Trans>My access</Trans>
									</Title>
									<MyAccessCard />
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

							{activeSection === "project-defaults" && !isExternalOnly && (
								<Stack gap="lg">
									<Title order={3}>
										<Trans>Project Defaults</Trans>
									</Title>

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
