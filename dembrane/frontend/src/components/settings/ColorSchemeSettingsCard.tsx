import { Trans, useLingui } from "@lingui/react/macro";
import {
	Card,
	type MantineColorScheme,
	SegmentedControl,
	Stack,
	Text,
	Title,
	useMantineColorScheme,
} from "@mantine/core";

// Mantine keeps the choice (localStorage, per browser); index.html reads it
// before React mounts so the first paint is already in the right scheme.
export const ColorSchemeSettingsCard = () => {
	const { t } = useLingui();
	const { colorScheme, setColorScheme } = useMantineColorScheme();

	return (
		<Card withBorder p="lg">
			<Stack gap="md">
				<Title order={4}>
					<Trans>Theme</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>System follows your device's light or dark setting.</Trans>
				</Text>
				<SegmentedControl
					value={colorScheme}
					onChange={(value) => setColorScheme(value as MantineColorScheme)}
					data={[
						{ label: t`System`, value: "auto" },
						{ label: t`Light`, value: "light" },
						{ label: t`Dark`, value: "dark" },
					]}
				/>
			</Stack>
		</Card>
	);
};
