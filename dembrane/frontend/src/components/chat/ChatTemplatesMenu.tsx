import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Group,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
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
import posthog from "posthog-js";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ChatMode } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { TemplatesModal } from "./TemplatesModal";
import {
	decodeTemplateKey,
	encodeTemplateKey,
	type QuickAccessItem,
} from "./templateKey";
import {
	agenticDefaultTemplates,
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
		scope?: "user" | "workspace";
		can_edit?: boolean;
	}>;
	onCreateUserTemplate?: (payload: {
		title: string;
		content: string;
		scope?: "user" | "workspace";
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
	// Passed through to the TemplatesModal create form. True when the
	// caller has a workspace and membership lets them share templates.
	canCreateWorkspaceTemplate?: boolean;
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
	testIdSuffix,
}: {
	label: string;
	icon?: Icon;
	isSelected: boolean;
	onClick: () => void;
	testIdSuffix: string;
}) => {
	return (
		<Tooltip label={label} openDelay={500} disabled={label.length < 25}>
			<UnstyledButton
				className="app-do"
				data-selected={isSelected || undefined}
				px={8}
				py={4}
				style={{ maxWidth: 200 }}
				onClick={onClick}
				{...testId(`chat-template-${testIdSuffix}`)}
			>
				<Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
					{IconComponent && (
						<IconComponent size={16} style={{ flexShrink: 0 }} />
					)}
					<Text size="xs" truncate style={{ minWidth: 0 }}>
						{label}
					</Text>
				</Group>
			</UnstyledButton>
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
	canCreateWorkspaceTemplate = false,
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

	const { i18n } = useLingui();
	// Resolve quick-access templates from quickAccessItems (already resolved by parent)
	const resolvedQuickAccessTemplates = useMemo(() => {
		const isAgentic = chatMode === "agentic";
		const defaultTemplates = isAgentic
			? agenticDefaultTemplates(i18n.locale)
			: quickAccessTemplates;
		if (quickAccessItems.length === 0) {
			return defaultTemplates;
		}

		const resolved: Array<{ title: string; content: string; key: string }> = [];
		const allStatics = [...Templates, ...agenticQuickAccessTemplates];
		for (const item of quickAccessItems) {
			if (item.type === "static") {
				const found = allStatics.find((t) => t.id === item.id);
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
		return resolved.length > 0 ? resolved : defaultTemplates;
	}, [quickAccessItems, userTemplates, chatMode, i18n.locale]);

	const handleTemplateSelect = (
		template: { content: string; key: string },
		isDynamic = false,
	) => {
		if (isDynamic) {
			posthog.capture("chat_template_used", { template_key: template.key });
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

	// How many chits sit below the first line (hidden), and the line's height.
	const listRef = useRef<HTMLDivElement | null>(null);
	// A stable ref: auto-animate's ref sets state, so a new callback each render
	// would loop.
	const setListRef = useCallback(
		(node: HTMLDivElement | null) => {
			listRef.current = node;
			animateRef(node);
		},
		[animateRef],
	);
	const [hiddenCount, setHiddenCount] = useState(0);
	const [rowHeight, setRowHeight] = useState<number | undefined>(undefined);
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const measure = () => {
			const items = Array.from(
				list.querySelectorAll<HTMLElement>(":scope > [data-chit]"),
			);
			if (items.length === 0) {
				setHiddenCount(0);
				return;
			}
			const top = items[0].offsetTop;
			setRowHeight(items[0].offsetHeight);
			// Hidden: wrapped below the line, or cut off at its end.
			setHiddenCount(
				items.filter(
					(el) =>
						el.offsetTop > top + 1 ||
						el.offsetLeft + el.offsetWidth > list.clientWidth + 1,
				).length,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		if (list.parentElement) observer.observe(list.parentElement);
		return () => observer.disconnect();
	});

	// Slot allocation: max 7 pills total (including "+N more" overflow pill)
	const MAX_PILLS = 7;
	const MAX_SUGGESTIONS = 3;
	const visibleSuggestions = hideAiSuggestions
		? []
		: suggestions.slice(0, MAX_SUGGESTIONS);
	const slotsForPinned = MAX_PILLS - visibleSuggestions.length;
	const pinnedCount = resolvedQuickAccessTemplates.length;
	// If all pinned fit, show them all. Otherwise reserve 1 slot for "+N more".
	const pinnedSlots =
		pinnedCount <= slotsForPinned ? pinnedCount : slotsForPinned - 1;
	const visiblePinned = resolvedQuickAccessTemplates.slice(
		0,
		Math.max(0, pinnedSlots),
	);
	const pinnedOverflow = pinnedCount - visiblePinned.length;

	// Every chit the row could show, in order. The row never wraps (rule 04:
	// narrow widths drop words): chits that don't fit on the one line are
	// hidden and counted into "+N more", and the settings gear always shows.
	const chits: { key: string; node: ReactNode }[] = [
		...visibleSuggestions.map((suggestion) => ({
			key: `suggestion-${suggestion.label}`,
			node: (
				<TemplatePill
					label={suggestion.label}
					icon={SUGGESTION_ICONS[suggestion.icon] || Sparkle}
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
			),
		})),
		...visiblePinned.map((template) => {
			const templateKey = "key" in template ? template.key : template.title;
			return {
				key: `pinned-${templateKey}`,
				node: (
					<TemplatePill
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
				),
			};
		}),
		...(selectedModalTemplate
			? [
					{
						key: `modal-${selectedModalTemplate.title}`,
						node: (
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
												: encodeTemplateKey(
														"dembrane",
														selectedModalTemplate.title,
													),
									})
								}
								testIdSuffix={`modal-${selectedModalTemplate.title.toLowerCase().replace(/\s+/g, "-")}`}
							/>
						),
					},
				]
			: []),
	];
	const overflowCount = pinnedOverflow + hiddenCount;

	return (
		<>
			<Group
				gap="xs"
				wrap="nowrap"
				align="center"
				style={{ minWidth: 0 }}
				{...testId("chat-templates-menu")}
			>
				{visibleSuggestions.length > 0 && (
					<Text
						size="xs"
						c="dimmed"
						style={{ flex: "none", whiteSpace: "nowrap" }}
					>
						<Trans>Suggested:</Trans>
					</Text>
				)}
				<div
					ref={setListRef}
					style={{
						display: "flex",
						flex: "0 1 auto",
						flexWrap: "wrap",
						gap: 8,
						height: rowHeight,
						minWidth: 0,
						overflow: "hidden",
						// offsetLeft of the chits is measured from here.
						position: "relative",
					}}
				>
					{chits.map((chit, i) => {
						const hidden = i >= chits.length - hiddenCount;
						return (
							<div
								key={chit.key}
								data-chit
								aria-hidden={hidden || undefined}
								style={hidden ? { visibility: "hidden" } : undefined}
							>
								{chit.node}
							</div>
						);
					})}
				</div>

				{overflowCount > 0 && (
					<UnstyledButton
						className="app-do"
						px={8}
						py={4}
						style={{ flex: "none", whiteSpace: "nowrap" }}
						onClick={open}
						{...testId("chat-templates-overflow-pill")}
					>
						<Text size="xs">
							+{overflowCount} <Trans>more</Trans>
						</Text>
					</UnstyledButton>
				)}

				<Tooltip label={t`Manage templates`}>
					<ActionIcon
						variant="subtle"
						color="gray"
						onClick={open}
						style={{ flex: "none" }}
						{...testId("chat-templates-more-button")}
					>
						<GearSix size={20} />
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
				canCreateWorkspaceTemplate={canCreateWorkspaceTemplate}
			/>
		</>
	);
};
