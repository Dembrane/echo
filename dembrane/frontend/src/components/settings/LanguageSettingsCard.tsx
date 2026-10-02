import { Trans } from "@lingui/react/macro";
import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { TranslateIcon } from "@phosphor-icons/react";
import { LanguagePicker } from "@/components/language/LanguagePicker";

export const LanguageSettingsCard = () => {
	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<TranslateIcon size={24} />
					<Title order={3}>
						<Trans>Language</Trans>
					</Title>
				</Group>
				<Text size="sm" c="dimmed">
					<Trans>Choose your preferred language for the interface</Trans>
				</Text>

				<div style={{ maxWidth: 320 }}>
					<LanguagePicker />
				</div>
			</Stack>
		</Card>
	);
};
