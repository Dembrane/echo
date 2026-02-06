import { Trans } from "@lingui/react/macro";
import { Card, Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { IconTextSize } from "@tabler/icons-react";
import {
	type FontSizeScale,
	useAppPreferences,
} from "@/hooks/useAppPreferences";

const FONT_SIZE_OPTIONS: {
	value: FontSizeScale;
	label: string;
	px: { "dm-sans": number; "space-grotesk": number };
	visualSize: number;
}[] = [
	{ value: "xs", label: "A", px: { "dm-sans": 14, "space-grotesk": 12 }, visualSize: 10 },
	{ value: "small", label: "A", px: { "dm-sans": 16, "space-grotesk": 14 }, visualSize: 13 },
	{ value: "normal", label: "A", px: { "dm-sans": 18, "space-grotesk": 16 }, visualSize: 16 },
	{ value: "large", label: "A", px: { "dm-sans": 20, "space-grotesk": 18 }, visualSize: 19 },
	{ value: "xl", label: "A", px: { "dm-sans": 22, "space-grotesk": 20 }, visualSize: 22 },
];

export const FontSizeSettingsCard = () => {
	const { preferences, setFontSizeScale } = useAppPreferences();

	const currentOption = FONT_SIZE_OPTIONS.find(
		(opt) => opt.value === preferences.fontSizeScale,
	);
	const currentPx = currentOption?.px[preferences.fontFamily] ?? 16;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconTextSize size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Font Size</Trans>
					</Title>
				</Group>
				<Text size="sm" c="dimmed">
					<Trans>Adjust the base font size for the interface</Trans>
				</Text>

				<SegmentedControl
					value={preferences.fontSizeScale}
					onChange={(value) => setFontSizeScale(value as FontSizeScale)}
					data={FONT_SIZE_OPTIONS.map((opt) => ({
						value: opt.value,
						label: (
							<Text
								fw={preferences.fontSizeScale === opt.value ? 700 : 400}
								style={{
									fontSize: opt.visualSize,
								}}
							>
								{opt.label}
							</Text>
						),
					}))}
				/>

				<Text size="sm" c="dimmed">
					{currentPx}px
				</Text>

				<Text size="sm" c="dimmed" style={{ fontStyle: "italic" }}>
					<Trans>
						Preview: The quick brown fox jumps over the lazy dog.
					</Trans>
				</Text>
			</Stack>
		</Card>
	);
};
