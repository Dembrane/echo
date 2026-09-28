import { Trans } from "@lingui/react/macro";
import { Badge, Box, Group, Text } from "@mantine/core";
import { IconMessageCircle, IconSparkles } from "@tabler/icons-react";
import { AgenticMark } from "./AgenticMark";
import { MODE_COLORS } from "./ChatModeSelector";

type ChatModeBannerProps = {
	mode: "overview" | "deep_dive" | "agentic";
	conversationCount: number;
};

export const ChatModeBanner = ({
	mode,
	conversationCount,
}: ChatModeBannerProps) => {
	const isOverview = mode === "overview";
	const isAgentic = mode === "agentic";
	const colors = MODE_COLORS[mode];

	return (
		<Box
			className="rounded-lg px-4 py-2.5"
			data-testid="chat-mode-banner"
			style={
				isAgentic
					? {
							backgroundColor: "var(--app-background)",
							border: "1px solid var(--mantine-color-gray-3)",
						}
					: {
							backgroundColor: colors.lighter,
							border: `1px solid ${colors.border}`,
						}
			}
		>
			<Group justify="space-between" wrap="nowrap">
				<Group gap="sm" wrap="nowrap">
					{isAgentic ? (
						<AgenticMark size={20} />
					) : isOverview ? (
						<IconSparkles size={16} stroke={1.8} color={colors.primary} />
					) : (
						<IconMessageCircle size={16} stroke={1.8} color={colors.primary} />
					)}
					<Text size="sm" fw={500} c={MODE_COLORS.graphite}>
						{isOverview ? (
							<Trans>Overview</Trans>
						) : isAgentic ? (
							<Trans>Agentic</Trans>
						) : (
							<Trans>Specific Details</Trans>
						)}
					</Text>
					{isOverview && (
						<Badge size="sm" color="mauve" c="graphite">
							<Trans>Beta</Trans>
						</Badge>
					)}
				</Group>

				<Text size="xs" c="dimmed">
					{isOverview ? (
						<Trans>Exploring {conversationCount} conversations</Trans>
					) : isAgentic ? (
						<Trans>Live agent execution mode</Trans>
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
