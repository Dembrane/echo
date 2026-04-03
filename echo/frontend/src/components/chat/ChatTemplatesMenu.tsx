import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Group, Paper, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	GearSix,
	type Icon,
	Lightbulb,
	List,
	MagnifyingGlass,
	Quotes,
	Sparkle,
} from "@phosphor-icons/react";
import { useEffect, useMemo } from "react";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import type { ChatMode } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { MODE_COLORS } from "./ChatModeSelector";
import type { QuickAccessItem } from "./QuickAccessConfigurator";
import { TemplatesModal } from "./TemplatesModal";
import { decodeTemplateKey, encodeTemplateKey } from "./templateKey";
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
	onCreateUserTemplate?: (payload: { title: string; content: string }) => void;
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
	// External open control
	externalOpen?: boolean;
	onExternalClose?: () => void;
	// Save as template prefill
	saveAsTemplateContent?: string | null;
	onClearSaveAsTemplate?: () => void;
};

// Reusable chip for both dynamic suggestions and pinned templates
const TemplatePill = ({
	label,
	icon: IconComponent,
	isSelected,
	onClick,
	chatMode,
	testIdSuffix,
}: {
	label: string;
	icon?: Icon;
	isSelected: boolean;
	onClick: () => void;
	chatMode?: ChatMode | null;
	testIdSuffix: string;
}) => {
	const colors = chatMode ? MODE_COLORS[chatMode] : null;
	const isOverview = chatMode === "overview";
	const isDeepDive = chatMode === "deep_dive";

	return (
		<Tooltip label={label} openDelay={500} disabled={label.length < 25}>
			<Paper
				withBorder
				className={`cursor-pointer whitespace-nowrap truncate rounded-xl px-2 py-1 transition-all hover:scale-[1.02] ${
					isSelected
						? "border-gray-400 bg-gray-100"
						: "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
				}`}
				style={{
					alignItems: "center",
					backgroundColor: isSelected ? undefined : "var(--app-background)",
					borderColor: isOverview
						? MODE_COLORS.overview.primary
						: isDeepDive
							? MODE_COLORS.deep_dive.primary
							: undefined,
					borderWidth: isOverview || isDeepDive ? 1 : undefined,
					display: "flex",
					maxWidth: 160,
				}}
				onClick={onClick}
				{...testId(`chat-template-${testIdSuffix}`)}
			>
				<Group gap={4} wrap="nowrap" align="flex-start">
					{IconComponent && (
						<IconComponent
							size={12}
							color="var(--app-text)"
							style={{ flexShrink: 0, marginTop: 2 }}
						/>
					)}
					<Text
						size="xs"
						fw={500}
						c={colors ? MODE_COLORS.graphite : undefined}
						lineClamp={2}
					>
						{label}
					</Text>
				</Group>
			</Paper>
		</Tooltip>
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
	externalOpen = false,
	onExternalClose,
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
						content: found.content,
						key: encodeTemplateKey("dembrane", found.id),
						title: found.title,
					});
				}
			} else if (item.type === "user") {
				const found = userTemplates.find((t) => t.id === item.id);
				if (found) {
					resolved.push({
						content: found.content,
						key: encodeTemplateKey("user", found.id),
						title: found.title,
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
			(t) => ("key" in t ? t.key : t.title) === selectedTemplateKey,
		) &&
		!suggestions.some((s) => s.label === selectedTemplateKey);

	const selectedModalTemplate = (() => {
		if (!isModalTemplateSelected || !selectedTemplateKey) return null;
		const ref = decodeTemplateKey(selectedTemplateKey);
		if (!ref) return null;
		if (ref.source === "dembrane")
			return Templates.find((t) => t.id === ref.id) ?? null;
		if (ref.source === "user")
			return userTemplates.find((t) => t.id === ref.id) ?? null;
		return null;
	})();

	const [animateRef] = useAutoAnimate();

	// Slot allocation: max 7 pills total (including "+N more" overflow pill)
	const MAX_PILLS = 7;
	const MAX_SUGGESTIONS = 3;
	const visibleSuggestions = hideAiSuggestions
		? []
		: suggestions.slice(0, MAX_SUGGESTIONS);
	const slotsForPinned = MAX_PILLS - visibleSuggestions.length;
	const pinnedCount = resolvedQuickAccessTemplates.length;
	// If all pinned fit, show them all. Otherwise reserve 1 slot for "+N more".
	const pinnedSlots = pinnedCount <= slotsForPinned
		? pinnedCount
		: slotsForPinned - 1;
	const visiblePinned = resolvedQuickAccessTemplates.slice(0, Math.max(0, pinnedSlots));
	const pinnedOverflow = pinnedCount - visiblePinned.length;

	return (
		<>
			<Group
				gap="xs"
				ref={animateRef}
				wrap="wrap"
				{...testId("chat-templates-menu")}
			>
				{/* Contextual suggestions */}
				{visibleSuggestions.length > 0 && (
					<Text size="xs" c="gray.5" fw={500} style={{ whiteSpace: "nowrap" }}>
						<Trans>Suggested:</Trans>
					</Text>
				)}
				{visibleSuggestions.map((suggestion) => (
					<TemplatePill
						key={suggestion.label}
						label={suggestion.label}
						icon={SUGGESTION_ICONS[suggestion.icon] || Sparkle}
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
						testIdSuffix={`suggestion-${suggestion.label.toLowerCase().replace(/\s+/g, "-")}`}
					/>
				))}

				{/* Pinned templates */}
				{visiblePinned.map((template) => {
					const templateKey = "key" in template ? template.key : template.title;
					return (
						<TemplatePill
							key={templateKey}
							label={template.title}
							isSelected={selectedTemplateKey === templateKey}
							onClick={() =>
								handleTemplateSelect({
									content: template.content,
									key: templateKey,
								})
							}
							testIdSuffix={`static-${templateKey.toLowerCase().replace(/\s+/g, "-")}`}
						/>
					);
				})}

				{/* Show selected modal template (not in quick access) */}
				{selectedModalTemplate && (
					<TemplatePill
						label={selectedModalTemplate.title}
						isSelected
						onClick={() =>
							handleTemplateSelect({
								content: selectedModalTemplate.content,
								key:
									"id" in selectedModalTemplate &&
									typeof selectedModalTemplate.id === "string" &&
									selectedModalTemplate.id.length > 10
										? encodeTemplateKey("user", selectedModalTemplate.id)
										: encodeTemplateKey("dembrane", selectedModalTemplate.title),
							})
						}
						testIdSuffix={`modal-${selectedModalTemplate.title.toLowerCase().replace(/\s+/g, "-")}`}
					/>
				)}

				{/* Overflow pill */}
				{pinnedOverflow > 0 && (
					<Paper
						withBorder
						className="cursor-pointer rounded-full border-gray-200 px-2 py-0.5 hover:border-gray-300 hover:bg-gray-50"
						onClick={open}
						{...testId("chat-templates-overflow-pill")}
					>
						<Text size="xs" c="gray.7">
							+{pinnedOverflow} <Trans>more</Trans>
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
				saveAsTemplateContent={saveAsTemplateContent}
				onClearSaveAsTemplate={onClearSaveAsTemplate}
			/>
		</>
	);
};
