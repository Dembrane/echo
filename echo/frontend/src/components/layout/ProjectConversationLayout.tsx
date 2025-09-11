import { t } from "@lingui/core/macro";
import { Stack, Title } from "@mantine/core";
import { useParams } from "react-router";
import { TabsWithRouter } from "./TabsWithRouter";
import { ConversationStatusIndicators } from "../conversation/ConversationAccordion";
import { CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS, useConversationById } from "../conversation/hooks";

export const ProjectConversationLayout = () => {
  const { conversationId } = useParams<{ conversationId: string }>();

  const conversationQuery = useConversationById({
    conversationId: conversationId ?? "",
    query: {
      fields: [...CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS, { chunks: ["transcript"] }],
      deep: {
        // @ts-expect-error chunks is not typed
        chunks: {
          _limit: 25,
        },
      },
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
          { value: "overview", label: t`Overview` },
          { value: "transcript", label: t`Transcript` },
          // { value: "analysis", label: t`Analysis` },
        ]}
        loading={false}
      />
    </Stack>
  );
};
