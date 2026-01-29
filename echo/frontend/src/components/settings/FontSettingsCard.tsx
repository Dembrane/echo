import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Card, Group, Radio, Stack, Text, Title } from "@mantine/core";
import { IconTypography } from "@tabler/icons-react";
import { useTransitionCurtain } from "@/components/layout/TransitionCurtainProvider";
import { type FontFamily, useAppPreferences } from "@/hooks/useAppPreferences";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

const FONT_OPTIONS: {
	value: FontFamily;
	label: string;
	preview: string;
	colors: { bg: string; text: string; label: string };
	transitionMessage: string;
	transitionDescription: string;
}[] = [
	{
		colors: { bg: "#FFFFFF", label: "White & Black", text: "#000000" },
		label: "Space Grotesk",
		preview: "The quick brown fox jumps over the lazy dog",
		transitionDescription: "Crisp whites and sharp contrasts ahead...",
		transitionMessage: "Switching to Clean Mode",
		value: "space-grotesk",
	},
	{
		colors: { bg: "#F6F4F1", label: "Parchment & Graphite", text: "#2D2D2C" },
		label: "DM Sans",
		preview: "The quick brown fox jumps over the lazy dog",
		transitionDescription: "Soft parchment tones for a gentler experience...",
		transitionMessage: "Embracing Warmth",
		value: "dm-sans",
	},
];

export const FontSettingsCard = () => {
	const { preferences, setFontFamily } = useAppPreferences();
	const { runTransition } = useTransitionCurtain();
	const navigate = useI18nNavigate();

	const handleThemeChange = async (newTheme: FontFamily) => {
		// Don't transition if selecting the same theme
		if (newTheme === preferences.fontFamily) return;

		const selectedOption = FONT_OPTIONS.find((opt) => opt.value === newTheme);
		if (!selectedOption) return;

		// Start the dramatic transition
		const transitionPromise = runTransition({
			description: t`${selectedOption.transitionDescription}`,
			dramatic: true, // Enable dramatic mode for theme changes
			message: t`${selectedOption.transitionMessage}`,
		});

		// Apply the theme change after a brief moment so it happens during the blur
		setTimeout(() => {
			setFontFamily(newTheme);
		}, 800);

		// Wait for transition to complete then navigate to projects
		await transitionPromise;
		navigate("/projects");
	};

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconTypography size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Theme</Trans>
					</Title>
				</Group>
				<Text size="sm" c="dimmed">
					<Trans>Choose your preferred theme for the interface</Trans>
				</Text>

				<Radio.Group
					value={preferences.fontFamily}
					onChange={(value) => handleThemeChange(value as FontFamily)}
				>
					<Stack gap="sm">
						{FONT_OPTIONS.map((option) => (
							<Card
								key={option.value}
								withBorder
								p="md"
								radius="sm"
								className="cursor-pointer transition-all hover:shadow-md"
								onClick={() => handleThemeChange(option.value)}
								style={{
									borderColor:
										preferences.fontFamily === option.value
											? option.colors.text
											: undefined,
									borderWidth: preferences.fontFamily === option.value ? 2 : 1,
								}}
							>
								<Group justify="space-between" align="center">
									<Stack gap="xs" style={{ flex: 1 }}>
										<Group gap="sm">
											<Radio value={option.value} />
											<Text fw={600}>{option.label}</Text>
										</Group>
										<Text size="xs" c="dimmed">
											{option.colors.label}
										</Text>
									</Stack>
									{/* Color scheme preview */}
									<div
										style={{
											backgroundColor: option.colors.bg,
											border: `1px solid ${option.colors.text}20`,
											borderRadius: 6,
											color: option.colors.text,
											fontFamily:
												option.value === "dm-sans"
													? "'DM Sans Variable', sans-serif"
													: "'Space Grotesk Variable', sans-serif",
											fontFeatureSettings:
												option.value === "dm-sans"
													? "'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss05' on, 'ss06' on, 'ss08' on"
													: "normal",
											fontSize: 13,
											minWidth: 200,
											padding: "12px 16px",
										}}
									>
										{option.preview}
									</div>
								</Group>
							</Card>
						))}
					</Stack>
				</Radio.Group>
			</Stack>
		</Card>
	);
};
