import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Container,
	Divider,
	Group,
	Stack,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconArrowLeft } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { AuditLogsCard } from "@/components/settings/AuditLogsCard";
import { FontSettingsCard } from "@/components/settings/FontSettingsCard";
import { FontSizeSettingsCard } from "@/components/settings/FontSizeSettingsCard";
import { LegalBasisSettingsCard } from "@/components/settings/LegalBasisSettingsCard";
import { TwoFactorSettingsCard } from "@/components/settings/TwoFactorSettingsCard";
import { WhitelabelLogoCard } from "@/components/settings/WhitelabelLogoCard";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

export const UserSettingsRoute = () => {
	useDocumentTitle(t`Settings | Dembrane`);
	const { data: user, isLoading } = useCurrentUser();
	const navigate = useI18nNavigate();
	const location = useLocation();

	const isTwoFactorEnabled = Boolean(user?.tfa_secret);
	const legalBasisRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (location.hash === "#legal-basis") {
			legalBasisRef.current?.scrollIntoView({
				behavior: "smooth",
				block: "center",
			});
		}
	}, [location.hash]);

	return (
		<Container size="lg" py="xl">
			<Stack gap="xl">
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

				<Divider />

				<FontSettingsCard />

				<FontSizeSettingsCard />

				<WhitelabelLogoCard />

				<Box ref={legalBasisRef}>
					<LegalBasisSettingsCard />
				</Box>

				<TwoFactorSettingsCard
					isLoading={isLoading}
					isTwoFactorEnabled={isTwoFactorEnabled}
				/>

				<AuditLogsCard />
			</Stack>
		</Container>
	);
};
