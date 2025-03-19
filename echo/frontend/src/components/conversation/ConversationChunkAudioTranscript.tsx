import { t } from "@lingui/core/macro";
import { Text, Divider } from "@mantine/core";

import { BaseMessage } from "../chat/BaseMessage";
import { getConversationChunkContentLink } from "@/lib/api";

export const ConversationChunkAudioTranscript = ({
  chunk,
  showAudioPlayer = true,
}: {
  chunk: ConversationChunk;
  showAudioPlayer?: boolean;
}) => {
  const src = getConversationChunkContentLink(
    chunk.conversation_id as string,
    chunk.id,
  );
  return (
    <BaseMessage
      title={t`Speaker`}
      rightSection={
        <span className="text-sm">
          {new Date(chunk.timestamp).toLocaleTimeString()}
        </span>
      }
      bottomSection={
        showAudioPlayer ? (
          <>
            <Divider />
            <audio
              src={src}
              className="h-6 w-full p-0"
              preload=""
              crossOrigin="use-credentials"
              controls
            />
          </>
        ) : (
          <> </>
        )
      }
    >
      {/* {chunk.processing_error ? (
        <p className="text-red-500">Transcription error</p>
      ) : chunk.processing_status === "PROCESSING" ? (
        <LoadingOverlay visible />
      ) : ( */}
      <Text>{chunk.transcript ?? ""}</Text>
      {/* )} */}
    </BaseMessage>
  );
};
