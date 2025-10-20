import { t } from "@lingui/core/macro";
import { Stack, Title } from "@mantine/core";
import { useParams } from "react-router";
import { ConversationStatusIndicators } from "../conversation/ConversationAccordion";
import {
	CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS,
	useConversationById,
} from "../conversation/hooks";
import { TabsWithRouter } from "./TabsWithRouter";

export const ProjectConversationLayout = () => {
	const { conversationId } = useParams<{ conversationId: string }>();

	const conversationQuery = useConversationById({
		conversationId: conversationId ?? "",
		query: {
			deep: {
				// @ts-expect-error chunks is not typed
				chunks: {
					_limit: 25,
				},
			},
			fields: [
				...CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS,
				{ chunks: ["transcript"] },
			],
		},
	});

	return (
		<Stack className="relative px-2 py-4">
			<Title order={1}>
				{conversationQuery.data?.participant_name ?? "Conversation"}
			</Title>
			{conversationQuery.data && (
				<ConversationStatusIndicators
					conversation={conversationQuery.data}
					showDuration={true}
				/>
			)}
			<TabsWithRouter
				basePath="/projects/:projectId/conversation/:conversationId"
				tabs={[
					{ label: t`Overview`, value: "overview" },
					{ label: t`Transcript`, value: "transcript" },
					// { value: "analysis", label: t`Analysis` },
				]}
				loading={false}
			/>
		</Stack>
	);
};
