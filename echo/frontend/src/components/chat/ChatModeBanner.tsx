import { Trans } from "@lingui/react/macro";
import { Badge, Box, Group, Text } from "@mantine/core";
import { IconSparkles, IconMessageCircle } from "@tabler/icons-react";
import { MODE_COLORS } from "./ChatModeSelector";

type ChatModeBannerProps = {
	mode: "overview" | "deep_dive";
	conversationCount: number;
};

export const ChatModeBanner = ({
	mode,
	conversationCount,
}: ChatModeBannerProps) => {
	const isOverview = mode === "overview";
	const colors = MODE_COLORS[mode];

	return (
		<Box
			className="rounded-lg px-4 py-2.5"
			style={{
				backgroundColor: colors.light,
				border: `1px solid ${colors.border}`,
			}}
		>
			<Group justify="space-between" wrap="nowrap">
				<Group gap="sm" wrap="nowrap">
					{isOverview ? (
						<IconSparkles size={16} stroke={1.8} color={colors.primary} />
					) : (
						<IconMessageCircle
							size={16}
							stroke={1.8}
							color={colors.primary}
						/>
					)}
					<Text size="sm" fw={500} c={MODE_COLORS.graphite}>
						{isOverview ? (
							<Trans>Big Picture</Trans>
						) : (
							<Trans>Specific Details</Trans>
						)}
					</Text>
					{isOverview && (
						<Badge
							size="xs"
							color={colors.badge}
							variant="light"
							radius="sm"
							tt="uppercase"
							style={{ fontSize: 9 }}
						>
							Beta
						</Badge>
					)}
				</Group>

				<Text size="xs" c="dimmed">
					{isOverview ? (
						<Trans>
							Exploring {conversationCount} conversations
						</Trans>
					) : conversationCount > 0 ? (
						<Trans>{conversationCount} selected</Trans>
					) : (
						<Trans>Select conversations from sidebar</Trans>
					)}
				</Text>
			</Group>
		</Box>
	);
};

