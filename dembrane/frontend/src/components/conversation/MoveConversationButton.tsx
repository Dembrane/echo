import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Center,
	Divider,
	Group,
	Loader,
	Modal,
	Radio,
	ScrollArea,
	Skeleton,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import {
	ArrowsLeftRightIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import {
	MoveHistory,
	type MoveHistoryEntry,
} from "@/components/common/MoveHistory";
import { FormLabel } from "@/components/form/FormLabel";
import { useInfiniteProjects } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";
import { useMoveConversationMutation } from "./hooks";

export const MoveConversationButton = ({
	conversation,
}: {
	conversation: Conversation;
}) => {
	const [opened, { open, close }] = useDisclosure(false);
	const { ref: loadMoreRef, inView } = useInView();
	const [search, setSearch] = useState("");
	const [debouncedSearchValue] = useDebouncedValue(search, 200);

	const { projectId } = useParams();

	const {
		control,
		handleSubmit,
		reset,
		formState: { dirtyFields },
	} = useForm({
		defaultValues: {
			targetProjectId: "",
		},
		mode: "onChange",
	});

	const { workspace, workspaceId, workspaces } = useWorkspace();
	// Moving needs project:update, which observers lack.
	const canMove = !!workspace && !isReadOnlyRole(workspace.role);

	// Every reachable workspace: the API refuses only a different billing or data owner.
	const projectsQuery = useInfiniteProjects({
		options: {
			excludeProjectId: projectId,
			initialLimit: 10,
			search: debouncedSearchValue,
		},
		query: {},
	});

	const moveConversationMutation = useMoveConversationMutation();

	const navigate = useI18nNavigate();

	const handleMove = handleSubmit((data) => {
		if (!data.targetProjectId) return;

		posthog.capture("conversation_moved");

		moveConversationMutation.mutate(
			{
				conversationId: conversation.id,
				targetProjectId: data.targetProjectId,
			},
			{
				onSuccess: () => {
					close();
					const target = allProjects.find((p) => p.id === data.targetProjectId);
					navigate(
						`/w/${target?.workspace_id ?? workspaceId}/projects/${data.targetProjectId}/conversations/${conversation.id}`,
					);
				},
			},
		);
	});

	useEffect(() => {
		if (!opened) {
			reset();
			setSearch("");
		}
	}, [opened, reset]);

	useEffect(() => {
		if (
			inView &&
			projectsQuery.hasNextPage &&
			!projectsQuery.isFetchingNextPage
		) {
			projectsQuery.fetchNextPage();
		}
	}, [
		inView,
		projectsQuery.hasNextPage,
		projectsQuery.isFetchingNextPage,
		projectsQuery.fetchNextPage,
	]);

	const allProjects =
		(
			projectsQuery.data?.pages as
				| { projects: Project[]; nextOffset?: number }[]
				| undefined
		)?.flatMap((page) => page.projects) ?? [];

	if (!canMove) return null;

	return (
		<>
			<Button
				onClick={open}
				leftSection={<ArrowsLeftRightIcon size={20} />}
				{...testId("conversation-move-button")}
			>
				<Trans>Move to another project</Trans>
			</Button>

			<Modal
				opened={opened}
				onClose={close}
				title={t`Move conversation`}
				{...testId("conversation-move-modal")}
			>
				<form onSubmit={handleMove}>
					<Stack gap="xl">
						<Stack gap="lg">
							<Stack gap="md">
								<TextInput
									label={<FormLabel label={t`Search`} isDirty={false} />}
									placeholder={t`Search projects...`}
									leftSection={<MagnifyingGlassIcon size={16} />}
									value={search}
									onChange={(e) => setSearch(e.currentTarget.value)}
									{...testId("conversation-move-search-input")}
								/>

								<Divider />

								<ScrollArea style={{ height: 300 }} scrollbarSize={4}>
									{(
										projectsQuery.data?.pages as
											| { projects: Project[]; nextOffset?: number }[]
											| undefined
									)?.flatMap((page) => page.projects).length === 0 && (
										<Text size="sm" c="dimmed">
											<Trans>
												No projects found {search && `with "${search}"`}
											</Trans>
										</Text>
									)}

									{projectsQuery.isLoading ? (
										<Stack gap="sm">
											<Skeleton height={24} />
											<Skeleton height={24} />
											<Skeleton height={24} />
										</Stack>
									) : (
										<Controller
											name="targetProjectId"
											control={control}
											render={({ field }) => (
												<Radio.Group {...field}>
													<Stack gap="sm">
														{allProjects.map((project, index) => (
															<div
																key={project.id}
																ref={
																	index === allProjects.length - 1
																		? loadMoreRef
																		: undefined
																}
															>
																<Radio
																	value={project.id}
																	label={project.name}
																	description={
																		project.workspace_id !== workspaceId
																			? workspaces.find(
																					(w) => w.id === project.workspace_id,
																				)?.name
																			: undefined
																	}
																	{...testId(
																		`conversation-move-project-radio-${project.id}`,
																	)}
																/>
															</div>
														))}
														{projectsQuery.isFetchingNextPage && (
															<Center>
																<Loader size="sm" />
															</Center>
														)}
													</Stack>
												</Radio.Group>
											)}
										/>
									)}
								</ScrollArea>
							</Stack>

							<Group justify="flex-start">
								<Button
									variant="filled"
									type="submit"
									loading={moveConversationMutation.isPending}
									disabled={
										!dirtyFields.targetProjectId ||
										moveConversationMutation.isPending
									}
									{...testId("conversation-move-submit-button")}
								>
									{t`Move`}
								</Button>
								<Button
									variant="subtle"
									color="gray"
									onClick={close}
									disabled={moveConversationMutation.isPending}
									type="button"
									{...testId("conversation-move-cancel-button")}
								>
									{t`Cancel`}
								</Button>
							</Group>
						</Stack>

						<MoveHistory
							entries={
								(conversation as { move_history?: MoveHistoryEntry[] })
									.move_history
							}
							title={<Trans>Move history</Trans>}
						/>
					</Stack>
				</form>
			</Modal>
		</>
	);
};
