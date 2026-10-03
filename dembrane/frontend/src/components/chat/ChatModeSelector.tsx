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
	ChatCircleIcon,
	LockIcon,
	QuotesIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useState } from "react";
import { ENABLE_AGENTIC_CHAT } from "@/config";
import type { ChatMode } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { useInitializeChatModeMutation } from "./hooks";

// Mode colours, shared across chat components. The neon is for the small
// mark only (an icon or a loader), never a border, shadow, disc or tint.
export const MODE_COLORS = {
	// Brand Spring Green.
	agentic: {
		badge: "springGreen",
		primary: "#1EFFA1",
	},
	deep_dive: {
		badge: "cyan",
		primary: "#00FFFF",
	},
	// Use CSS variable for theme-aware text color
	graphite: "var(--app-text)",
	overview: {
		badge: "teal",
		primary: "#1EFFA1",
	},
};

// Sample questions for each mode - wrapped in function to enable translation
const getDeepDiveExamples = () => [
	t`Summarize this interview into a shareable article`,
	t`Pull out the most impactful quotes from this session`,
	t`What were the key moments in this conversation?`,
];

const getAgenticExamples = () => [
	t`Create a research brief from recent conversations`,
	t`Find contradictions and suggest follow-up questions`,
	t`Draft next actions and organize them by priority`,
];

type ModeCardProps = {
	mode: ChatMode;
	title: string;
	subtitle: string;
	examples: string[];
	icon: typeof SparkleIcon;
	isBeta?: boolean;
	atLimit?: boolean;
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
	atLimit = false,
	selectedMode,
	isLoading,
	onSelectMode,
}: ModeCardProps) => {
	const isSelected = selectedMode === mode;
	const isThisLoading = isLoading && isSelected;

	return (
		<UnstyledButton
			onClick={() => onSelectMode(mode)}
			disabled={isLoading}
			p="lg"
			data-selected={isSelected || undefined}
			className={`app-do w-full ${isLoading && !isSelected ? "opacity-50" : ""}`}
			{...testId(`chat-mode-card-${mode}`)}
		>
			<Stack gap="lg">
				{/* Header */}
				<Group gap="md" align="flex-start" wrap="nowrap">
					{isThisLoading ? <Loader size="sm" /> : <Icon size={20} />}
					<Stack gap="xs">
						<Group gap="sm">
							<Text size="lg">{title}</Text>
							{isBeta && (
								<Badge size="sm" color="mauve" c="graphite">
									<Trans>Beta</Trans>
								</Badge>
							)}
							{atLimit && (
								<Badge
									size="sm"
									color="gray"
									leftSection={<LockIcon size={16} />}
								>
									<Trans>Chat limit reached</Trans>
								</Badge>
							)}
						</Group>
						<Text size="sm">{subtitle}</Text>
					</Stack>
				</Group>

				{/* Example questions */}
				<Stack gap="sm">
					<Text size="sm" c="dimmed">
						<Trans>Try asking</Trans>
					</Text>
					{examples.map((example) => (
						<Group key={example} gap="sm" wrap="nowrap" align="flex-start">
							<QuotesIcon size={16} style={{ flexShrink: 0 }} />
							<Text size="sm" lh={1.5}>
								{example}
							</Text>
						</Group>
					))}
				</Stack>
			</Stack>
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
	atChatLimit?: boolean;
};

export const ChatModeSelector = ({
	chatId,
	projectId,
	onModeSelected,
	isNewChat = false,
	isCreating = false,
	atChatLimit = false,
}: ChatModeSelectorProps) => {
	const [selectedMode, setSelectedMode] = useState<ChatMode | null>(null);
	const initializeModeMutation = useInitializeChatModeMutation();

	const handleSelectMode = async (mode: ChatMode) => {
		setSelectedMode(mode);

		// Single capture point for every entry (new chat + existing chat).
		posthog.capture("chat_mode_selected", {
			chat_id: chatId,
			is_new_chat: isNewChat,
			mode,
			project_id: projectId,
		});

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
		<Box className="mx-auto w-full py-8" {...testId("chat-mode-selector")}>
			<Stack gap="xl">
				{/* Header */}
				<Stack gap="xs">
					<Title order={2} {...testId("chat-mode-selector-title")}>
						<Trans>What would you like to explore?</Trans>
					</Title>
					<Text size="md">
						<Trans>Pick the approach that fits your question</Trans>
					</Text>
				</Stack>

				{/* Mode Cards. Overview is no longer startable: chats that already
				    have chat_mode="overview" keep working, but nothing creates a
				    new one. */}
				<Stack gap="lg">
					{ENABLE_AGENTIC_CHAT && (
						<ModeCard
							mode="agentic"
							title={t`Agentic`}
							subtitle={t`Delegate multi-step analysis with live tool execution`}
							examples={getAgenticExamples()}
							icon={SparkleIcon}
							isBeta
							atLimit={atChatLimit}
							selectedMode={selectedMode}
							isLoading={isLoading}
							onSelectMode={handleSelectMode}
						/>
					)}

					<ModeCard
						mode="deep_dive"
						title={t`Specific Details`}
						subtitle={t`Select conversations and find exact quotes`}
						examples={getDeepDiveExamples()}
						icon={ChatCircleIcon}
						atLimit={atChatLimit}
						selectedMode={selectedMode}
						isLoading={isLoading}
						onSelectMode={handleSelectMode}
					/>
				</Stack>
			</Stack>
		</Box>
	);
};
