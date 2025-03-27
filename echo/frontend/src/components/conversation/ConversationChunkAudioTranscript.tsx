import { t } from "@lingui/core/macro";
import { Text, Divider, Skeleton } from "@mantine/core";

import { BaseMessage } from "../chat/BaseMessage";
import { useConversationChunkContentUrl } from "@/lib/query";

export const ConversationChunkAudioTranscript = ({
  chunk,
  showAudioPlayer = true,
}: {
  chunk: ConversationChunk;
  showAudioPlayer?: boolean;
}) => {
  // Fetch the direct audio URL instead of using a redirect
  const audioUrlQuery = useConversationChunkContentUrl(
    chunk.conversation_id as string,
    chunk.id,
    showAudioPlayer, // Only fetch if we need to show the player
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
            {audioUrlQuery.isLoading ? (
              <Skeleton height={36} width="100%" />
            ) : audioUrlQuery.isError ? (
              <Text size="xs" color="red">
                Failed to load audio
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
