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
    showAudioPlayer && !!chunk.path, // Only fetch if we need to show the player
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
            {!chunk.path ? (
              <Text size="xs" className="px-2" color="gray">
                Submitted via text input
              </Text>
            ) : audioUrlQuery.isLoading ? (
              <Skeleton height={36} width="100%" />
            ) : audioUrlQuery.isError ? (
              <Text size="xs" color="gray">
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
