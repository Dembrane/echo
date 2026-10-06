import { Trans, useLingui } from "@lingui/react/macro";
import {
	Card,
	Group,
	type MantineColorScheme,
	type MantineSize,
	SegmentedControl,
	Stack,
	Text,
	Title,
	useMantineColorScheme,
} from "@mantine/core";
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";

// Mantine keeps the choice (localStorage, per browser); index.html reads it
// before React mounts so the first paint is already in the right scheme.
// One control for System / Light / Dark, here and in the user menu.
export const ColorSchemeControl = ({ size }: { size?: MantineSize }) => {
	const { t } = useLingui();
	const { colorScheme, setColorScheme } = useMantineColorScheme();
	const option = (
		value: MantineColorScheme,
		label: string,
		Icon: typeof SunIcon,
	) => ({
		label: (
			<Group gap={4} justify="center" wrap="nowrap">
				<Icon size={16} aria-hidden />
				<span>{label}</span>
			</Group>
		),
		value,
	});

	return (
		<SegmentedControl
			fullWidth
			size={size}
			aria-label={t`Theme`}
			value={colorScheme}
			onChange={(value) => setColorScheme(value as MantineColorScheme)}
			data={[
				option("auto", t`System`, DesktopIcon),
				option("light", t`Light`, SunIcon),
				option("dark", t`Dark`, MoonIcon),
			]}
		/>
	);
};

export const ColorSchemeSettingsCard = () => (
	<Card withBorder p="lg">
		<Stack gap="md">
			<Title order={4}>
				<Trans>Theme</Trans>
			</Title>
			<Text size="sm" c="dimmed">
				<Trans>System follows your device's light or dark setting.</Trans>
			</Text>
			<ColorSchemeControl />
		</Stack>
	</Card>
);
