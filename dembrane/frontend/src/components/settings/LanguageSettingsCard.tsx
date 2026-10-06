import { Trans } from "@lingui/react/macro";
import { Card, Stack, Text, Title } from "@mantine/core";
import { LanguagePicker } from "@/components/language/LanguagePicker";

export const LanguageSettingsCard = () => {
	return (
		<Card withBorder p="lg">
			<Stack gap="md">
				<Title order={4}>
					<Trans>Language</Trans>
				</Title>
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
