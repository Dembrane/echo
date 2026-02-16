import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Center,
	Divider,
	Group,
	Loader,
	Modal,
	Radio,
	ScrollArea,
	Stack,
	TextInput,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import { IconArrowsExchange, IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import { FormLabel } from "@/components/form/FormLabel";
import { useInfiniteProjects } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
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

	const projectsQuery = useInfiniteProjects({
		options: {
			initialLimit: 10,
		},
		query: {
			filter: {
				id: {
					_neq: projectId as string,
				},
				...(debouncedSearchValue && {
					name: {
						_icontains: debouncedSearchValue,
					},
				}),
			},
			sort: "-updated_at",
		},
	});

	const moveConversationMutation = useMoveConversationMutation();

	const navigate = useI18nNavigate();

	const handleMove = handleSubmit((data) => {
		if (!data.targetProjectId) return;

		try {
			analytics.trackEvent(events.MOVE_TO_ANOTHER_PROJECT);
		} catch (error) {
			console.warn("Analytics tracking failed:", error);
		}

		moveConversationMutation.mutate(
			{
				conversationId: conversation.id,
				targetProjectId: data.targetProjectId,
			},
			{
				onSuccess: () => {
					close();
					navigate(
						`/projects/${data.targetProjectId}/conversation/${conversation.id}/overview`,
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

	return (
		<>
			<Button
				onClick={open}
				variant="outline"
				color="primary"
				rightSection={<IconArrowsExchange size={16} />}
				{...testId("conversation-move-button")}
			>
				<Group>
					<Badge color="mauve" c="graphite" size="sm">
						<Trans>Beta</Trans>
					</Badge>
					<Trans>Move to Another Project</Trans>
				</Group>
			</Button>

			<Modal
				opened={opened}
				onClose={close}
				title={t`Move Conversation`}
				{...testId("conversation-move-modal")}
			>
				<form onSubmit={handleMove}>
					<Stack gap="3rem">
						<Stack gap="md">
							<TextInput
								label={<FormLabel label={t`Search`} isDirty={false} />}
								placeholder={t`Search projects...`}
								leftSection={<IconSearch size={16} />}
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
									<Center style={{ height: 200 }}>
										<Trans>
											No projects found {search && `with "${search}"`}
										</Trans>
									</Center>
								)}

								{projectsQuery.isLoading ? (
									<Center style={{ height: 200 }}>
										<Loader />
									</Center>
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

						<Group justify="flex-end">
							<Button
								variant="subtle"
								onClick={close}
								disabled={moveConversationMutation.isPending}
								type="button"
								{...testId("conversation-move-cancel-button")}
							>
								{t`Cancel`}
							</Button>
							<Button
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
						</Group>
					</Stack>
				</form>
			</Modal>
		</>
	);
};
