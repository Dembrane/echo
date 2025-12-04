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
// Uses Tailwind color values for consistency
export const MODE_COLORS = {
	overview: {
		primary: "#f59e0b", // amber-500
		light: "#fffbeb", // amber-50
		lighter: "#fef3c7", // amber-100
		border: "rgba(245, 158, 11, 0.25)", // amber with opacity
		badge: "yellow",
	},
	deep_dive: {
		primary: "#a855f7", // purple-500
		light: "#faf5ff", // purple-50
		lighter: "#f3e8ff", // purple-100
		border: "rgba(168, 85, 247, 0.25)", // purple with opacity
		badge: "grape",
	},
	graphite: "#2d2d2c",
};

// Sample questions for each mode
const OVERVIEW_EXAMPLES = [
	"What are the main themes across all conversations?",
	"Summarize key insights from my interviews",
	"What patterns emerge from the data?",
];

const DEEP_DIVE_EXAMPLES = [
	"Summarize this interview into a shareable article",
	"Pull out the most impactful quotes from this session",
	"What were the key moments in this conversation?",
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
	const isOverview = mode === "overview";

	return (
		<UnstyledButton
			onClick={() => onSelectMode(mode)}
			disabled={isLoading}
			className={`w-full transition-all duration-200 ${isLoading && !isSelected ? "opacity-50" : ""}`}
		>
			<Box
				className={`
					relative overflow-hidden rounded-2xl border-2 p-6
					transition-all duration-200 ease-out
					hover:scale-[1.01]
					${
						isSelected
							? isOverview
								? "border-amber-500 bg-amber-500/10 shadow-[0_8px_24px_rgba(245,158,11,0.15)]"
								: "border-purple-500 bg-purple-500/10 shadow-[0_8px_24px_rgba(168,85,247,0.15)]"
							: isOverview
								? "border-gray-200 bg-neutral-50 hover:border-amber-500 hover:bg-amber-500/10 hover:shadow-[0_8px_24px_rgba(245,158,11,0.15)]"
								: "border-gray-200 bg-neutral-50 hover:border-purple-500 hover:bg-purple-500/10 hover:shadow-[0_8px_24px_rgba(168,85,247,0.15)]"
					}
				`}
			>
				<Stack gap="lg">
					{/* Header */}
					<Group justify="space-between" align="flex-start">
						<Group gap="md">
							<Box
								className="flex items-center justify-center rounded-xl"
								style={{
									backgroundColor: colors.lighter,
									padding: 14,
								}}
							>
								{isThisLoading ? (
									<Loader size={28} color={colors.primary} />
								) : (
									<Icon size={28} stroke={1.8} color={colors.primary} />
								)}
							</Box>
							<Stack gap={4}>
								<Group gap="sm">
									<Text fw={600} size="lg" c={MODE_COLORS.graphite}>
										{title}
									</Text>
									{isBeta && (
										<Badge
											size="sm"
											color={colors.badge}
											variant="light"
											radius="sm"
											tt="uppercase"
											style={{ fontSize: 10 }}
										>
											Beta
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
								<Text size="sm" c="gray.7" lh={1.5}>
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
					<Title order={2} ta="center" c={MODE_COLORS.graphite} fw={600}>
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
						title="Specific Details"
						subtitle="Select conversations and find exact quotes"
						examples={DEEP_DIVE_EXAMPLES}
						icon={IconMessageCircle}
						selectedMode={selectedMode}
						isLoading={isLoading}
						onSelectMode={handleSelectMode}
					/>

					<ModeCard
						mode="overview"
						title="Big Picture"
						subtitle="Explore themes & patterns across all conversations"
						examples={OVERVIEW_EXAMPLES}
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

