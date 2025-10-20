import { t } from "@lingui/core/macro";
import { Box, Progress, Skeleton, Tooltip } from "@mantine/core";
import { ENABLE_CHAT_AUTO_SELECT } from "@/config";
import { capitalize } from "@/lib/utils";
import { useProjectChatContext } from "./hooks";

export const ChatContextProgress = ({ chatId }: { chatId: string }) => {
	const chatContextQuery = useProjectChatContext(chatId);

	if (chatContextQuery.isLoading) {
		return (
			<Skeleton
				height={8}
				style={{
					width: "100%",
				}}
			/>
		);
	}

	if (
		ENABLE_CHAT_AUTO_SELECT &&
		chatContextQuery.data?.auto_select_bool &&
		chatContextQuery.data?.conversations.length === 0
	) {
		return null;
	}

	const conversationsAlreadyAdded = chatContextQuery.data?.conversations
		.filter((c) => c.locked)
		.sort((a, b) => b.token_usage - a.token_usage);

	const conversationsToBeAdded = chatContextQuery.data?.conversations
		.filter((c) => !c.locked)
		.sort((a, b) => b.token_usage - a.token_usage);

	const getColor = (baseColor: string) => {
		if (ENABLE_CHAT_AUTO_SELECT && chatContextQuery.data?.auto_select_bool) {
			return "green.6";
		}

		return baseColor;
	};

	return (
		<Box>
			<Progress.Root size={8}>
				{conversationsAlreadyAdded?.map((m) => (
					<Tooltip
						key={m.conversation_id}
						label={`${m.conversation_participant_name} - ${Math.ceil(
							m.token_usage * 100,
						)}%`}
					>
						<Progress.Section
							value={m.token_usage * 100}
							color={getColor("blue.6")}
							mr="1px"
						/>
					</Tooltip>
				))}

				{conversationsToBeAdded?.map((m) => (
					<Tooltip
						key={m.conversation_id}
						label={`${m.conversation_participant_name} - ${Math.ceil(
							m.token_usage * 100,
						)}%`}
					>
						<Progress.Section
							value={m.token_usage * 100}
							color={getColor("blue.3")}
							mr="1px"
						/>
					</Tooltip>
				))}

				{chatContextQuery.data?.messages.map((m, idx) => (
					<Tooltip
						key={`message-${m.role}-${idx}`}
						label={t`Messages from ${capitalize(m.role)} - ${Math.ceil(m.token_usage * 100)}%`}
					>
						<Progress.Section value={m.token_usage * 100} color="gray.5" />
					</Tooltip>
				))}
			</Progress.Root>
		</Box>
	);
};
