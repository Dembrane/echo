import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { InformationTooltip } from "@/components/common/InformationTooltip";
import {
  useConversationById,
  useInfiniteConversationChunks,
  useRetranscribeConversationMutation,
  useConversationTranscriptString,
} from "@/components/conversation/hooks";
import {
  ActionIcon,
  Group,
  Stack,
  Tooltip,
  Skeleton,
  Title,
  Modal,
  Button,
  TextInput,
  CopyButton,
  Switch,
  Alert,
  Text,
  Badge,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconAlertCircle,
  IconRefresh,
} from "@tabler/icons-react";

import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import useSessionStorageState from "use-session-storage-state";
import { useInView } from "react-intersection-observer";
import { ConversationChunkAudioTranscript } from "@/components/conversation/ConversationChunkAudioTranscript";
import { ExponentialProgress } from "@/components/common/ExponentialProgress";
import { CloseableAlert } from "@/components/common/ClosableAlert";

export const ProjectConversationTranscript = () => {
  const { conversationId } = useParams();
  const conversationQuery = useConversationById({
    conversationId: conversationId ?? "",
    loadConversationChunks: true,
  });

  const { ref: loadMoreRef, inView } = useInView();

  const {
    data: chunksData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
  } = useInfiniteConversationChunks(conversationId ?? "");

  const transcriptQuery = useConversationTranscriptString(conversationId ?? "");

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Download modal
  const [downloadOpened, { open: openDownload, close: closeDownload }] =
    useDisclosure(false);
  const [filename, setFilename] = useState("");

  // Retranscribe modal
  const [
    retranscribeOpened,
    { open: openRetranscribe, close: closeRetranscribe },
  ] = useDisclosure(false);
  const [newConversationName, setNewConversationName] = useState("");
  const retranscribeMutation = useRetranscribeConversationMutation();

  // Set the default new conversation name when the conversation data is loaded
  useEffect(() => {
    if (conversationQuery.data?.participant_name) {
      setNewConversationName(conversationQuery.data.participant_name);
    }
  }, [conversationQuery.data]);

  const [showAudioPlayer, setShowAudioPlayer] = useSessionStorageState<boolean>(
    "conversation-transcript-show-audio-player",
    {
      defaultValue: false,
    },
  );

  if (status === "pending") {
    return (
      <Stack>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={200} />
        ))}
      </Stack>
    );
  }

  const allChunks = chunksData?.pages.flatMap((page) => page.chunks) ?? [];

  const hasValidTranscripts = allChunks.some(
    (chunk) => chunk.transcript && chunk.transcript.trim().length > 0,
  );

  const isEmptyConversation =
    !hasValidTranscripts && conversationQuery.data?.is_finished;

  const handleDownloadTranscript = (filename: string) => {
    const text = transcriptQuery.data ?? "";
    const blob = new Blob([text], { type: "text/markdown" });

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    if (conversationQuery.data) {
      if (filename != "") {
        a.download = filename;
      } else {
        a.download =
          "Conversation" +
          "-" +
          conversationQuery.data.participant_email +
          ".md";
      }
    }

    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleRetranscribe = async () => {
    if (!conversationId || !newConversationName.trim()) return;

    const result = await retranscribeMutation.mutateAsync({
      conversationId,
      newConversationName: newConversationName.trim(),
    });

    closeRetranscribe();
  };

  // Add function to check if conversation is older than 30 days
  const isAudioExpired = () => {
    if (!conversationQuery.data?.created_at) return false;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return new Date(conversationQuery.data.created_at) < thirtyDaysAgo;
  };

  return (
    <Stack>
      <Stack>
        <Group justify="space-between">
          <Group>
            {" "}
            <Title order={2}>
              <Trans>Transcript</Trans>
            </Title>
            {isEmptyConversation && (
              <Badge color="red" variant="light">
                <Trans>Empty</Trans>
              </Badge>
            )}
            {/* open the download modal */}
            <Tooltip label={t`Download transcript`}>
              <ActionIcon
                onClick={openDownload}
                size="md"
                variant="subtle"
                color="gray"
              >
                <IconDownload size={48} />
              </ActionIcon>
            </Tooltip>
            <CopyButton value={transcriptQuery.data ?? ""}>
              {({ copied, copy }) => (
                <Tooltip label={t`Copy transcript`}>
                  <ActionIcon
                    size="md"
                    variant="subtle"
                    color="gray"
                    loading={transcriptQuery.isLoading}
                    onClick={copy}
                  >
                    {!copied ? <IconCopy size={48} /> : <IconCheck size={48} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
            {/* Retranscribe button */}
            <Tooltip label={t`Retranscribe conversation`}>
              <ActionIcon
                onClick={openRetranscribe}
                size="md"
                variant="subtle"
                color="gray"
                disabled={isAudioExpired()}
              >
                <IconRefresh size={48} />
              </ActionIcon>
            </Tooltip>
          </Group>

          <Group>
            <Switch
              checked={showAudioPlayer}
              onChange={(event) =>
                setShowAudioPlayer(event.currentTarget.checked)
              }
              label={t`Show audio player`}
              disabled={isAudioExpired()}
            />
            <InformationTooltip
              label={t`Audio recordings are scheduled to be deleted after 30 days from the recording date`}
            />
          </Group>
        </Group>

        {/* Download Modal */}
        <Modal
          opened={downloadOpened}
          onClose={closeDownload}
          title={t`Download Transcript Options`}
        >
          <Stack>
            <TextInput
              label={t`Custom Filename`}
              placeholder="ConversationTitle-Email.md"
              value={filename}
              onChange={(event) => setFilename(event.currentTarget.value)}
            />
            <Button
              onClick={() => {
                handleDownloadTranscript(filename);
                closeDownload();
              }}
              rightSection={<IconDownload />}
            >
              <Trans>Download</Trans>
            </Button>
          </Stack>
        </Modal>

        {/* Retranscribe Modal */}
        <Modal
          opened={retranscribeOpened}
          onClose={closeRetranscribe}
          title={
            <Group gap="xs">
              <Text>{t`Retranscribe Conversation`}</Text>
              <Badge color="blue" size="sm">
                <Trans>Experimental</Trans>
              </Badge>
            </Group>
          }
        >
          {retranscribeMutation.isPending ? (
            <Stack>
              <Alert title={t`Processing your retranscription request...`}>
                <Trans>
                  Please wait while we process your retranscription request. You
                  will be redirected to the new conversation when ready.
                </Trans>
              </Alert>
              <ExponentialProgress expectedDuration={30} isLoading={true} />
            </Stack>
          ) : (
            <Stack>
              <Alert>
                <Trans>
                  This will create a new conversation with the same audio but a
                  fresh transcription. The original conversation will remain
                  unchanged.
                </Trans>
              </Alert>
              <TextInput
                label={t`New Conversation Name`}
                placeholder={t`Enter a name for the new conversation`}
                value={newConversationName}
                onChange={(event) =>
                  setNewConversationName(event.currentTarget.value)
                }
                required
              />
              <Button
                onClick={handleRetranscribe}
                rightSection={<IconRefresh size="1rem" />}
                disabled={!newConversationName.trim()}
              >
                <Trans>Retranscribe</Trans>
              </Button>
            </Stack>
          )}
        </Modal>

        <Stack>
          {allChunks.length === 0 ? (
            <Alert
              icon={<IconAlertCircle size={16} />}
              title={t`No Transcript Available`}
              color="gray"
            >
              <Trans>
                No transcript exists for this conversation yet. Please check
                back later.
              </Trans>
            </Alert>
          ) : (
            // !hasValidTranscripts ? (
            //   <Alert
            //     icon={<IconAlertCircle size={16} />}
            //     title={t`Processing Transcript`}
            //     color="gray"
            //   >
            //     <Trans>
            //       The transcript for this conversation is being processed. Please
            //       check back later.
            //     </Trans>
            //   </Alert>
            // ) :
            allChunks.map((chunk, index, array) => {
              const isLastChunk = index === array.length - 1;
              return (
                <div key={chunk.id} ref={isLastChunk ? loadMoreRef : undefined}>
                  <ConversationChunkAudioTranscript
                    chunk={chunk}
                    showAudioPlayer={showAudioPlayer}
                  />
                </div>
              );
            })
          )}
          {isFetchingNextPage && (
            <Stack>
              {[0, 1].map((i) => (
                <Skeleton key={i} height={200} />
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
};
