import { t } from "@lingui/core/macro";
import { Divider, Skeleton, Text } from "@mantine/core";

import { BaseMessage } from "../chat/BaseMessage";
import { RedactedText } from "../common/RedactedText";
import { useConversationChunkContentUrl } from "./hooks";
import { LockedTranscriptOverlay } from "./LockedTranscriptOverlay";

export const ConversationChunkAudioTranscript = ({
	chunk,
	showAudioPlayer = true,
	transcriptLocked = false,
}: {
	chunk: {
		conversation_id: string;
		id: string;
		path: string;
		timestamp: string;
		transcript: string;
		error: string;
	};
	showAudioPlayer?: boolean;
	transcriptLocked?: boolean;
}) => {
	const audioUrlQuery = useConversationChunkContentUrl(
		chunk.conversation_id as string,
		chunk.id,
		showAudioPlayer && !!chunk.path,
	);

	return (
		<BaseMessage
			title={
				<span className="text-sm text-gray-500">
					{new Date(chunk.timestamp).toLocaleTimeString()}
				</span>
			}
			bottomSection={
				showAudioPlayer && (
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
							// biome-ignore lint/a11y/useMediaCaption: <transcript is provided to the user>
							<audio
								src={audioUrlQuery.data}
								className="h-6 w-full p-0"
								preload="none"
								controls
							/>
						)}
					</>
				)
			}
		>
		{transcriptLocked ? (
			<LockedTranscriptOverlay compact />
		) : (
			<Text>
			{chunk.error ? (
				<span className="italic text-gray-500">{t`Unable to process this chunk`}</span>
			) : !chunk.transcript ? (
				<span className="italic text-gray-500">{t`Transcribing...`}</span>
			) : (
				<RedactedText>{chunk.transcript}</RedactedText>
			)}
			</Text>
		)}
		</BaseMessage>
	);
};
