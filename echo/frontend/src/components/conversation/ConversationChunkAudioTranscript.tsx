import { t } from "@lingui/core/macro";
import { Text, Divider, Skeleton, ActionIcon, Modal } from "@mantine/core";

import { BaseMessage } from "../chat/BaseMessage";
import { useConversationChunkContentUrl } from "./hooks";
import { IconInfoCircle } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import DiffViewer from "../common/DiffViewer";
import { useEffect, useState } from "react";

export const ConversationChunkAudioTranscript = ({
  chunk,
  showAudioPlayer = true,
}: {
  chunk: {
    conversation_id: string;
    id: string;
    path: string;
    timestamp: string;
    transcript: string;
    error?: string | null;
    diarization?: any;
  };
  showAudioPlayer?: boolean;
}) => {
  const audioUrlQuery = useConversationChunkContentUrl(
    chunk.conversation_id as string,
    chunk.id,
    showAudioPlayer && !!chunk.path,
  );

  const [rawTranscript, setRawTranscript] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (chunk.diarization) {
      const data = chunk.diarization;
      if (data.schema === "Dembrane-25-09") {
        setRawTranscript(data.data.raw.text);
        setNote(data.data.note);
      }
    }
  }, [chunk.diarization]);

  const [
    diarizationModalOpened,
    { open: openDiarizationModal, close: closeDiarizationModal },
  ] = useDisclosure(false);

  return (
    <BaseMessage
      title={t`Audio`}
      rightSection={
        <div className="flex items-center gap-2">
          <span className="text-sm">
            {new Date(chunk.timestamp).toLocaleTimeString()}
          </span>

          {rawTranscript && (
            <ActionIcon
              onClick={openDiarizationModal}
              variant="transparent"
              color="gray"
              size="xs"
            >
              <IconInfoCircle />
            </ActionIcon>
          )}
        </div>
      }
      bottomSection={
        showAudioPlayer ? (
          <>
            <Divider />
            {!chunk.path ? (
              <Text size="xs" className="px-2" color="gray">
                Submitted via text input
              </Text>
            ) : audioUrlQuery.isLoading ? (
              <Skeleton height={36} width="100%" />
            ) : audioUrlQuery.isError ? (
              <Text size="xs" c="gray">
                Failed to load audio or the audio is not available
              </Text>
            ) : (
              <audio
                src={audioUrlQuery.data}
                className="h-6 w-full p-0"
                preload="none"
                controls
              />
            )}
          </>
        ) : (
          <> </>
        )
      }
    >
      <Text>
        {chunk.transcript && chunk.transcript.trim().length > 0 ? (
          chunk.transcript
        ) : chunk.error ? (
          <span className="italic text-gray-500">{t`Transcript not available`}</span>
        ) : (
          <span className="italic text-gray-500">{t`Transcription in progress…`}</span>
        )}
      </Text>
      {rawTranscript && (
        <Modal
          title="Diff Viewer"
          opened={diarizationModalOpened}
          onClose={closeDiarizationModal}
          fullScreen
        >
          <DiffViewer
            className="h-full"
            leftTitle="Raw Transcript"
            rightTitle="Enhanced Transcript"
            note={note ?? ""}
            leftText={rawTranscript ?? ""}
            rightText={chunk.transcript ?? ""}
            topStickyContent={
              <div className="p-3 flex flex-col gap-2">
                {!chunk.path ? (
                  <Text size="xs" className="px-2" color="gray">
                    Submitted via text input
                  </Text>
                ) : audioUrlQuery.isLoading ? (
                  <Skeleton height={36} width="100%" />
                ) : audioUrlQuery.isError ? (
                  <Text size="xs" c="gray">
                    Failed to load audio or the audio is not available
                  </Text>
                ) : (
                  <audio
                    src={audioUrlQuery.data}
                    className="h-6 w-full p-0"
                    preload="none"
                    controls
                  />
                )}
                <Divider className="mt-1" />
              </div>
            }
          />
        </Modal>
      )}
    </BaseMessage>
  );
};
