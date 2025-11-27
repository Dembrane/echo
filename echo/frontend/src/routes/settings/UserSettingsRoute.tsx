import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Container,
	Divider,
	Group,
	Stack,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconArrowLeft } from "@tabler/icons-react";
import { useCurrentUser } from "@/components/auth/hooks";
import { AuditLogsCard } from "@/components/settings/AuditLogsCard";
import { TwoFactorSettingsCard } from "@/components/settings/TwoFactorSettingsCard";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

export const UserSettingsRoute = () => {
	useDocumentTitle(t`Settings | Dembrane`);
	const { data: user, isLoading } = useCurrentUser();
	const navigate = useI18nNavigate();

	const isTwoFactorEnabled = Boolean(user?.tfa_secret);

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
					<Title order={1}>
						<Trans>Settings</Trans>
					</Title>
				</Group>

				<Divider />

				<TwoFactorSettingsCard
					isLoading={isLoading}
					isTwoFactorEnabled={isTwoFactorEnabled}
				/>

				<AuditLogsCard />
			</Stack>
		</Container>
	);
};
