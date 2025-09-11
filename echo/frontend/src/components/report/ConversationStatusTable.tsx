import { Trans } from "@lingui/react/macro";
import { Anchor, Table, Text } from "@mantine/core";
import { useProjectConversationCounts } from "@/components/report/hooks";
import { Link } from "react-router";

interface Conversation {
  id: string;
  is_finished: boolean;
  participant_name?: string | null;
  summary?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export const ConversationStatusTable = ({
  projectId,
}: {
  projectId: string;
}) => {
  const { data } = useProjectConversationCounts(projectId);

  if (!data) return null;

  // Merge finished and pending into one list for easier iteration
  const conversations = [
    ...(data.finishedConversations ?? []),
    ...(data.pendingConversations ?? []),
  ] as Conversation[];

  if (conversations.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        <Trans>No conversations found.</Trans>
      </Text>
    );
  }

  // Sort by status (pending first) then by updated_at desc (fallback created_at)
  conversations.sort((a, b) => {
    // First sort by status: pending (false) comes before finished (true)
    if (a.is_finished !== b.is_finished) {
      return a.is_finished ? 1 : -1;
    }
    // Then sort by date: most recent first
    const dateA = new Date(a.updated_at ?? a.created_at ?? 0).getTime();
    const dateB = new Date(b.updated_at ?? b.created_at ?? 0).getTime();
    return dateB - dateA;
  });

  return (
    <Table highlightOnHover withTableBorder withColumnBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>
            <Trans>Participant</Trans>
          </Table.Th>
          <Table.Th>
            <Trans>Last Updated</Trans>
          </Table.Th>
          <Table.Th>
            <Trans>Status</Trans>
          </Table.Th>
          <Table.Th>
            <Trans>Link</Trans>
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {conversations.map((conv) => (
          <Table.Tr key={conv.id}>
            <Table.Td>{conv.participant_name ?? "-"}</Table.Td>
            <Table.Td>
              {conv.updated_at || conv.created_at
                ? new Date(conv.updated_at ?? conv.created_at!).toLocaleString()
                : "-"}
            </Table.Td>
            <Table.Td>
              {conv.is_finished ? (
                <Text c="green.6">
                  <Trans>Finished</Trans>
                </Text>
              ) : (
                <Text c="yellow.7">
                  <Trans>Pending</Trans>
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              <Anchor
                component={Link}
                to={`/projects/${projectId}/conversation/${conv.id}/overview`}
              >
                <Trans>View</Trans>
              </Anchor>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
};
