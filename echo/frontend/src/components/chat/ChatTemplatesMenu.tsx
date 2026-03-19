import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	GearSix,
	Lightbulb,
	List,
	MagnifyingGlass,
	Quotes,
	Sparkle,
	type Icon,
} from "@phosphor-icons/react";
import { useEffect, useMemo } from "react";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import type { ChatMode } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { MODE_COLORS } from "./ChatModeSelector";
import type { QuickAccessItem } from "./QuickAccessConfigurator";
import { TemplatesModal } from "./TemplatesModal";
import {
	agenticQuickAccessTemplates,
	quickAccessTemplates,
	Templates,
} from "./templates";

// Map icon names from API to Phosphor icons
const SUGGESTION_ICONS: Record<string, Icon> = {
	lightbulb: Lightbulb,
	list: List,
	quote: Quotes,
	search: MagnifyingGlass,
	sparkles: Sparkle,
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
	// User templates
	userTemplates?: Array<{
		id: string;
		title: string;
		content: string;
		icon: string | null;
	}>;
	onCreateUserTemplate?: (payload: {
		title: string;
		content: string;
	}) => void;
	onUpdateUserTemplate?: (payload: {
		id: string;
		title: string;
		content: string;
	}) => void;
	onDeleteUserTemplate?: (id: string) => void;
	isCreatingTemplate?: boolean;
	isUpdatingTemplate?: boolean;
	isDeletingTemplate?: boolean;
	// Quick access
	quickAccessItems?: QuickAccessItem[];
	onSaveQuickAccess?: (items: QuickAccessItem[]) => void;
	isSavingQuickAccess?: boolean;
	// AI suggestions toggle
	hideAiSuggestions?: boolean;
	onToggleAiSuggestions?: (hide: boolean) => void;
	// Favorites
	favoriteTemplateIds?: Set<string>;
	onToggleFavorite?: (promptTemplateId: string, isFavorited: boolean) => void;
	// External open control
	externalOpen?: boolean;
	onExternalClose?: () => void;
	// Save as template prefill
	saveAsTemplateContent?: string | null;
	onClearSaveAsTemplate?: () => void;
	// Community publish context
	userTemplateDetails?: Array<{
		id: string;
		is_public: boolean;
		star_count: number;
		copied_from: string | null;
		author_display_name: string | null;
	}>;
	defaultLanguage?: string;
	userName?: string | null;
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
	const Icon = SUGGESTION_ICONS[suggestion.icon] || Sparkle;
	const colors = chatMode ? MODE_COLORS[chatMode] : null;

	const isOverview = chatMode === "overview";
	const isDeepDive = chatMode === "deep_dive";

	return (
		<Paper
			withBorder
			className={`cursor-pointer rounded-full px-2 py-0.5 transition-all hover:scale-[1.02] ${
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
			{...testId(
				`chat-template-suggestion-${suggestion.label.toLowerCase().replace(/\s+/g, "-")}`,
			)}
		>
			<Group gap={4} wrap="nowrap">
				<Icon size={12} color="var(--app-text)" />
				<Text size="xs" fw={500} c={colors ? MODE_COLORS.graphite : undefined}>
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
	userTemplates = [],
	onCreateUserTemplate,
	onUpdateUserTemplate,
	onDeleteUserTemplate,
	isCreatingTemplate = false,
	isUpdatingTemplate = false,
	isDeletingTemplate = false,
	quickAccessItems = [],
	onSaveQuickAccess,
	isSavingQuickAccess = false,
	hideAiSuggestions = false,
	onToggleAiSuggestions,
	favoriteTemplateIds = new Set(),
	onToggleFavorite,
	externalOpen = false,
	onExternalClose,
	userTemplateDetails = [],
	defaultLanguage,
	userName,
	saveAsTemplateContent,
	onClearSaveAsTemplate,
}: ChatTemplatesMenuProps) => {
	const [opened, { open, close }] = useDisclosure(false);

	// Handle external open
	useEffect(() => {
		if (externalOpen) {
			open();
		}
	}, [externalOpen, open]);

	const handleClose = () => {
		close();
		onExternalClose?.();
	};

	// Resolve quick-access templates from quickAccessItems (already resolved by parent)
	const resolvedQuickAccessTemplates = useMemo(() => {
		if (chatMode === "agentic") return agenticQuickAccessTemplates;

		if (quickAccessItems.length === 0) {
			return quickAccessTemplates;
		}

		const resolved: Array<{ title: string; content: string; key: string }> = [];
		for (const item of quickAccessItems) {
			if (item.type === "static") {
				const found = Templates.find((t) => t.id === item.id);
				if (found) {
					resolved.push({
						title: found.title,
						content: found.content,
						key: found.title,
					});
				}
			} else if (item.type === "user") {
				const found = userTemplates.find((t) => t.id === item.id);
				if (found) {
					resolved.push({
						title: found.title,
						content: found.content,
						key: `user:${found.id}`,
					});
				}
			}
		}
		return resolved.length > 0 ? resolved : quickAccessTemplates;
	}, [chatMode, quickAccessItems, userTemplates]);

	const handleTemplateSelect = (
		template: { content: string; key: string },
		isDynamic = false,
	) => {
		if (isDynamic) {
			try {
				analytics.trackEvent(events.DYNAMIC_TEMPLATE_USED);
			} catch (error) {
				console.warn("Analytics tracking failed:", error);
			}
		}
		onTemplateSelect(template);
	};

	// Check if selected template is from modal (not in quick access)
	const isModalTemplateSelected =
		selectedTemplateKey &&
		!resolvedQuickAccessTemplates.some(
			(t) =>
				("key" in t ? t.key : t.title) === selectedTemplateKey,
		) &&
		!suggestions.some((s) => s.label === selectedTemplateKey);

	const selectedModalTemplate = isModalTemplateSelected
		? Templates.find((t) => t.title === selectedTemplateKey) ||
			userTemplates.find(
				(t) => `user:${t.id}` === selectedTemplateKey,
			)
		: null;

	return (
		<>
			<Stack gap={4} {...testId("chat-templates-menu")}>
				{/* Contextual suggestions row (top) */}
				{suggestions.length > 0 && (
					<Group gap="xs">
						<Text size="xs" c="gray.5" fw={500}>
							<Trans>Suggested:</Trans>
						</Text>

						{suggestions.map((suggestion) => (
							<SuggestionPill
								key={suggestion.label}
								suggestion={suggestion}
								chatMode={chatMode}
								isSelected={selectedTemplateKey === suggestion.label}
								onClick={() =>
									handleTemplateSelect(
										{
											content: suggestion.prompt,
											key: suggestion.label,
										},
										true,
									)
								}
							/>
						))}
					</Group>
				)}

				{/* Quick access row (bottom) */}
				<Group gap="xs">
					<Text size="xs" c="gray.5" fw={500}>
						<Trans>Quick access:</Trans>
					</Text>

					{resolvedQuickAccessTemplates
						.slice(0, 4)
						.map((template) => {
							const templateKey =
								"key" in template ? template.key : template.title;
							const isSelected =
								selectedTemplateKey === templateKey;
							return (
								<Paper
									key={templateKey}
									withBorder
									className={`cursor-pointer rounded-full px-2 py-0.5 transition-all ${
										isSelected
											? "border-gray-400 bg-gray-100"
											: "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
									}`}
									onClick={() =>
										handleTemplateSelect({
											content: template.content,
											key: templateKey,
										})
									}
									{...testId(
										`chat-template-static-${templateKey.toLowerCase().replace(/\s+/g, "-")}`,
									)}
								>
									<Text size="xs" c="gray.7">
										{template.title}
									</Text>
								</Paper>
							);
						})}

					{/* Show selected modal template */}
					{selectedModalTemplate && (
						<Paper
							withBorder
							className="cursor-pointer rounded-full border-gray-400 bg-gray-100 px-2 py-0.5"
							onClick={() =>
								handleTemplateSelect({
									content: selectedModalTemplate.content,
									key:
										"id" in selectedModalTemplate &&
										typeof selectedModalTemplate.id ===
											"string" &&
										selectedModalTemplate.id.length > 10
											? `user:${selectedModalTemplate.id}`
											: selectedModalTemplate.title,
								})
							}
						>
							<Text size="xs" c="gray.7">
								{selectedModalTemplate.title}
							</Text>
						</Paper>
					)}

					{/* Overflow pill */}
					{resolvedQuickAccessTemplates.length > 4 && (
						<Paper
							withBorder
							className="cursor-pointer rounded-full border-gray-200 px-2 py-0.5 hover:border-gray-300 hover:bg-gray-50"
							onClick={open}
							{...testId("chat-templates-overflow-pill")}
						>
							<Text size="xs" c="gray.7">
								+{resolvedQuickAccessTemplates.length - 4}{" "}
								<Trans>more</Trans>
							</Text>
						</Paper>
					)}

					<Tooltip label={t`Manage templates`}>
						<ActionIcon
							variant="subtle"
							size="sm"
							color="gray"
							onClick={open}
							{...testId("chat-templates-more-button")}
						>
							<GearSix size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Stack>
			<TemplatesModal
				opened={opened}
				onClose={handleClose}
				onTemplateSelect={onTemplateSelect}
				selectedTemplateKey={selectedTemplateKey}
				userTemplates={userTemplates}
				onCreateUserTemplate={onCreateUserTemplate}
				onUpdateUserTemplate={onUpdateUserTemplate}
				onDeleteUserTemplate={onDeleteUserTemplate}
				isCreating={isCreatingTemplate}
				isUpdating={isUpdatingTemplate}
				isDeleting={isDeletingTemplate}
				quickAccessItems={quickAccessItems}
				onSaveQuickAccess={onSaveQuickAccess}
				isSavingQuickAccess={isSavingQuickAccess}
				hideAiSuggestions={hideAiSuggestions}
				onToggleAiSuggestions={onToggleAiSuggestions}
				favoriteTemplateIds={favoriteTemplateIds}
				onToggleFavorite={onToggleFavorite}
				userTemplateDetails={userTemplateDetails}
				defaultLanguage={defaultLanguage}
				userName={userName}
				saveAsTemplateContent={saveAsTemplateContent}
				onClearSaveAsTemplate={onClearSaveAsTemplate}
			/>
		</>
	);
};
