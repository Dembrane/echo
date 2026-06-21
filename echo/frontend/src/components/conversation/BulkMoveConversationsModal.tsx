import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Button,
	Center,
	Divider,
	Group,
	Loader,
	Modal,
	Radio,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useInfiniteProjects } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { testId } from "@/lib/testUtils";
import { useBulkMoveConversationsMutation } from "./hooks";

interface Props {
	opened: boolean;
	onClose: () => void;
	conversationIds: string[];
	/** Current project — excluded from the destination list. */
	currentProjectId: string;
	/** Called after a successful move so the caller can clear its selection. */
	onMoved: () => void;
}

/**
 * Move several selected conversations to one target project. Destinations are
 * scoped to the current workspace (same as the single-conversation move). The
 * server enforces project:update on source + target.
 */
export const BulkMoveConversationsModal = ({
	opened,
	onClose,
	conversationIds,
	currentProjectId,
	onMoved,
}: Props) => {
	const { workspaceId } = useWorkspace();
	const { ref: loadMoreRef, inView } = useInView();
	const [search, setSearch] = useState("");
	const [debouncedSearch] = useDebouncedValue(search, 200);
	const [targetProjectId, setTargetProjectId] = useState("");
	const bulkMove = useBulkMoveConversationsMutation();

	const projectsQuery = useInfiniteProjects({
		options: { initialLimit: 10 },
		query: {
			filter: {
				id: { _neq: currentProjectId },
				...(workspaceId && { workspace_id: { _eq: workspaceId } }),
				...(debouncedSearch && { name: { _icontains: debouncedSearch } }),
			},
			sort: "-updated_at",
		},
	});

	useEffect(() => {
		if (!opened) {
			setSearch("");
			setTargetProjectId("");
		}
	}, [opened]);

	useEffect(() => {
		if (inView && projectsQuery.hasNextPage && !projectsQuery.isFetchingNextPage) {
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

	const handleMove = () => {
		if (!targetProjectId || conversationIds.length === 0) return;
		posthog.capture("conversations_bulk_moved", {
			count: conversationIds.length,
		});
		bulkMove.mutate(
			{ conversationIds, targetProjectId },
			{
				onSuccess: () => {
					onMoved();
					onClose();
				},
			},
		);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Move conversations`}
			{...testId("bulk-move-conversations-modal")}
		>
			<Stack gap="lg">
				<Text size="sm">
					<Plural
						value={conversationIds.length}
						one="Move # conversation to another project."
						other="Move # conversations to another project."
					/>
				</Text>
				<TextInput
					placeholder={t`Search projects...`}
					leftSection={<IconSearch size={16} />}
					value={search}
					onChange={(e) => setSearch(e.currentTarget.value)}
					{...testId("bulk-move-conversations-search")}
				/>
				<Divider />
				<ScrollArea style={{ height: 300 }} scrollbarSize={4}>
					{projectsQuery.isLoading ? (
						<Center style={{ height: 200 }}>
							<Loader />
						</Center>
					) : allProjects.length === 0 ? (
						<Center style={{ height: 200 }}>
							<Trans>No other projects in this workspace.</Trans>
						</Center>
					) : (
						<Radio.Group value={targetProjectId} onChange={setTargetProjectId}>
							<Stack gap="sm">
								{allProjects.map((project, index) => (
									<div
										key={project.id}
										ref={index === allProjects.length - 1 ? loadMoreRef : undefined}
									>
										<Radio value={project.id} label={project.name} />
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
				</ScrollArea>
				<Group justify="flex-end">
					<Button
						variant="subtle"
						onClick={onClose}
						disabled={bulkMove.isPending}
						{...testId("bulk-move-conversations-cancel")}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={handleMove}
						loading={bulkMove.isPending}
						disabled={!targetProjectId || bulkMove.isPending}
						{...testId("bulk-move-conversations-confirm")}
					>
						<Trans>Move</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
