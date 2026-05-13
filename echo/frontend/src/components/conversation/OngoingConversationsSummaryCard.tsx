import { t } from "@lingui/core/macro";
import { ActionIcon, Group, Stack, Text } from "@mantine/core";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { bff } from "@/lib/bff";
import { SummaryCard } from "../common/SummaryCard";

const TIME_INTERVAL_SECONDS = 30;

export const OngoingConversationsSummaryCard = ({
	projectId,
}: {
	projectId: string;
}) => {
	const queryClient = useQueryClient();
	// Track previous state to detect changes so we refetch the
	// conversations list when the count transitions (a conversation
	// went live or ended) — that way the list reflects fresh chunks
	// without the user having to hit refresh.
	const [hasOngoingConversations, setHasOngoingConversations] = useState(false);

	const conversationChunksQuery = useQuery({
		queryFn: async () => {
			const { count } = await bff.get<{ count: number }>(
				"/conversations/live-count",
				{ project_id: projectId, window_seconds: TIME_INTERVAL_SECONDS },
			);

			if (count > 0 || hasOngoingConversations) {
				queryClient.invalidateQueries({
					queryKey: ["projects", projectId, "conversations"],
				});
			}
			setHasOngoingConversations(count > 0);

			return count;
		},
		queryKey: ["conversation_chunks", projectId],
		refetchInterval: 30000,
	});

	return (
		<SummaryCard
			icon={<UsersThreeIcon size={24} />}
			label={
				<Group
					gap="xs"
					p={0}
					justify="space-between"
					w="100%"
					className="relative"
				>
					<Text className="text-lg">{t`Ongoing Conversations`}</Text>
					<ActionIcon
						variant="transparent"
						c="gray.8"
						opacity={0.6}
						disabled={conversationChunksQuery.isFetching}
						onClick={() => {
							conversationChunksQuery.refetch();
						}}
					>
						<IconRefresh />
					</ActionIcon>
				</Group>
			}
			value={
				<Stack className="h-full" gap="xs">
					<Text size="2rem" fw={600}>
						{conversationChunksQuery.data ?? 0}
					</Text>
				</Stack>
			}
			loading={conversationChunksQuery.isFetching}
		/>
	);
};
