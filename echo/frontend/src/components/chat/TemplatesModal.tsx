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
	TextInput,
	Textarea,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
	ArrowFatLineUp,
	ArrowLeft,
	Copy,
	DotsSixVertical,
	GearSix,
	Globe,
	MagnifyingGlass,
	PencilSimple,
	Plus,
	ShareNetwork,
	Star,
	Trash,
	X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { PublishTemplateForm } from "./PublishTemplateForm";
import type { QuickAccessItem } from "./QuickAccessConfigurator";
import { type Template, Templates } from "./templates";
import {
	useCommunityTemplates,
	useCopyTemplate,
	useMyCommunityStars,
	usePublishTemplate,
	useToggleStar,
	useUnpublishTemplate,
} from "./hooks/useCommunityTemplates";

// ── Types ──

type ModalView = "browse" | "create" | "edit" | "publish" | "settings";

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
	favoriteTemplateIds?: Set<string>;
	onToggleFavorite?: (
		promptTemplateId: string,
		isFavorited: boolean,
	) => void;
	userTemplateDetails?: Array<{
		id: string;
		is_public: boolean;
		star_count: number;
		copied_from: string | null;
		author_display_name: string | null;
	}>;
	defaultLanguage?: string;
	userName?: string | null;
	saveAsTemplateContent?: string | null;
	onClearSaveAsTemplate?: () => void;
};

type UnifiedTemplate = {
	id: string;
	title: string;
	content: string;
	source: "dembrane" | "community" | "user";
	key: string;
	authorName?: string | null;
	starCount?: number;
	useCount?: number;
};

// ── Badge ──

const SourceBadge = ({ source }: { source: "dembrane" | "community" }) => (
	<Badge
		size="xs"
		variant="light"
		color={source === "dembrane" ? "teal" : "blue"}
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
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 10 : undefined,
		opacity: isDragging ? 0.9 : 1,
	};

	return (
		<>
			{children({
				dragHandleProps: { ...attributes, ...listeners },
				isDragging,
				style,
				ref: setNodeRef,
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
	favoriteTemplateIds: _favoriteTemplateIds = new Set(),
	onToggleFavorite: _onToggleFavorite,
	userTemplateDetails = [],
	defaultLanguage,
	userName,
	saveAsTemplateContent,
	onClearSaveAsTemplate,
}: TemplatesModalProps) => {
	const [view, setView] = useState<ModalView>("browse");
	const [searchQuery, setSearchQuery] = useState("");
	const [formTitle, setFormTitle] = useState("");
	const [formContent, setFormContent] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [publishingTemplate, setPublishingTemplate] = useState<{
		id: string;
		title: string;
		content: string;
	} | null>(null);

	// Community features disabled until Directus fields are created
	// (author_display_name, use_count, star_count, copied_from)
	const showCommunity = false;

	const [debouncedSearch] = useDebouncedValue(searchQuery, 300);

	// Handle save-as-template prefill
	useEffect(() => {
		if (saveAsTemplateContent && opened) {
			setFormTitle("");
			setFormContent(saveAsTemplateContent);
			setView("create");
			onClearSaveAsTemplate?.();
		}
	}, [saveAsTemplateContent, opened]);

	// Community data
	const communityQuery = useCommunityTemplates({ limit: 100 });
	const starsQuery = useMyCommunityStars();
	const toggleStarMutation = useToggleStar();
	const copyMutation = useCopyTemplate();
	const publishMutation = usePublishTemplate();
	const unpublishMutation = useUnpublishTemplate();

	const starredIds = starsQuery.data ?? new Set<string>();
	const communityTemplates = communityQuery.data ?? [];

	// ── Pin helpers ──

	const isPinned = (type: "static" | "user", id: string) =>
		quickAccessItems.some(
			(item) => item.type === type && item.id === id,
		);

	const addToQuickAccess = (type: "static" | "user", id: string, title: string) => {
		if (!onSaveQuickAccess || quickAccessItems.length >= 5) return;
		onSaveQuickAccess([...quickAccessItems, { type, id, title }]);
	};

	const removeFromQuickAccess = (type: "static" | "user", id: string) => {
		if (!onSaveQuickAccess) return;
		onSaveQuickAccess(
			quickAccessItems.filter((item) => !(item.type === type && item.id === id)),
		);
	};

	// DnD sensors
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor),
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id || !onSaveQuickAccess) return;
		const oldIndex = quickAccessItems.findIndex(
			(qi) => `${qi.type}-${qi.id}` === active.id,
		);
		const newIndex = quickAccessItems.findIndex(
			(qi) => `${qi.type}-${qi.id}` === over.id,
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
				title: formTitle.trim(),
				content: formContent.trim(),
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
				id: editingId,
				title: formTitle.trim(),
				content: formContent.trim(),
			});
			setView("browse");
		} catch {
			// stay on form so user can retry
		}
	};

	const handleBack = () => {
		setView("browse");
		setEditingId(null);
		setPublishingTemplate(null);
	};

	const resetState = () => {
		setView("browse");
		setSearchQuery("");
		setFormTitle("");
		setFormContent("");
		setEditingId(null);
		setPublishingTemplate(null);
	};

	// ── Merged & sorted template list ──

	const allTemplates = useMemo(() => {
		const items: UnifiedTemplate[] = [];
		for (const tmpl of Templates) {
			items.push({
				id: tmpl.id,
				title: tmpl.title,
				content: tmpl.content,
				source: "dembrane",
				key: tmpl.title,
			});
		}
		if (showCommunity) {
			for (const tmpl of communityTemplates) {
				if (!tmpl.is_own) {
					items.push({
						id: tmpl.id,
						title: tmpl.title,
						content: tmpl.content,
						source: "community",
						key: tmpl.id,
						authorName: tmpl.author_display_name,
						starCount: tmpl.star_count,
						useCount: tmpl.use_count,
					});
				}
			}
		}
		for (const tmpl of userTemplates) {
			items.push({
				id: tmpl.id,
				title: tmpl.title,
				content: tmpl.content,
				source: "user",
				key: `user:${tmpl.id}`,
			});
		}
		return items;
	}, [communityTemplates, userTemplates]);

	// Sort: pinned first → dembrane → community → user, then alphabetical
	const allSorted = useMemo(() => {
		const sourceOrder = { dembrane: 1, community: 2, user: 3 };
		return [...allTemplates].sort((a, b) => {
			const aPinType = a.source === "dembrane" ? ("static" as const) : ("user" as const);
			const bPinType = b.source === "dembrane" ? ("static" as const) : ("user" as const);
			const aPinned = a.source !== "community" && isPinned(aPinType, a.id) ? 0 : 1;
			const bPinned = b.source !== "community" && isPinned(bPinType, b.id) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
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
		opened,
		onClose,
		onExitTransitionEnd: resetState,
		title: (
			<Text fw={500} size="lg">
				<Trans>Templates</Trans>
			</Text>
		),
		size: "lg" as const,
		withinPortal: true,
		classNames: {
			body: "flex-1 flex flex-col overflow-hidden",
			content: "h-[600px] flex flex-col overflow-hidden",
		},
	};

	// ── Render: Create / Edit view ──

	if (view === "create" || view === "edit") {
		return (
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
								onClick={() => {
									onDeleteUserTemplate?.(editingId);
									setView("browse");
								}}
							>
								<Text size="sm" c="red" ta="center">
									<Trans>Delete template</Trans>
								</Text>
							</UnstyledButton>
						)}
					</Stack>
				</div>
			</Modal>
		);
	}

	// ── Render: Publish view ──

	if (view === "publish" && publishingTemplate) {
		return (
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
					<PublishTemplateForm
						template={publishingTemplate}
						onPublish={(args) => {
							publishMutation.mutate(args, {
								onSuccess: () => {
									setPublishingTemplate(null);
									setView("browse");
								},
							});
						}}
						onCancel={handleBack}
						isPublishing={publishMutation.isPending}
						defaultLanguage={defaultLanguage}
						userName={userName}
					/>
				</div>
			</Modal>
		);
	}

	// ── Render: Settings view ──

	if (view === "settings") {
		return (
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
					<Stack gap="lg">
						{/* Contextual suggestions */}
						{onToggleAiSuggestions && (
							<Group justify="space-between" wrap="nowrap">
								<Stack gap={2} className="flex-1">
									<Text size="sm" fw={500}>
										<Trans>Contextual suggestions</Trans>
									</Text>
									<Text size="xs" c="dimmed">
										<Trans>
											Suggest prompts based on your conversations. Try sending a message to see it in action.
										</Trans>
									</Text>
								</Stack>
								<Switch
									checked={!hideAiSuggestions}
									onChange={(e) =>
										onToggleAiSuggestions(!e.currentTarget.checked)
									}
								/>
							</Group>
						)}

					</Stack>
				</div>
			</Modal>
		);
	}

	// ── Render: Browse view (single flat list) ──

	// Split templates into quick access (pinned) and rest
	const quickAccessTemplates = displayTemplates.filter((tmpl) => {
		const pinType = tmpl.source === "dembrane" ? ("static" as const) : ("user" as const);
		return tmpl.source !== "community" && isPinned(pinType, tmpl.id);
	});
	const otherTemplates = displayTemplates.filter((tmpl) => {
		const pinType = tmpl.source === "dembrane" ? ("static" as const) : ("user" as const);
		return tmpl.source === "community" || !isPinned(pinType, tmpl.id);
	});

	const renderRow = (tmpl: UnifiedTemplate, showDragHandle: boolean) => {
		const isStarred = starredIds.has(tmpl.id);
		const details = tmpl.source === "user"
			? userTemplateDetails.find((d) => d.id === tmpl.id)
			: undefined;
		const isPublished = details?.is_public ?? false;
		const pinType = tmpl.source === "dembrane" ? ("static" as const) : ("user" as const);
		const sortId = `${pinType}-${tmpl.id}`;

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
						<div
							{...dragHandleProps}
							className="flex cursor-grab items-center text-gray-400 hover:text-gray-600 active:cursor-grabbing"
							onClick={(e) => e.stopPropagation()}
						>
							<DotsSixVertical size={14} weight="bold" />
						</div>
					)}
					<Stack gap={1} className="min-w-0 flex-1">
						<Group gap={6}>
							<Text size="sm" fw={500} truncate>{tmpl.title}</Text>
							{tmpl.source !== "user" && <SourceBadge source={tmpl.source} />}
							{isPublished && (
								<Tooltip label={t`Published to community`}>
									<Globe size={12} color="var(--mantine-color-blue-5)" />
								</Tooltip>
							)}
						</Group>
						<Text size="xs" c="dimmed" lineClamp={1}>{tmpl.content}</Text>
						{tmpl.source === "community" && tmpl.authorName && (
							<Text size="xs" c="dimmed">{tmpl.authorName}</Text>
						)}
					</Stack>
					<Group gap={2} wrap="nowrap">
						{tmpl.source === "community" && (
							<>
								<Tooltip label={isStarred ? t`Remove from favorites` : t`Add to favorites`}>
									<ActionIcon size="xs" variant={isStarred ? "filled" : "subtle"} color={isStarred ? "yellow" : "gray"}
										onClick={(e) => { e.stopPropagation(); toggleStarMutation.mutate(tmpl.id); }}>
										<Star size={12} weight={isStarred ? "fill" : "regular"} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label={t`Save to my templates`}>
									<ActionIcon size="xs" variant="subtle"
										onClick={(e) => { e.stopPropagation(); copyMutation.mutate(tmpl.id); }}
										loading={copyMutation.isPending && copyMutation.variables === tmpl.id}>
										<Copy size={12} />
									</ActionIcon>
								</Tooltip>
							</>
						)}
						{tmpl.source === "dembrane" && (
							<Tooltip label={t`Duplicate`}>
								<ActionIcon size="xs" variant="subtle"
									onClick={(e) => { e.stopPropagation(); handleDuplicate(tmpl.title, tmpl.content); }}>
									<Copy size={12} />
								</ActionIcon>
							</Tooltip>
						)}
						{tmpl.source === "user" && (
							<>
								{showCommunity && (isPublished ? (
									<Tooltip label={t`Unpublish from community`}>
										<ActionIcon size="xs" variant="subtle" color="blue" loading={unpublishMutation.isPending}
											onClick={(e) => { e.stopPropagation(); unpublishMutation.mutate(tmpl.id); }}>
											<Globe size={12} />
										</ActionIcon>
									</Tooltip>
								) : (
									<Tooltip label={t`Share with community`}>
										<ActionIcon size="xs" variant="subtle"
											onClick={(e) => {
												e.stopPropagation();
												const ut = userTemplates.find((u) => u.id === tmpl.id);
												if (ut) { setPublishingTemplate(ut); setView("publish"); }
											}}>
											<ShareNetwork size={12} />
										</ActionIcon>
									</Tooltip>
								))}
								<Tooltip label={t`Edit`}>
									<ActionIcon size="xs" variant="subtle"
										onClick={(e) => {
											e.stopPropagation();
											const ut = userTemplates.find((u) => u.id === tmpl.id);
											if (ut) handleStartEdit(ut);
										}}>
										<PencilSimple size={12} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label={t`Delete`}>
									<ActionIcon size="xs" variant="subtle" color="red" loading={isDeleting}
										onClick={(e) => { e.stopPropagation(); onDeleteUserTemplate?.(tmpl.id); }}>
										<Trash size={12} />
									</ActionIcon>
								</Tooltip>
							</>
						)}
						{/* Quick access promote/demote */}
						{tmpl.source !== "community" && onSaveQuickAccess && (
							showDragHandle ? (
								<Tooltip label={t`Remove from quick access`}>
									<ActionIcon size="xs" variant="subtle" color="gray"
										onClick={(e) => { e.stopPropagation(); removeFromQuickAccess(pinType, tmpl.id); }}>
										<X size={12} />
									</ActionIcon>
								</Tooltip>
							) : (
								<Tooltip label={quickAccessItems.length >= 5 ? t`Quick access is full (max 5)` : t`Add to quick access`}>
									<ActionIcon size="xs" variant="subtle" color="blue"
										disabled={quickAccessItems.length >= 5}
										onClick={(e) => { e.stopPropagation(); addToQuickAccess(pinType, tmpl.id, tmpl.title); }}>
										<ArrowFatLineUp size={12} />
									</ActionIcon>
								</Tooltip>
							)
						)}
					</Group>
				</Group>
			</Paper>
		);

		if (showDragHandle) {
			return (
				<SortableTemplateRow key={`${tmpl.source}-${tmpl.id}`} sortId={sortId}>
					{({ dragHandleProps, isDragging, style, ref }) =>
						rowContent(dragHandleProps, isDragging, style, ref)
					}
				</SortableTemplateRow>
			);
		}

		return <div key={`${tmpl.source}-${tmpl.id}`}>{rowContent()}</div>;
	};

	return (
		<Modal {...modalProps}>
			<div className="flex h-full flex-col">
				{/* Search */}
				<TextInput
					placeholder={t`Search templates...`}
					leftSection={<MagnifyingGlass size={16} />}
					rightSection={
						searchQuery ? (
							<ActionIcon
								size="sm"
								variant="default"
								aria-label="Clear search"
								className="border-0"
								onClick={() => setSearchQuery("")}
							>
								<X size={16} />
							</ActionIcon>
						) : null
					}
					rightSectionPointerEvents="all"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.currentTarget.value)}
					className="mb-2"
				/>

				{/* Settings button */}
				<Group justify="flex-end" className="mb-2">
					<Tooltip label={t`Settings`}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							onClick={() => setView("settings")}
						>
							<GearSix size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>

				{/* Single flat template list */}
				<ScrollArea className="flex-1" type="auto" scrollbarSize={10} offsetScrollbars>
					<Stack gap={4}>
						{/* + Create template row */}
						<Paper
							p="xs"
							withBorder
							className="cursor-pointer border-dashed border-gray-300 transition-all hover:border-blue-400 hover:bg-blue-50/30"
							onClick={handleStartCreate}
						>
							<Group gap="xs">
								<Plus size={14} color="var(--mantine-color-blue-5)" />
								<Text size="sm" fw={500} c="blue">
									<Trans>Create template</Trans>
								</Text>
							</Group>
						</Paper>

						{/* Loading skeleton for new template */}
						{isCreating && (
							<Paper p="xs" withBorder>
								<Stack gap={4}>
									<Skeleton height={14} width="40%" />
									<Skeleton height={10} width="80%" />
								</Stack>
							</Paper>
						)}

						{/* Quick access templates (sortable, with drag handles) */}
						<DndContext
							sensors={sensors}
							collisionDetection={closestCenter}
							onDragEnd={handleDragEnd}
						>
							<SortableContext
								items={quickAccessItems.map(
									(qi) => `${qi.type}-${qi.id}`,
								)}
								strategy={verticalListSortingStrategy}
							>
								{quickAccessTemplates.map((tmpl) => renderRow(tmpl, true))}
							</SortableContext>
						</DndContext>

						{/* Divider between quick access and rest */}
						{quickAccessTemplates.length > 0 && otherTemplates.length > 0 && !debouncedSearch && (
							<Divider
								label={<Text size="xs" c="dimmed"><Trans>All templates</Trans></Text>}
								labelPosition="center"
								className="my-1"
							/>
						)}

						{/* Rest of templates */}
						{otherTemplates.map((tmpl) => renderRow(tmpl, false))}

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
	);
};
