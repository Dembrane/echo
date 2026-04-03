import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Divider,
	Group,
	Modal,
	Paper,
	ScrollArea,
	Skeleton,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
	ArrowLeft,
	Copy,
	DotsSixVertical,
	Globe,
	MagnifyingGlass,
	PencilSimple,
	Plus,
	Trash,
	X,
} from "@phosphor-icons/react";
import { IconPin, IconPinFilled } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import {
	type QuickAccessItem,
	encodeTemplateKey,
	keyToQuickAccess,
	quickAccessToKey,
} from "./templateKey";
import { type Template, Templates } from "./templates";

// ── Types ──

type ModalView = "browse" | "create" | "edit";

type TemplatesModalProps = {
	opened: boolean;
	onClose: () => void;
	onTemplateSelect: (template: { content: string; key: string }) => void;
	selectedTemplateKey?: string | null;
	userTemplates?: Array<{
		id: string;
		title: string;
		content: string;
		icon: string | null;
	}>;
	onCreateUserTemplate?: (payload: {
		title: string;
		content: string;
	}) => Promise<unknown> | void;
	onUpdateUserTemplate?: (payload: {
		id: string;
		title: string;
		content: string;
	}) => Promise<unknown> | void;
	onDeleteUserTemplate?: (id: string) => Promise<unknown> | void;
	isCreating?: boolean;
	isUpdating?: boolean;
	isDeleting?: boolean;
	quickAccessItems?: QuickAccessItem[];
	onSaveQuickAccess?: (items: QuickAccessItem[]) => void;
	isSavingQuickAccess?: boolean;
	hideAiSuggestions?: boolean;
	onToggleAiSuggestions?: (hide: boolean) => void;
	saveAsTemplateContent?: string | null;
	onClearSaveAsTemplate?: () => void;
};

type UnifiedTemplate = {
	id: string;
	title: string;
	content: string;
	source: "dembrane" | "user";
	key: string;
};

// ── Badge ──

const SourceBadge = ({ source }: { source: "dembrane" }) => (
	<Badge
		size="xs"
		variant="light"
		color="teal"
		styles={{ root: { textTransform: "lowercase" } }}
	>
		{source}
	</Badge>
);

// ── Sortable row for pinned templates ──

const SortableTemplateRow = ({
	sortId,
	children,
}: {
	sortId: string;
	children: (props: {
		dragHandleProps: Record<string, unknown>;
		isDragging: boolean;
		style: React.CSSProperties;
		ref: (node: HTMLElement | null) => void;
	}) => React.ReactNode;
}) => {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortId });

	const style: React.CSSProperties = {
		opacity: isDragging ? 0.9 : 1,
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 10 : undefined,
	};

	return (
		<>
			{children({
				dragHandleProps: { ...attributes, ...listeners },
				isDragging,
				ref: setNodeRef,
				style,
			})}
		</>
	);
};

// ── Main Component ──

export const TemplatesModal = ({
	opened,
	onClose,
	onTemplateSelect,
	selectedTemplateKey: _selectedTemplateKey,
	userTemplates = [],
	onCreateUserTemplate,
	onUpdateUserTemplate,
	onDeleteUserTemplate,
	isCreating = false,
	isUpdating = false,
	isDeleting = false,
	quickAccessItems = [],
	onSaveQuickAccess,
	isSavingQuickAccess: _isSavingQuickAccess = false,
	hideAiSuggestions = false,
	onToggleAiSuggestions,
	saveAsTemplateContent,
	onClearSaveAsTemplate,
}: TemplatesModalProps) => {
	const [view, setView] = useState<ModalView>("browse");
	const [searchQuery, setSearchQuery] = useState("");
	const [filterMine, setFilterMine] = useState(false);
	const [animateList, enableAnimations] = useAutoAnimate();
	const [formTitle, setFormTitle] = useState("");
	const [formContent, setFormContent] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(
		null,
	);

	const [debouncedSearch] = useDebouncedValue(searchQuery, 300);

	// Handle save-as-template prefill
	useEffect(() => {
		if (saveAsTemplateContent && opened) {
			setFormTitle("");
			setFormContent(saveAsTemplateContent);
			setView("create");
			onClearSaveAsTemplate?.();
		}
	}, [saveAsTemplateContent, opened, onClearSaveAsTemplate]);

	// ── Pin helpers (all use canonical key) ──

	const isPinnedKey = (key: string) =>
		quickAccessItems.some(
			(item) => quickAccessToKey(item.type, item.id) === key,
		);

	const addToQuickAccess = (key: string, title: string) => {
		const qa = keyToQuickAccess(key);
		if (!qa || !onSaveQuickAccess || quickAccessItems.length >= 5) return;
		onSaveQuickAccess([
			...quickAccessItems,
			{ id: qa.id, title, type: qa.type },
		]);
	};

	const removeFromQuickAccess = (key: string) => {
		if (!onSaveQuickAccess) return;
		onSaveQuickAccess(
			quickAccessItems.filter(
				(item) => quickAccessToKey(item.type, item.id) !== key,
			),
		);
	};

	// DnD sensors
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor),
	);

	const handleDragStart = () => {
		enableAnimations(false);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		enableAnimations(true);
		const { active, over } = event;
		if (!over || active.id === over.id || !onSaveQuickAccess) return;
		const oldIndex = quickAccessItems.findIndex(
			(qi) => quickAccessToKey(qi.type, qi.id) === active.id,
		);
		const newIndex = quickAccessItems.findIndex(
			(qi) => quickAccessToKey(qi.type, qi.id) === over.id,
		);
		if (oldIndex === -1 || newIndex === -1) return;
		onSaveQuickAccess(arrayMove(quickAccessItems, oldIndex, newIndex));
	};

	// ── Template actions ──

	const handleUseTemplate = (content: string, key: string) => {
		onTemplateSelect({ content, key });
		onClose();
	};

	const handleStartCreate = () => {
		setFormTitle("");
		setFormContent("");
		setView("create");
	};

	const handleDuplicate = (title: string, content: string) => {
		setFormTitle(`${title} (${t`copy`})`);
		setFormContent(content);
		setView("create");
	};

	const handleStartEdit = (template: {
		id: string;
		title: string;
		content: string;
	}) => {
		setEditingId(template.id);
		setFormTitle(template.title);
		setFormContent(template.content);
		setView("edit");
	};

	const handleSaveCreate = async () => {
		if (!formTitle.trim() || !formContent.trim()) return;
		try {
			await onCreateUserTemplate?.({
				content: formContent.trim(),
				title: formTitle.trim(),
			});
			setView("browse");
		} catch {
			// stay on form so user can retry
		}
	};

	const handleSaveEdit = async () => {
		if (!editingId || !formTitle.trim() || !formContent.trim()) return;
		try {
			await onUpdateUserTemplate?.({
				content: formContent.trim(),
				id: editingId,
				title: formTitle.trim(),
			});
			setView("browse");
		} catch {
			// stay on form so user can retry
		}
	};

	const handleBack = () => {
		setView("browse");
		setEditingId(null);
	};

	const resetState = () => {
		setView("browse");
		setSearchQuery("");
		setFilterMine(false);
		setFormTitle("");
		setFormContent("");
		setEditingId(null);
	};

	// ── Merged & sorted template list ──

	const allTemplates = useMemo(() => {
		const items: UnifiedTemplate[] = [];
		for (const tmpl of Templates) {
			items.push({
				content: tmpl.content,
				id: tmpl.id,
				key: encodeTemplateKey("dembrane", tmpl.id),
				source: "dembrane",
				title: tmpl.title,
			});
		}
		for (const tmpl of userTemplates) {
			items.push({
				content: tmpl.content,
				id: tmpl.id,
				key: encodeTemplateKey("user", tmpl.id),
				source: "user",
				title: tmpl.title,
			});
		}
		return items;
	}, [userTemplates]);

	// Sort: pinned first (in quick-access order) → dembrane → user, then alphabetical
	const allSorted = useMemo(() => {
		const sourceOrder = { dembrane: 1, user: 2 };
		const getPinIndex = (key: string) =>
			quickAccessItems.findIndex(
				(item) => quickAccessToKey(item.type, item.id) === key,
			);
		return [...allTemplates].sort((a, b) => {
			const aPinIdx = getPinIndex(a.key);
			const bPinIdx = getPinIndex(b.key);
			const aPinned = aPinIdx >= 0 ? 0 : 1;
			const bPinned = bPinIdx >= 0 ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			// Both pinned: preserve quick-access order
			if (aPinned === 0 && bPinned === 0) return aPinIdx - bPinIdx;
			// Both unpinned: sort by source then alphabetical
			const aSource = sourceOrder[a.source];
			const bSource = sourceOrder[b.source];
			if (aSource !== bSource) return aSource - bSource;
			return a.title.localeCompare(b.title);
		});
	}, [allTemplates, quickAccessItems]);

	// Search filtering
	const displayTemplates = useMemo(() => {
		if (!debouncedSearch) return allSorted;
		const q = debouncedSearch.toLowerCase();
		return allSorted.filter(
			(tmpl) =>
				tmpl.title.toLowerCase().includes(q) ||
				tmpl.content.toLowerCase().includes(q),
		);
	}, [debouncedSearch, allSorted]);

	// ── Modal wrapper ──
	const modalProps = {
		classNames: {
			body: "flex-1 flex flex-col overflow-hidden",
			content: "h-[600px] flex flex-col overflow-hidden",
		},
		onClose,
		onExitTransitionEnd: resetState,
		opened,
		size: "lg" as const,
		title: (
			<Text fw={500} size="lg">
				<Trans>Templates</Trans>
			</Text>
		),
		withinPortal: true,
	};

	// ── Render: Create / Edit view ──

	const deleteConfirmationModal = (
		<Modal
			opened={!!deletingTemplateId}
			onClose={() => setDeletingTemplateId(null)}
			title={t`Delete template`}
			size="sm"
			centered
		>
			<Stack gap="md">
				<Text size="sm">
					<Trans>
						Are you sure you want to delete this template? This cannot be
						undone.
					</Trans>
				</Text>
				<Group justify="flex-end" gap="sm">
					<Button variant="default" onClick={() => setDeletingTemplateId(null)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						color="red"
						loading={isDeleting}
						onClick={() => {
							if (deletingTemplateId) {
								onDeleteUserTemplate?.(deletingTemplateId);
								setDeletingTemplateId(null);
								setView("browse");
							}
						}}
					>
						<Trans>Delete</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);

	if (view === "create" || view === "edit") {
		return (
			<>
				<Modal {...modalProps}>
					<div className="flex h-full flex-col">
						<UnstyledButton onClick={handleBack} className="mb-4">
							<Group gap={4}>
								<ArrowLeft size={16} />
								<Text size="sm" c="dimmed">
									<Trans>Back to templates</Trans>
								</Text>
							</Group>
						</UnstyledButton>
						<Stack gap="md" className="flex-1">
							<TextInput
								label={t`Template name`}
								value={formTitle}
								onChange={(e) => setFormTitle(e.currentTarget.value)}
								placeholder={t`e.g. Weekly stakeholder digest`}
								maxLength={80}
							/>
							<Textarea
								label={t`Prompt`}
								value={formContent}
								onChange={(e) => setFormContent(e.currentTarget.value)}
								placeholder={t`What should ECHO analyse or generate from the conversations?`}
								minRows={6}
								maxRows={14}
								autosize
							/>
							{view === "create" && (
								<Text size="xs" c="dimmed" fs="italic">
									<Trans>
										Tip: You can also create a template from any chat message
										you send, or duplicate an existing template.
									</Trans>
								</Text>
							)}
							<Button
								onClick={view === "create" ? handleSaveCreate : handleSaveEdit}
								loading={view === "create" ? isCreating : isUpdating}
								disabled={!formTitle.trim() || !formContent.trim()}
								fullWidth
							>
								<Trans>Save template</Trans>
							</Button>
							{view === "edit" && editingId && (
								<UnstyledButton
									onClick={() => setDeletingTemplateId(editingId)}
								>
									<Text size="sm" c="red" ta="center">
										<Trans>Delete template</Trans>
									</Text>
								</UnstyledButton>
							)}
						</Stack>
					</div>
				</Modal>
				{deleteConfirmationModal}
			</>
		);
	}

	// Settings view removed — contextual suggestions toggle is now inline above the search bar.

	// ── Render: Browse view (single flat list) ──

	// Split templates into quick access (pinned) and rest
	const quickAccessTemplates = displayTemplates.filter((tmpl) =>
		isPinnedKey(tmpl.key),
	);
	const otherTemplates = displayTemplates.filter(
		(tmpl) => !isPinnedKey(tmpl.key),
	);

	const renderRow = (tmpl: UnifiedTemplate, showDragHandle: boolean) => {
		const rowContent = (
			dragHandleProps?: Record<string, unknown>,
			isDragging?: boolean,
			style?: React.CSSProperties,
			ref?: (node: HTMLElement | null) => void,
		) => (
			<Paper
				ref={ref}
				style={style}
				p="xs"
				withBorder
				className={`cursor-pointer transition-shadow hover:border-gray-300 hover:bg-gray-50 ${isDragging ? "shadow-md" : ""}`}
				onClick={() => handleUseTemplate(tmpl.content, tmpl.key)}
			>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					{showDragHandle && dragHandleProps && (
						<Tooltip label={t`Drag to reorder`} position="left" openDelay={400}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle managed by dnd-kit */}
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: drag handle managed by dnd-kit */}
							<div
								{...dragHandleProps}
								className="flex cursor-grab items-center text-gray-400 hover:text-gray-600 active:cursor-grabbing"
								onClick={(e) => e.stopPropagation()}
							>
								<DotsSixVertical size={14} weight="bold" />
							</div>
						</Tooltip>
					)}
					<Stack gap={1} className="min-w-0 flex-1">
						<Group gap={6}>
							<Text size="sm" fw={500} truncate>
								{tmpl.title}
							</Text>
							{tmpl.source !== "user" && <SourceBadge source={tmpl.source} />}
						</Group>
						<Text size="xs" c="dimmed" lineClamp={2}>
							{tmpl.content}
						</Text>
					</Stack>
					<Group gap={2} wrap="nowrap">
						{tmpl.source === "dembrane" && (
							<Tooltip label={t`Duplicate`}>
								<ActionIcon
									size="xs"
									variant="subtle"
									onClick={(e) => {
										e.stopPropagation();
										handleDuplicate(tmpl.title, tmpl.content);
									}}
								>
									<Copy size={12} />
								</ActionIcon>
							</Tooltip>
						)}
						{tmpl.source === "user" && (
							<>
								<Tooltip label={t`Edit`}>
									<ActionIcon
										size="xs"
										variant="subtle"
										onClick={(e) => {
											e.stopPropagation();
											const ut = userTemplates.find((u) => u.id === tmpl.id);
											if (ut) handleStartEdit(ut);
										}}
									>
										<PencilSimple size={12} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label={t`Delete`}>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="red"
										loading={isDeleting}
										onClick={(e) => {
											e.stopPropagation();
											setDeletingTemplateId(tmpl.id);
										}}
									>
										<Trash size={12} />
									</ActionIcon>
								</Tooltip>
							</>
						)}
						{/* Quick access promote/demote */}
						{onSaveQuickAccess &&
							(showDragHandle ? (
								<Tooltip label={t`Unpin`}>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="gray"
										onClick={(e) => {
											e.stopPropagation();
											removeFromQuickAccess(tmpl.key);
										}}
									>
										<IconPinFilled size={12} />
									</ActionIcon>
								</Tooltip>
							) : (
								<Tooltip
									label={
										quickAccessItems.length >= 5
											? t`Pinned is full (max 5)`
											: t`Pin`
									}
								>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="blue"
										disabled={quickAccessItems.length >= 5}
										onClick={(e) => {
											e.stopPropagation();
											addToQuickAccess(tmpl.key, tmpl.title);
										}}
									>
										<IconPin size={12} />
									</ActionIcon>
								</Tooltip>
							))}
					</Group>
				</Group>
			</Paper>
		);

		if (showDragHandle) {
			return (
				<SortableTemplateRow key={tmpl.key} sortId={tmpl.key}>
					{({ dragHandleProps, isDragging, style, ref }) =>
						rowContent(dragHandleProps, isDragging, style, ref)
					}
				</SortableTemplateRow>
			);
		}

		return <div key={tmpl.key}>{rowContent()}</div>;
	};

	return (
		<>
			<Modal {...modalProps}>
				<div className="flex h-full flex-col">
					<Stack gap={12}>
						{/* Contextual suggestions toggle + subtitle */}
						{onToggleAiSuggestions && (
							<Stack gap={2}>
								<Switch
									label={
										<Text size="xs" fw={500}>
											<Trans>Contextual suggestions</Trans>
										</Text>
									}
									size="xs"
									checked={!hideAiSuggestions}
									onChange={(e) =>
										onToggleAiSuggestions(!e.currentTarget.checked)
									}
								/>
								<Text size="xs" c="dimmed" pl={38}>
									<Trans>
										Suggest dynamic suggestions based on your conversation.
									</Trans>
								</Text>
							</Stack>
						)}

						<Group>
							{/* Search */}
							<TextInput
								placeholder={t`Search templates...`}
								leftSection={<MagnifyingGlass size={16} />}
								className="flex-1"
								size="sm"
								rightSection={
									searchQuery ? (
										<ActionIcon
											size="sm"
											variant="subtle"
											aria-label="Clear search"
											onClick={() => setSearchQuery("")}
										>
											<X size={16} />
										</ActionIcon>
									) : null
								}
								rightSectionPointerEvents="all"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.currentTarget.value)}
							/>

							{/* Create template — primary CTA */}
							<Button
								variant="filled"
								leftSection={<Plus size={16} />}
								onClick={handleStartCreate}
							>
								<Trans>Create template</Trans>
							</Button>
						</Group>
					</Stack>

					<Divider my={12} />

					{/* Template list */}
					<ScrollArea
						className="flex-1"
						type="auto"
						scrollbarSize={10}
						offsetScrollbars
					>
						<Stack gap={8} ref={animateList}>
							{/* Loading skeleton for new template */}
							{isCreating && (
								<Paper p="xs" withBorder>
									<Stack gap={4}>
										<Skeleton height={14} width="40%" />
										<Skeleton height={10} width="80%" />
									</Stack>
								</Paper>
							)}

							{/* My Templates section header */}
							{!debouncedSearch && (
								<Text
									size="xs"
									fw={600}
									tt="uppercase"
									c="dimmed"
									style={{ letterSpacing: 0.5 }}
									mt={4}
								>
									<Trans>Pinned templates</Trans>
								</Text>
							)}

							{/* Quick access templates (sortable, with drag handles) */}
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragStart={handleDragStart}
								onDragEnd={handleDragEnd}
							>
								<SortableContext
									items={quickAccessItems.map((qi) =>
										quickAccessToKey(qi.type, qi.id),
									)}
									strategy={verticalListSortingStrategy}
								>
									{quickAccessTemplates.map((tmpl) => renderRow(tmpl, true))}
								</SortableContext>
							</DndContext>

							{/* Empty state for My Templates */}
							{!debouncedSearch && quickAccessTemplates.length === 0 && (
								<Paper p="sm" withBorder style={{ borderStyle: "dashed" }}>
									<Group gap="xs" justify="center">
										<IconPinFilled
											size={14}
											color="var(--mantine-color-gray-4)"
										/>
										<Text size="xs" c="dimmed">
											<Trans>Pin templates here for quick access.</Trans>
										</Text>
									</Group>
								</Paper>
							)}

							{/* All Templates header + filter */}
							{otherTemplates.length > 0 && !debouncedSearch && (
								<Group justify="space-between" mt={12}>
									<Text
										size="xs"
										fw={600}
										tt="uppercase"
										c="dimmed"
										style={{ letterSpacing: 0.5 }}
									>
										<Trans>All Templates</Trans>
									</Text>
									<Badge
										size="sm"
										variant={filterMine ? "filled" : "outline"}
										color={userTemplates.length > 0 ? "blue" : "gray"}
										style={{
											cursor: userTemplates.length > 0 ? "pointer" : "default",
											opacity: userTemplates.length > 0 ? 1 : 0.5,
										}}
										onClick={() => {
											if (userTemplates.length > 0) setFilterMine(!filterMine);
										}}
									>
										<Trans>My templates</Trans>
										{userTemplates.length > 0 && ` (${userTemplates.length})`}
									</Badge>
								</Group>
							)}

							{/* Rest of templates */}
							{(filterMine && !debouncedSearch
								? otherTemplates.filter((tmpl) => tmpl.source === "user")
								: otherTemplates
							).map((tmpl) => renderRow(tmpl, false))}

							{/* Empty search state */}
							{debouncedSearch && displayTemplates.length === 0 && (
								<Text size="sm" c="dimmed" ta="center" py="lg">
									<Trans>No templates match '{searchQuery}'</Trans>
								</Text>
							)}
						</Stack>
					</ScrollArea>
				</div>
			</Modal>

			{deleteConfirmationModal}
		</>
	);
};
