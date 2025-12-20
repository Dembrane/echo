import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconBulb,
	IconDots,
	IconList,
	IconQuote,
	IconSearch,
	IconSparkles,
} from "@tabler/icons-react";
import type { ChatMode } from "@/lib/api";
import { MODE_COLORS } from "./ChatModeSelector";
import { TemplatesModal } from "./TemplatesModal";
import { quickAccessTemplates, Templates } from "./templates";

// Map icon names from API to Tabler icons
const SUGGESTION_ICONS: Record<string, typeof IconSparkles> = {
	lightbulb: IconBulb,
	list: IconList,
	quote: IconQuote,
	search: IconSearch,
	sparkles: IconSparkles,
};

type ChatTemplatesMenuProps = {
	onTemplateSelect: ({
		content,
		key,
	}: {
		content: string;
		key: string;
	}) => void;
	selectedTemplateKey?: string | null;
	suggestions?: TSuggestion[];
	chatMode?: ChatMode | null;
};

// Suggestion pill component with subtle styling and colored icon
const SuggestionPill = ({
	suggestion,
	chatMode,
	isSelected,
	onClick,
}: {
	suggestion: TSuggestion;
	chatMode?: ChatMode | null;
	isSelected: boolean;
	onClick: () => void;
}) => {
	const Icon = SUGGESTION_ICONS[suggestion.icon] || IconSparkles;
	const colors = chatMode ? MODE_COLORS[chatMode] : null;

	const isOverview = chatMode === "overview";
	const isDeepDive = chatMode === "deep_dive";

	return (
		<Paper
			withBorder
			className={`cursor-pointer rounded-full px-3 py-1 transition-all hover:scale-[1.02] ${
				isSelected ? "border-gray-400" : "hover:border-gray-300"
			}`}
			style={{
				backgroundColor: "var(--app-background)",
				borderColor: isOverview
					? MODE_COLORS.overview.primary
					: isDeepDive
						? MODE_COLORS.deep_dive.primary
						: undefined,
				borderWidth: isOverview || isDeepDive ? 1 : undefined,
			}}
			onClick={onClick}
		>
			<Group gap={6} wrap="nowrap">
				<Icon size={14} stroke={1.8} color="#2D2D2C" />
				<Text size="sm" fw={500} c={colors ? MODE_COLORS.graphite : undefined}>
					{suggestion.label}
				</Text>
			</Group>
		</Paper>
	);
};

export const ChatTemplatesMenu = ({
	onTemplateSelect,
	selectedTemplateKey,
	suggestions = [],
	chatMode,
}: ChatTemplatesMenuProps) => {
	const [opened, { open, close }] = useDisclosure(false);
	const [animateRef] = useAutoAnimate();

	// Check if selected template is from modal (not in quick access)
	const isModalTemplateSelected =
		selectedTemplateKey &&
		!quickAccessTemplates.some((t) => t.title === selectedTemplateKey) &&
		!suggestions.some((s) => s.label === selectedTemplateKey);

	const selectedModalTemplate = isModalTemplateSelected
		? Templates.find((t) => t.title === selectedTemplateKey)
		: null;

	return (
		<>
			<Stack gap="xs">
				{/* Single "Suggested" row with AI suggestions (colored) + static templates (gray) */}
				<Group gap="xs" ref={animateRef}>
					<Text size="sm" c="gray.6" fw={500}>
						<Trans>Suggested:</Trans>
					</Text>

					{/* AI Suggestions - colored based on mode, animated in/out */}
					{suggestions.map((suggestion, idx) => (
						<SuggestionPill
							key={`suggestion-${idx}-${suggestion.label}`}
							suggestion={suggestion}
							chatMode={chatMode}
							isSelected={selectedTemplateKey === suggestion.label}
							onClick={() =>
								onTemplateSelect({
									content: suggestion.prompt,
									key: suggestion.label,
								})
							}
						/>
					))}

					{/* Static Templates - gray (fill remaining slots up to 5 total) */}
					{quickAccessTemplates
						.slice(0, Math.max(0, 5 - suggestions.length))
						.map((template) => {
							const isSelected = selectedTemplateKey === template.title;
							return (
								<Paper
									key={template.title}
									withBorder
									className={`cursor-pointer rounded-full px-3 py-1 transition-all ${
										isSelected
											? "border-gray-400 bg-gray-100"
											: "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
									}`}
									onClick={() =>
										onTemplateSelect({
											content: template.content,
											key: template.title,
										})
									}
								>
									<Text size="sm" c="gray.7">
										{template.title}
									</Text>
								</Paper>
							);
						})}

					{/* Show selected modal template */}
					{selectedModalTemplate && (
						<Paper
							withBorder
							className="cursor-pointer rounded-full border-gray-400 bg-gray-100 px-3 py-1"
							onClick={() =>
								onTemplateSelect({
									content: selectedModalTemplate.content,
									key: selectedModalTemplate.title,
								})
							}
						>
							<Text size="sm" c="gray.7">
								{selectedModalTemplate.title}
							</Text>
						</Paper>
					)}

					<Tooltip label={t`More templates`}>
						<ActionIcon
							variant="default"
							size="md"
							radius="xl"
							onClick={open}
							className="border-gray-200"
						>
							<IconDots size={18} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Stack>
			<TemplatesModal
				opened={opened}
				onClose={close}
				onTemplateSelect={onTemplateSelect}
				selectedTemplateKey={selectedTemplateKey}
			/>
		</>
	);
};
