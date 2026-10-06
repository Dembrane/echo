import { t } from "@lingui/core/macro";
import { useDebouncedValue } from "@mantine/hooks";
import { formatDistanceToNowStrict } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useProjectById } from "@/components/project/hooks";
import type { ListQuery } from "@/lib/listQuery";
import {
	useConversationsCountByProjectId,
	useInfiniteConversationsByProjectId,
} from "./hooks";

export type ConversationSort =
	| "-created_at"
	| "created_at"
	| "-participant_name"
	| "participant_name"
	| "-duration"
	| "duration";

export const SORT_OPTIONS: { label: string; value: ConversationSort }[] = [
	{ label: t`Newest first`, value: "-created_at" },
	{ label: t`Oldest first`, value: "created_at" },
	{ label: t`Name A-Z`, value: "participant_name" },
	{ label: t`Name Z-A`, value: "-participant_name" },
	{ label: t`Longest first`, value: "-duration" },
	{ label: t`Shortest first`, value: "duration" },
];

export const getTagText = (tag: ConversationProjectTag) => {
	const projectTag = tag.project_tag_id as ProjectTag | string | null;
	return typeof projectTag === "object" && projectTag ? projectTag.text : null;
};

export const hasVerifiedArtifacts = (conversation: Conversation) =>
	conversation.conversation_artifacts?.some(
		(artifact) => (artifact as ConversationArtifact).approved_at,
	) ?? false;

export const formatStartedAt = (startedAt: string | null) => {
	if (!startedAt) return t`Unknown date`;
	return t`${formatDistanceToNowStrict(new Date(startedAt), {
		addSuffix: true,
	})}`;
};

/** A project's conversations with search, sort, tag and verified filters,
 * loaded page by page as the last row scrolls into view. Shared by the full
 * Conversations tab and the overview's mini list. */
export const useConversationList = (
	projectId: string,
	{ pageSize }: { pageSize: number },
) => {
	const { ref: loadMoreRef, inView } = useInView();
	const [search, setSearch] = useState("");
	const [debouncedSearch] = useDebouncedValue(search, 200);
	const [sortBy, setSortBy] = useState<ConversationSort>("-created_at");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [showOnlyVerified, setShowOnlyVerified] = useState(false);

	const projectQuery = useProjectById({
		projectId,
		query: {
			deep: {
				tags: {
					_sort: "sort",
				},
			},
			fields: [
				"id",
				"workspace_id",
				{
					tags: ["id", "text", "sort"],
				},
			],
		},
	});

	const allProjectTags = useMemo(
		() =>
			((projectQuery.data as Project | undefined)?.tags as ProjectTag[]) ?? [],
		[projectQuery.data],
	);
	const tagOptions = useMemo(() => {
		const options: { label: string; value: string }[] = [];
		for (const tag of allProjectTags) {
			if (tag.id && tag.text) {
				options.push({ label: tag.text, value: tag.id });
			}
		}
		return options;
	}, [allProjectTags]);

	const conversationQuery = useMemo(
		() =>
			({
				filter: {
					project_id: { _eq: projectId },
					...(selectedTagIds.length > 0 && {
						tags: {
							_some: {
								project_tag_id: {
									id: { _in: selectedTagIds },
								},
							},
						},
					}),
					...(showOnlyVerified && {
						conversation_artifacts: {
							_some: {
								approved_at: {
									_nnull: true,
								},
							},
						},
					}),
				},
				search: debouncedSearch,
				sort: sortBy,
			}) as Partial<ListQuery<Conversation>>,
		[projectId, selectedTagIds, showOnlyVerified, debouncedSearch, sortBy],
	);

	const conversationsQuery = useInfiniteConversationsByProjectId(
		projectId,
		false,
		false,
		conversationQuery,
		undefined,
		{ initialLimit: pageSize },
	);
	const conversationsCountQuery = useConversationsCountByProjectId(
		projectId,
		conversationQuery,
	);

	const allConversations =
		conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? [];

	useEffect(() => {
		if (
			inView &&
			conversationsQuery.hasNextPage &&
			!conversationsQuery.isFetchingNextPage
		) {
			conversationsQuery.fetchNextPage();
		}
	}, [
		inView,
		conversationsQuery.hasNextPage,
		conversationsQuery.isFetchingNextPage,
		conversationsQuery.fetchNextPage,
	]);

	const hasActiveFilters =
		selectedTagIds.length > 0 || showOnlyVerified || debouncedSearch !== "";
	const activeFiltersCount =
		selectedTagIds.length + (showOnlyVerified ? 1 : 0) + (search ? 1 : 0);

	const resetFilters = () => {
		setSearch("");
		setSelectedTagIds([]);
		setShowOnlyVerified(false);
		setSortBy("-created_at");
	};

	return {
		activeFiltersCount,
		allConversations,
		allProjectTags,
		conversationsCountQuery,
		conversationsQuery,
		debouncedSearch,
		hasActiveFilters,
		loadMoreRef,
		projectQuery,
		resetFilters,
		search,
		selectedTagIds,
		setSearch,
		setSelectedTagIds,
		setShowOnlyVerified,
		setSortBy,
		showOnlyVerified,
		sortBy,
		tagOptions,
	};
};
