import { readItems } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import { ActionIcon, Group, Stack, Text } from "@mantine/core";
import { IconRefresh, IconUsersGroup } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { directus } from "@/lib/directus";
import { SummaryCard } from "../common/SummaryCard";

const TIME_INTERVAL_SECONDS = 40;

export const OngoingConversationsSummaryCard = ({
	projectId,
}: {
	projectId: string;
}) => {
	// FIXME: could potentially use the "Aggregate" API to just get the count
	const conversationChunksQuery = useQuery({
		queryFn: async () => {
			const chunks = await directus.request(
				readItems("conversation_chunk", {
					fields: ["conversation_id"],
					filter: {
						conversation_id: {
							project_id: projectId,
						},
						source: {
							_nin: ["DASHBOARD_UPLOAD", "CLONE"],
						},
						timestamp: {
							// @ts-expect-error gt is not typed
							_gt: new Date(
								Date.now() - TIME_INTERVAL_SECONDS * 1000,
							).toISOString(),
						},
					},
				}),
			);

			const uniqueConversations = new Set(
				chunks.map((chunk) => chunk.conversation_id),
			);

			return uniqueConversations.size;
		},
		queryKey: ["conversation_chunks", projectId],
		refetchInterval: 30000,
	});

	return (
		<SummaryCard
			icon={<IconUsersGroup size={24} />}
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
