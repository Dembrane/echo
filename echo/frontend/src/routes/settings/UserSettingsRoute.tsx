import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Container,
	Group,
	ScrollArea,
	Stack,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconArrowLeft } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { AccountSettingsCard } from "@/components/settings/AccountSettingsCard";
import { AuditLogsCard } from "@/components/settings/AuditLogsCard";
import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";
import { FontSettingsCard } from "@/components/settings/FontSettingsCard";
import { FontSizeSettingsCard } from "@/components/settings/FontSizeSettingsCard";
import { LegalBasisSettingsCard } from "@/components/settings/LegalBasisSettingsCard";
import { MyAccessCard } from "@/components/settings/MyAccessCard";
import { TwoFactorSettingsCard } from "@/components/settings/TwoFactorSettingsCard";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

type SectionId = "account" | "access" | "appearance" | "project-defaults";

const resolveSection = (section?: string): SectionId =>
	section === "access" ||
	section === "appearance" ||
	section === "project-defaults"
		? section
		: "account";

export const UserSettingsRoute = () => {
	useDocumentTitle(t`Settings | dembrane`);
	const { data: user, isLoading } = useCurrentUser();
	const navigate = useI18nNavigate();
	const { section: urlSection } = useParams<{ section?: string }>();

	const { data: accessData } = useQuery<{
		organisations: Array<{ id: string }>;
	} | null>({
		queryFn: async () => {
			const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
				credentials: "include",
			});
			if (!res.ok) return null;
			return res.json();
		},
		queryKey: ["v2", "workspaces"],
		staleTime: 60_000,
	});

	const requestedSection = resolveSection(urlSection);
	const isExternalOnly = (accessData?.organisations.length ?? 0) === 0;
	const activeSection =
		isExternalOnly && requestedSection === "project-defaults"
			? "account"
			: requestedSection;
	const isTwoFactorEnabled = Boolean(user?.tfa_enabled);

	return (
		<Container size="xl" py="xl">
			<Stack gap="lg">
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

				{/* Inner sidebar retired — section navigation lives in the main
				    AppSidebar. The page renders only the active section. */}
				<Box className="min-w-0 flex-1">
					<ScrollArea>
						{activeSection === "account" && (
							<Stack gap="lg">
								<Title order={3}>
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
									<Trans>Project defaults</Trans>
								</Title>

								<LegalBasisSettingsCard />
							</Stack>
						)}
					</ScrollArea>
				</Box>
			</Stack>
		</Container>
	);
};
