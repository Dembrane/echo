import {
  Button,
  Divider,
  Group,
  Stack,
  Title,
  Accordion,
  Table,
  Badge,
  Text,
  Modal,
  ScrollArea,
} from "@mantine/core";
import { toast } from "@/components/common/Toaster";
import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  useConversationById,
  useCurrentUser,
  useProcessingStatus,
  useProjectById,
  useProjectChats,
} from "@/lib/query";
import {
  ENABLE_CHAT_AUTO_SELECT,
  API_BASE_URL,
  DIRECTUS_PUBLIC_URL,
  ADMIN_BASE_URL,
  PARTICIPANT_BASE_URL,
  BUILD_VERSION,
  DIRECTUS_CONTENT_PUBLIC_URL,
  SUPPORTED_LANGUAGES,
} from "@/config";
import { format, parseISO } from "date-fns";

const Logs = ({ data }: { data: ProcessingStatus[] }) => {
  const [selectedLog, setSelectedLog] = useState<ProcessingStatus | null>(null);
  if (!data || data.length === 0) {
    return <Text>No logs available.</Text>;
  }
  // Group entries by event prefix
  const grouped: Record<
    string,
    { status: string; entries: ProcessingStatus[] }
  > = {};
  data.forEach((entry) => {
    if (!entry.event) return;
    const dotIndex = entry.event.lastIndexOf(".");
    const prefix =
      dotIndex !== -1 ? entry.event.substring(0, dotIndex) : entry.event;
    const status = dotIndex !== -1 ? entry.event.substring(dotIndex + 1) : "";
    if (!grouped[prefix]) grouped[prefix] = { status, entries: [] };
    grouped[prefix].entries.push(entry);
  });

  return (
    <>
      <Accordion multiple>
        {Object.entries(grouped).map(([prefix, { status, entries }]) => {
          const latest = entries[0];
          return (
            <Accordion.Item key={prefix} value={prefix}>
              <Accordion.Control>
                <Group
                  style={{
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <Title order={4}>{prefix}</Title>
                    <Text size="xs" color="dimmed">
                      {format(parseISO(latest.timestamp), "PPpp")}
                    </Text>
                  </div>
                  <Badge color={getStatusColor(status)} variant="light">
                    {status}
                  </Badge>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Status</th>
                      <th>Message</th>
                      <th>Duration (s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{format(parseISO(entry.timestamp), "PPpp")}</td>
                        <td>
                          <Badge
                            color={getStatusColor(
                              entry.event?.split(".")?.pop() ?? "",
                            )}
                            variant="filled"
                          >
                            {entry.event?.split(".").pop()}
                          </Badge>
                        </td>
                        <td>
                          {entry.message || entry.json ? (
                            <Text
                              component="span"
                              size="sm"
                              color="blue"
                              style={{ cursor: "pointer" }}
                              onClick={() => setSelectedLog(entry)}
                            >
                              {entry.message ?? "View JSON"}
                            </Text>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>
                          {entry.duration_ms
                            ? (entry.duration_ms / 1000).toFixed(2)
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
      <Modal
        opened={!!selectedLog}
        onClose={() => setSelectedLog(null)}
        title="Log Details"
        size="lg"
      >
        <ScrollArea style={{ height: 400 }}>
          <pre>
            {selectedLog?.json
              ? JSON.stringify(selectedLog.json, null, 2)
              : selectedLog?.message}
          </pre>
        </ScrollArea>
      </Modal>
    </>
  );
};

const getStatusColor = (status: string): string => {
  switch (status.toLowerCase()) {
    case "started":
      return "blue";
    case "processing":
      return "violet";
    case "completed":
      return "green";
    case "failed":
      return "red";
    default:
      return "gray";
  }
};

export default function DebugPage() {
  const ref = useRef<number>(0);
  const handleTestToast = () => {
    if (ref.current === 0) {
      toast.success("Test toast");
    } else if (ref.current === 1) {
      toast.error("Test toast");
    } else if (ref.current === 2) {
      toast.warning("Test toast");
    } else if (ref.current === 3) {
      toast.info("Test toast");
    } else if (ref.current === 4) {
      toast.error("Test toast");
    } else {
      toast("Test toast");
    }

    ref.current++;
  };

  const { projectId, conversationId, chatId } = useParams();

  const { data: user } = useCurrentUser();

  const { data: project } = useProjectById({ projectId: projectId! });

  const { data: conversation } = useConversationById({
    conversationId: conversationId!,
  });

  const { data: chats } = useProjectChats(projectId!, {
    filter: {
      project_id: {
        _eq: projectId,
      },
      "count(project_chat_messages)": {
        // @ts-ignore
        _gt: 0,
      },
    },
  });

  const {
    data: conversationProcessingStatus,
    refetch: refetchConversationProcessingStatus,
  } = useProcessingStatus({
    collectionName: "conversation",
    itemId: conversationId!,
  });

  const variables = {
    DEBUG_MODE: true,
    BUILD_VERSION,
    ff: {
      ENABLE_CHAT_AUTO_SELECT,
      SUPPORTED_LANGUAGES,
    },
    urls: {
      API_BASE_URL,
      DIRECTUS_PUBLIC_URL,
      DIRECTUS_CONTENT_PUBLIC_URL,
      ADMIN_BASE_URL,
      PARTICIPANT_BASE_URL,
    },
  };

  return (
    <Stack className="p-8">
      <Stack>
        <Title order={1}>Debug</Title>
        <Stack>
          <pre>{JSON.stringify(variables, null, 2)}</pre>
        </Stack>
        <div>
          <Button onClick={handleTestToast}>Test Toast</Button>
        </div>
      </Stack>
      <Divider />
      <Stack>
        <Title order={1}>User</Title>
        <pre>{JSON.stringify(user, null, 2)}</pre>
      </Stack>
      <Stack>
        <Title order={1}>Project</Title>
        <pre>{JSON.stringify(project, null, 2)}</pre>
      </Stack>
      <Divider />
      <Stack>
        <Title order={1}>Conversation</Title>
        <pre>{JSON.stringify(conversation, null, 2)}</pre>
        <Group>
          <Title order={3}>Logs</Title>
          <Button onClick={() => refetchConversationProcessingStatus()}>
            Refetch Logs
          </Button>
        </Group>
        <Logs data={conversationProcessingStatus ?? []} />
      </Stack>
      <Divider />
      <Stack>
        <Title order={1}>Chats</Title>
        <pre>{JSON.stringify(chats, null, 2)}</pre>
      </Stack>
    </Stack>
  );
}
