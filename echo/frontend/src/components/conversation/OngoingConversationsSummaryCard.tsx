import { aggregate } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import { ActionIcon, Group, Stack, Text } from "@mantine/core";
import { UsersThreeIcon } from "@phosphor-icons/react";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { directus } from "@/lib/directus";
import { SummaryCard } from "../common/SummaryCard";

const TIME_INTERVAL_SECONDS = 30;

export const OngoingConversationsSummaryCard = ({
	projectId,
}: {
	projectId: string;
}) => {
	const queryClient = useQueryClient();
	// Track previous state to detect changes
	const [hasOngoingConversations, setHasOngoingConversations] = useState(false);
	// const hasOngoingConversationsRef = useRef<boolean>(false);

	const conversationChunksQuery = useQuery({
		queryFn: async () => {
			const result = await directus.request(
				aggregate("conversation_chunk", {
					aggregate: {
						countDistinct: ["conversation_id"],
					},
					query: {
						filter: {
							conversation_id: {
								project_id: projectId,
							},
							source: {
								// @ts-expect-error source is not typed
								_nin: ["DASHBOARD_UPLOAD", "CLONE"],
							},
							timestamp: {
								// @ts-expect-error gt is not typed
								_gt: new Date(
									Date.now() - TIME_INTERVAL_SECONDS * 1000,
								).toISOString(),
							},
						},
					},
				}),
			);

			const currentCount = Number(
				// @ts-expect-error aggregate response type is not properly typed
				(result[0]?.countDistinct?.conversation_id as string) ?? "0",
			);

			if (currentCount > 0 || hasOngoingConversations) {
				queryClient.invalidateQueries({
					queryKey: ["projects", projectId, "conversations"],
				});
				setHasOngoingConversations(false);
			}

			setHasOngoingConversations(currentCount > 0);

			return currentCount;
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
