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
	Chip,
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
	Title,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
	ArrowLeftIcon,
	CopyIcon,
	DotsSixVerticalIcon,
	MagnifyingGlassIcon,
	PencilSimpleIcon,
	PlusIcon,
	TrashIcon,
	XIcon,
	PushPinIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import {
	encodeTemplateKey,
	keyToQuickAccess,
	type QuickAccessItem,
	quickAccessToKey,
} from "./templateKey";
import { agenticQuickAccessTemplates, Templates } from "./templates";

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
		scope?: "user" | "workspace";
		can_edit?: boolean;
	}>;
	onCreateUserTemplate?: (payload: {
		title: string;
		content: string;
		scope?: "user" | "workspace";
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
	// When true, the create form shows a "Share with workspace" toggle. Set
	// false for contexts without a workspace (e.g. agentic playground) or
	// when the caller is an external guest who can't create workspace templates.
	canCreateWorkspaceTemplate?: boolean;
};

type UnifiedTemplate = {
	id: string;
	title: string;
	content: string;
	source: "dembrane" | "user";
	// Only meaningful for source='user': distinguishes personal from
	// workspace-shared templates. Undefined for 'dembrane' (built-in).
	scope?: "user" | "workspace";
	canEdit?: boolean;
	key: string;
};

// ── Badge ──

const SourceBadge = ({ source }: { source: "dembrane" }) => (
	<Badge size="xs" color="gray">
		{source}
	</Badge>
);

// Rows are full boxes (something you press) stacked with no gap; each row
// after the first tucks under the one above so neighbours share one rule.
const SHARED_RULE = { marginTop: "calc(-1 * var(--app-stroke))" };

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
	canCreateWorkspaceTemplate = false,
}: TemplatesModalProps) => {
	const [view, setView] = useState<ModalView>("browse");
	const [searchQuery, setSearchQuery] = useState("");
	const [filterMine, setFilterMine] = useState(false);
	const [animateList, enableAnimations] = useAutoAnimate();
	const [formTitle, setFormTitle] = useState("");
	const [formContent, setFormContent] = useState("");
	// Defaults to 'workspace' when the caller can create workspace templates,
	// that's the more useful setting in most chats. User can flip to
	// personal via the switch.
	const [formScope, setFormScope] = useState<"user" | "workspace">("user");
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
		setFormScope(canCreateWorkspaceTemplate ? "workspace" : "user");
		setView("create");
	};

	const handleDuplicate = (title: string, content: string) => {
		setFormTitle(`${title} (${t`copy`})`);
		setFormContent(content);
		setFormScope(canCreateWorkspaceTemplate ? "workspace" : "user");
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
				scope: canCreateWorkspaceTemplate ? formScope : "user",
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
		const staticTemplates = [...Templates, ...agenticQuickAccessTemplates];
		for (const tmpl of staticTemplates) {
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
				canEdit: tmpl.can_edit ?? true,
				content: tmpl.content,
				id: tmpl.id,
				key: encodeTemplateKey("user", tmpl.id),
				scope: tmpl.scope ?? "user",
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
		title: t`Templates`,
		withinPortal: true,
	};

	// ── Render: Create / Edit view ──

	const deleteConfirmationModal = (
		<ConfirmModal
			opened={!!deletingTemplateId}
			onClose={() => setDeletingTemplateId(null)}
			title={t`Delete template`}
			data-testid="template-delete-modal"
			message={t`Are you sure you want to delete this template? This cannot be undone.`}
			confirmLabel={<Trans>Delete</Trans>}
			loading={isDeleting}
			confirmColor="red"
			onConfirm={() => {
				if (deletingTemplateId) {
					onDeleteUserTemplate?.(deletingTemplateId);
					setDeletingTemplateId(null);
					setView("browse");
				}
			}}
		/>
	);

	if (view === "create" || view === "edit") {
		return (
			<>
				<Modal {...modalProps}>
					<div className="flex h-full flex-col">
						<Button
							variant="subtle"
							color="gray"
							size="compact-sm"
							leftSection={<ArrowLeftIcon size={20} />}
							onClick={handleBack}
							mb="md"
							className="self-start"
						>
							<Trans>Back</Trans>
						</Button>
						<Stack gap="md" className="flex-1">
							<TextInput
								label={t`Template name`}
								withAsterisk
								value={formTitle}
								onChange={(e) => setFormTitle(e.currentTarget.value)}
								placeholder={t`e.g. Weekly stakeholder digest`}
								maxLength={80}
							/>
							<Textarea
								label={t`Prompt`}
								withAsterisk
								value={formContent}
								onChange={(e) => setFormContent(e.currentTarget.value)}
								placeholder={t`What should ECHO analyse or generate from the conversations?`}
								minRows={6}
								maxRows={14}
								autosize
							/>
							{view === "create" && canCreateWorkspaceTemplate && (
								<Switch
									label={t`Share with workspace`}
									description={t`Visible to everyone in this workspace. Leave off to keep it personal.`}
									checked={formScope === "workspace"}
									onChange={(e) =>
										setFormScope(e.currentTarget.checked ? "workspace" : "user")
									}
								/>
							)}
							{view === "create" && (
								<Text size="xs" c="dimmed">
									<Trans>
										Tip: You can also create a template from any chat message
										you send, or duplicate an existing template.
									</Trans>
								</Text>
							)}
							<Group justify="flex-start" gap="sm">
								<Button
									variant="filled"
									onClick={
										view === "create" ? handleSaveCreate : handleSaveEdit
									}
									loading={view === "create" ? isCreating : isUpdating}
									disabled={!formTitle.trim() || !formContent.trim()}
								>
									<Trans>Save template</Trans>
								</Button>
								{view === "edit" && editingId && (
									<Button
										variant="subtle"
										color="red"
										onClick={() => setDeletingTemplateId(editingId)}
									>
										<Trans>Delete</Trans>
									</Button>
								)}
							</Group>
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
				style={{ ...SHARED_RULE, ...style }}
				p="xs"
				withBorder={false}
				className={`app-do ${isDragging ? "shadow-md" : ""}`}
				onClick={() => handleUseTemplate(tmpl.content, tmpl.key)}
			>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					{showDragHandle && dragHandleProps && (
						<Tooltip label={t`Drag to reorder`} position="left" openDelay={400}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle managed by dnd-kit */}
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: drag handle managed by dnd-kit */}
							{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: dnd-kit's attributes make it a button */}
							<div
								{...dragHandleProps}
								aria-label={t`Drag to reorder`}
								className="flex cursor-grab items-center active:cursor-grabbing"
								style={{ color: "var(--mantine-color-dimmed)" }}
								onClick={(e) => e.stopPropagation()}
							>
								<DotsSixVerticalIcon size={16} />
							</div>
						</Tooltip>
					)}
					<Stack gap={0} className="min-w-0 flex-1">
						<Group gap="xs">
							<Text size="sm" truncate>
								{tmpl.title}
							</Text>
							{tmpl.source !== "user" && <SourceBadge source={tmpl.source} />}
							{tmpl.source === "user" && tmpl.scope === "workspace" && (
								<Badge size="xs" color="gray">
									{t`Workspace`}
								</Badge>
							)}
						</Group>
						<Text size="xs" c="dimmed" lineClamp={2}>
							{tmpl.content}
						</Text>
					</Stack>
					<Group gap={0} wrap="nowrap">
						{tmpl.source === "dembrane" && (
							<Tooltip label={t`Duplicate`}>
								<ActionIcon aria-label={t`Duplicate`}
									variant="subtle"
									onClick={(e) => {
										e.stopPropagation();
										handleDuplicate(tmpl.title, tmpl.content);
									}}
								>
									<CopyIcon size={20} />
								</ActionIcon>
							</Tooltip>
						)}
						{tmpl.source === "user" && (
							<>
								{tmpl.canEdit && (
									<Tooltip label={t`Edit`}>
										<ActionIcon aria-label={t`Edit`}
											variant="subtle"
											onClick={(e) => {
												e.stopPropagation();
												const ut = userTemplates.find((u) => u.id === tmpl.id);
												if (ut) handleStartEdit(ut);
											}}
										>
											<PencilSimpleIcon size={20} />
										</ActionIcon>
									</Tooltip>
								)}
								<Tooltip label={t`Duplicate`}>
									<ActionIcon aria-label={t`Duplicate`}
										variant="subtle"
										onClick={(e) => {
											e.stopPropagation();
											handleDuplicate(tmpl.title, tmpl.content);
										}}
									>
										<CopyIcon size={20} />
									</ActionIcon>
								</Tooltip>
								{tmpl.canEdit && (
									<Tooltip label={t`Delete`}>
										<ActionIcon aria-label={t`Delete`}
											variant="subtle"
											color="red"
											loading={isDeleting}
											onClick={(e) => {
												e.stopPropagation();
												setDeletingTemplateId(tmpl.id);
											}}
										>
											<TrashIcon size={20} />
										</ActionIcon>
									</Tooltip>
								)}
							</>
						)}
						{/* Quick access promote/demote */}
						{onSaveQuickAccess &&
							(showDragHandle ? (
								<Tooltip label={t`Unpin`}>
									<ActionIcon aria-label={t`Unpin`}
										variant="subtle"
										color="primary"
										onClick={(e) => {
											e.stopPropagation();
											removeFromQuickAccess(tmpl.key);
										}}
									>
										<PushPinIcon size={20} />
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
										aria-label={t`Pin`}
										variant="subtle"
										disabled={quickAccessItems.length >= 5}
										onClick={(e) => {
											e.stopPropagation();
											addToQuickAccess(tmpl.key, tmpl.title);
										}}
									>
										<PushPinIcon size={20} />
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
					<Stack gap="md">
						{/* Contextual suggestions toggle + subtitle */}
						{onToggleAiSuggestions && (
							<Switch
								label={t`Contextual suggestions`}
								description={t`Suggest dynamic suggestions based on your conversation.`}
								checked={!hideAiSuggestions}
								onChange={(e) =>
									onToggleAiSuggestions(!e.currentTarget.checked)
								}
							/>
						)}

						<Group>
							{/* Search */}
							<TextInput
								placeholder={t`Search templates...`}
								leftSection={<MagnifyingGlassIcon size={16} />}
								className="flex-1"
								size="sm"
								rightSection={
									searchQuery ? (
										<ActionIcon
											variant="subtle"
											aria-label={t`Clear search`}
											onClick={() => setSearchQuery("")}
										>
											<XIcon size={16} />
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
								leftSection={<PlusIcon size={20} />}
								onClick={handleStartCreate}
							>
								<Trans>Create template</Trans>
							</Button>
						</Group>
					</Stack>

					<Divider my="md" />

					{/* Template list */}
					<ScrollArea
						className="flex-1"
						type="auto"
						scrollbarSize={10}
						offsetScrollbars
					>
						<Stack gap={0} ref={animateList}>
							{/* Loading skeleton for new template */}
							{isCreating && (
								<Paper p="xs" withBorder>
									<Stack gap="xs">
										<Skeleton height={14} width="40%" />
										<Skeleton height={10} width="80%" />
									</Stack>
								</Paper>
							)}

							{/* My Templates section header */}
							{!debouncedSearch && (
								<Title order={5} mb="sm">
									<Trans>Pinned templates</Trans>
								</Title>
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
								<Text size="sm" c="dimmed">
									<Trans>Pin templates here for quick access.</Trans>
								</Text>
							)}

							{/* All Templates header + filter */}
							{otherTemplates.length > 0 && !debouncedSearch && (
								<Group justify="space-between" mt="lg" mb="sm">
									<Title order={5}>
										<Trans>All templates</Trans>
									</Title>
									<Chip
										size="xs"
										checked={filterMine}
										onChange={setFilterMine}
										disabled={userTemplates.length === 0}
									>
										<Trans>My templates</Trans>
										{userTemplates.length > 0 && ` (${userTemplates.length})`}
									</Chip>
								</Group>
							)}

							{/* Rest of templates */}
							{(filterMine && !debouncedSearch
								? otherTemplates.filter((tmpl) => tmpl.source === "user")
								: otherTemplates
							).map((tmpl) => renderRow(tmpl, false))}

							{/* Empty search state */}
							{debouncedSearch && displayTemplates.length === 0 && (
								<Text size="sm" c="dimmed">
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
