import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Group,
	Loader,
	Stack,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import {
	IconMessageCircle,
	IconSparkles,
	IconQuote,
} from "@tabler/icons-react";
import { useState } from "react";
import type { ChatMode } from "@/lib/api";
import { useInitializeChatModeMutation } from "./hooks";

// Color palette from design spec - shared across chat components
export const MODE_COLORS = {
	overview: {
		primary: "#1EFFA1", // spring green
		border: "#1EFFA1", // spring green border
		lighter: "rgba(30, 255, 161, 0.1)", // very subtle green bg
		shadow: "rgba(30, 255, 161, 0.12)", // subtle green shadow
		badge: "teal",
	},
	deep_dive: {
		primary: "#00FFFF", // cyan
		border: "#00FFFF", // cyan border
		lighter: "rgba(0, 255, 255, 0.1)", // very subtle cyan bg
		shadow: "rgba(0, 255, 255, 0.1)", // subtle cyan shadow
		badge: "cyan",
	},
	// Use CSS variable for theme-aware text color
	graphite: "var(--app-text)",
};

// Sample questions for each mode - wrapped in function to enable translation
const getOverviewExamples = () => [
	t`What are the main themes across all conversations?`,
	t`Summarize key insights from my interviews`,
	t`What patterns emerge from the data?`,
];

const getDeepDiveExamples = () => [
	t`Summarize this interview into a shareable article`,
	t`Pull out the most impactful quotes from this session`,
	t`What were the key moments in this conversation?`,
];

type ModeCardProps = {
	mode: ChatMode;
	title: string;
	subtitle: string;
	examples: string[];
	icon: typeof IconSparkles;
	isBeta?: boolean;
	selectedMode: ChatMode | null;
	isLoading: boolean;
	onSelectMode: (mode: ChatMode) => void;
};

const ModeCard = ({
	mode,
	title,
	subtitle,
	examples,
	icon: Icon,
	isBeta = false,
	selectedMode,
	isLoading,
	onSelectMode,
}: ModeCardProps) => {
	const colors = MODE_COLORS[mode];
	const isSelected = selectedMode === mode;
	const isThisLoading = isLoading && isSelected;

	return (
		<UnstyledButton
			onClick={() => onSelectMode(mode)}
			disabled={isLoading}
			className={`w-full transition-all duration-200 ${isLoading && !isSelected ? "opacity-50" : ""}`}
		>
			<Box
				className={`
					relative overflow-hidden rounded border p-6
					transition-all duration-200 ease-out
					hover:scale-[1.005]
				`}
				style={{
					backgroundColor: "var(--app-background)",
					borderColor: isSelected ? colors.primary : "var(--mantine-color-gray-3)",
					boxShadow: isSelected ? `0 4px 16px ${colors.shadow}` : undefined,
				}}
				onMouseEnter={(e) => {
					if (!isSelected) {
						e.currentTarget.style.borderColor = colors.primary;
						e.currentTarget.style.boxShadow = `0 4px 16px ${colors.shadow}`;
					}
				}}
				onMouseLeave={(e) => {
					if (!isSelected) {
						e.currentTarget.style.borderColor = "var(--mantine-color-gray-3)";
						e.currentTarget.style.boxShadow = "none";
					}
				}}
			>
				<Stack gap="lg">
					{/* Header */}
					<Group justify="space-between" align="flex-start">
						<Group gap="md">
							<Box
								className="flex items-center justify-center rounded-full"
								style={{
									backgroundColor: "var(--app-background)",
									border: `1.5px solid ${colors.border}`,
									padding: 10,
								}}
							>
								{isThisLoading ? (
									<Loader size={24} color={colors.primary} />
								) : (
									<Icon size={24} stroke={2} color={colors.primary} />
								)}
							</Box>
							<Stack gap={4}>
								<Group gap="sm">
									<Text fw={600} size="lg" style={{ color: "var(--app-text)" }}>
										{title}
									</Text>
								{isBeta && (
									<Badge
										size="sm"
										variant="outline"
										styles={{
											root: {
												backgroundColor: "transparent",
												borderColor: "var(--app-text)",
												color: "var(--app-text)",
											},
										}}
									>
										<Trans>Beta</Trans>
									</Badge>
								)}
								</Group>
								<Text size="sm" c="dimmed">
									{subtitle}
								</Text>
							</Stack>
						</Group>
					</Group>

					{/* Example questions */}
					<Stack gap="sm">
						<Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: 0.5 }}>
							<Trans>Try asking</Trans>
						</Text>
						{examples.map((example) => (
							<Group key={example} gap="sm" wrap="nowrap" align="flex-start">
								<IconQuote
									size={14}
									color={colors.primary}
									style={{ marginTop: 2, flexShrink: 0 }}
								/>
								<Text size="sm" c="dimmed" lh={1.5}>
									{example}
								</Text>
							</Group>
						))}
					</Stack>
				</Stack>
			</Box>
		</UnstyledButton>
	);
};

type ChatModeSelectorProps = {
	// For existing chat (mode selection after chat created)
	chatId?: string;
	projectId: string;
	onModeSelected?: (mode: ChatMode) => void;
	// For new chat flow (mode selection before chat created)
	isNewChat?: boolean;
	isCreating?: boolean;
};

export const ChatModeSelector = ({
	chatId,
	projectId,
	onModeSelected,
	isNewChat = false,
	isCreating = false,
}: ChatModeSelectorProps) => {
	const [selectedMode, setSelectedMode] = useState<ChatMode | null>(null);
	const initializeModeMutation = useInitializeChatModeMutation();

	const handleSelectMode = async (mode: ChatMode) => {
		setSelectedMode(mode);

		if (isNewChat) {
			// For new chat, just call the callback - parent will create the chat
			onModeSelected?.(mode);
		} else if (chatId) {
			// For existing chat, call the initialize endpoint
			try {
				await initializeModeMutation.mutateAsync({
					chatId,
					mode,
					projectId,
				});
				onModeSelected?.(mode);
			} catch {
				setSelectedMode(null);
			}
		}
	};

	const isLoading = initializeModeMutation.isPending || isCreating;

	return (
		<Box className="mx-auto w-full max-w-2xl px-6 py-8">
			<Stack gap="xl">
				{/* Header */}
				<Stack gap={6} align="center">
					<Title order={2} ta="center" style={{ color: "var(--app-text)" }} fw={600}>
						<Trans>What would you like to explore?</Trans>
					</Title>
					<Text size="md" c="dimmed" ta="center">
						<Trans>Pick the approach that fits your question</Trans>
					</Text>
				</Stack>

				{/* Mode Cards */}
				<Stack gap="lg">
					<ModeCard
						mode="deep_dive"
						title={t`Specific Details`}
						subtitle={t`Select conversations and find exact quotes`}
						examples={getDeepDiveExamples()}
						icon={IconMessageCircle}
						selectedMode={selectedMode}
						isLoading={isLoading}
						onSelectMode={handleSelectMode}
					/>

				<ModeCard
					mode="overview"
					title={t`Overview`}
					subtitle={t`Explore themes & patterns across all conversations`}
					examples={getOverviewExamples()}
					icon={IconSparkles}
					isBeta
					selectedMode={selectedMode}
					isLoading={isLoading}
					onSelectMode={handleSelectMode}
				/>
				</Stack>

				{/* Loading message */}
				{isLoading && selectedMode === "overview" && (
					<Text size="sm" c="dimmed" ta="center" fs="italic">
						<Trans>
							Preparing your conversations... This may take a moment.
						</Trans>
					</Text>
				)}
			</Stack>
		</Box>
	);
};

