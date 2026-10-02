import { Trans } from "@lingui/react/macro";
import {
	Card,
	Group,
	SegmentedControl,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { TextAaIcon } from "@phosphor-icons/react";
import {
	type FontSizeScale,
	useAppPreferences,
} from "@/hooks/useAppPreferences";

const FONT_SIZE_OPTIONS: {
	value: FontSizeScale;
	label: string;
	px: number;
	visualSize: number;
}[] = [
	{
		label: "A",
		px: 12,
		value: "xs",
		visualSize: 10,
	},
	{
		label: "A",
		px: 14,
		value: "small",
		visualSize: 13,
	},
	{
		label: "A",
		px: 16,
		value: "normal",
		visualSize: 16,
	},
	{
		label: "A",
		px: 18,
		value: "large",
		visualSize: 19,
	},
	{
		label: "A",
		px: 20,
		value: "xl",
		visualSize: 22,
	},
];

export const FontSizeSettingsCard = () => {
	const { preferences, setFontSizeScale } = useAppPreferences();

	const currentOption = FONT_SIZE_OPTIONS.find(
		(opt) => opt.value === preferences.fontSizeScale,
	);
	const currentPx = currentOption?.px ?? 16;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<TextAaIcon size={24} />
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
						label: (
							<Text
								fw={preferences.fontSizeScale === opt.value ? 600 : 320}
								style={{
									fontSize: opt.visualSize,
								}}
							>
								{opt.label}
							</Text>
						),
						value: opt.value,
					}))}
				/>

				<Text size="sm" c="dimmed">
					{currentPx}px
				</Text>

				<Text size="sm" c="dimmed" style={{ fontStyle: "italic" }}>
					<Trans>Preview: The quick brown fox jumps over the lazy dog.</Trans>
				</Text>
			</Stack>
		</Card>
	);
};
