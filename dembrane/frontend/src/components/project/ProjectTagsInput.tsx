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
	horizontalListSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	LoadingOverlay,
	Skeleton,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { XIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { notifyError } from "@/components/error/notifyError";
import { useProjectById } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";
import { FormLabel } from "../form/FormLabel";
import {
	useCreateProjectTagMutation,
	useDeleteTagByIdMutation,
	useReorderProjectTagsMutation,
} from "./hooks";

export const ProjectTagPill = ({
	tag,
	projectId,
}: {
	tag: ProjectTag;
	projectId: string;
}) => {
	const deleteTagMutation = useDeleteTagByIdMutation();
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		// @ts-expect-error prevent accidental drag
		activationConstraint: {
			distance: 8,
		},
		id: tag.id,
	});

	if (!tag || !tag.text) {
		return null;
	}

	const style = {
		cursor: "grab",
		transform: CSS.Transform.toString(transform),
		transition,
	};

	const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
		e.stopPropagation();
		if (!isDragging) {
			openConfirm();
		}
	};

	return (
		<>
			<Badge
				ref={setNodeRef}
				style={{
					...style,
					textTransform: "none",
				}}
				variant="light"
				c="var(--app-text)"
				size="lg"
				rightSection={
					<ActionIcon
						onClick={(e) => handleDelete(e)}
						size="xs"
						variant="transparent"
						onPointerDown={(e) => e.stopPropagation()}
					>
						<XIcon size={16} />
					</ActionIcon>
				}
				{...attributes}
				{...listeners}
			>
				<span>{tag.text}</span>
			</Badge>
			<ConfirmModal
				opened={confirmOpened}
				onClose={closeConfirm}
				title={t`Delete tag`}
				data-testid="tag-delete-modal"
				message={t`Are you sure you want to delete this tag? This will remove the tag from existing conversations that contain it.`}
				confirmLabel={<Trans>Delete</Trans>}
				confirmColor="red"
				onConfirm={() => {
					deleteTagMutation.mutate({ projectId, tagId: tag.id });
					closeConfirm();
				}}
			/>
		</>
	);
};

export const ProjectTagsInput = (props: { project: Project }) => {
	const projectQuery = useProjectById({
		projectId: props.project.id,
		query: {
			deep: {
				tags: {
					_sort: "sort",
				},
			},
			fields: [
				"id",
				{
					tags: ["id", "created_at", "text", "sort"],
				},
			],
		},
	});
	const createTagMutation = useCreateProjectTagMutation();
	const reorderTagsMutation = useReorderProjectTagsMutation();

	const queryClient = useQueryClient();

	const [tagInput, setTagInput] = useState("");
	const [localOrder, setLocalOrder] = useState<string[] | null>(null);
	// Only the latest drop hands the screen back to the server's order.
	const dropGeneration = useRef(0);
	const saveQueue = useRef<Promise<void>>(Promise.resolve());
	const lastSaveError = useRef<unknown>(null);

	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor),
	);

	// Sort tags by sort field before rendering
	const sortedTags = [
		...((projectQuery.data?.tags as unknown as ProjectTag[]) ?? []),
	].sort(
		(a, b) =>
			((a as ProjectTag).sort ?? Number.POSITIVE_INFINITY) -
			((b as ProjectTag).sort ?? Number.POSITIVE_INFINITY),
	);
	const displayedTags = localOrder
		? [
				...localOrder.flatMap((id) =>
					sortedTags.filter((tag) => tag.id === id),
				),
				...sortedTags.filter((tag) => !localOrder.includes(tag.id)),
			]
		: sortedTags;

	const handleSubmit = async () => {
		if (!tagInput.trim()) return;

		const tags = tagInput
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag !== "");

		const currentMaxSort = Math.max(
			0,
			...(projectQuery.data?.tags?.map((t) => (t as ProjectTag).sort ?? 0) ??
				[]),
		);

		// Wait for all tag creation mutations to complete
		await Promise.all(
			tags.map((tag, index) =>
				createTagMutation.mutateAsync({
					// @ts-expect-error directus user id is not required
					project_id: {
						id: props.project.id,
					},
					sort: currentMaxSort + index + 1,
					text: tag,
				}),
			),
		);

		setTagInput("");
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;

		if (!active || !over || active.id === over.id) return;

		const oldIndex = displayedTags.findIndex((tag) => tag.id === active.id);
		const newIndex = displayedTags.findIndex((tag) => tag.id === over.id);

		if (oldIndex === -1 || newIndex === -1) return;

		const order = arrayMove(displayedTags, oldIndex, newIndex).map(
			(tag) => tag.id,
		);

		// Keep the dropped order on screen until its save is done.
		setLocalOrder(order);
		dropGeneration.current += 1;
		const generation = dropGeneration.current;

		// One drop saves at a time, so the last drop is the last write.
		saveQueue.current = saveQueue.current
			.then(() =>
				reorderTagsMutation.mutateAsync({
					project_id: props.project.id,
					tag_ids: order,
				}),
			)
			.then(
				() => {
					lastSaveError.current = null;
				},
				(error) => {
					lastSaveError.current = error;
				},
			)
			.then(async () => {
				if (generation !== dropGeneration.current) return;
				await queryClient.invalidateQueries({
					queryKey: ["projects", props.project.id],
				});
				if (generation !== dropGeneration.current) return;
				// A failed save changed nothing, so the server's order is the old one.
				setLocalOrder(null);
				if (lastSaveError.current) void notifyError(lastSaveError.current);
			});
	};

	if (projectQuery.isLoading) {
		return (
			<Stack>
				<Skeleton height={30} />
			</Stack>
		);
	}

	return (
		<Stack className="relative">
			<LoadingOverlay visible={projectQuery.isLoading} />
			<Box>
				{createTagMutation.isError && (
					<ErrorNotice error={createTagMutation.error} />
				)}
				<Stack gap="sm">
					<Group align="end">
						<TextInput
							label={
								<FormLabel
									label={t`Tags`}
									isDirty={tagInput.trim().length > 0}
								/>
							}
							description={t`Participants will be able to select tags when creating conversations`}
							value={tagInput}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleSubmit();
								}
							}}
							onChange={(e) => setTagInput(e.currentTarget.value)}
							{...testId("portal-editor-tags-input")}
						/>
						<Button
							loading={createTagMutation.isPending}
							onClick={handleSubmit}
							disabled={!tagInput.trim() || createTagMutation.isPending}
							{...testId("portal-editor-add-tag-button")}
						>
							{tagInput.includes(",") ? t`Add tags` : t`Add tag`}
						</Button>
					</Group>
					<Group gap="sm">
						{(projectQuery.data?.tags?.length ?? 0) === 0 ? (
							<Text size="sm" c="dimmed">
								<Trans>
									No tags have been added to this project yet. Add a tag using
									the text input above to get started.
								</Trans>
							</Text>
						) : (
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragEnd={handleDragEnd}
							>
								<SortableContext
									items={displayedTags.map((tag) => tag.id)}
									strategy={horizontalListSortingStrategy}
								>
									{displayedTags.map((tag) => (
										<ProjectTagPill
											key={tag.id}
											tag={tag}
											projectId={props.project.id}
										/>
									))}
								</SortableContext>
							</DndContext>
						)}
					</Group>
				</Stack>
			</Box>
		</Stack>
	);
};
