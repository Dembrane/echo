import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Divider, Skeleton, Text } from "@mantine/core";
import { cn } from "@/lib/utils";
import { BaseMessage } from "../chat/BaseMessage";
import { RedactedText } from "../common/RedactedText";
import { useConversationChunkContentUrl } from "./hooks";
import { LockedTranscriptOverlay } from "./LockedTranscriptOverlay";

export const ConversationChunkAudioTranscript = ({
	chunk,
	showAudioPlayer = true,
	transcriptLocked = false,
	highlighted = false,
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
	highlighted?: boolean;
}) => {
	const audioUrlQuery = useConversationChunkContentUrl(
		chunk.conversation_id as string,
		chunk.id,
		showAudioPlayer && !!chunk.path,
	);

	return (
		<BaseMessage
			paperProps={{
				className: cn(
					"scroll-mt-24 transition-colors duration-300",
					highlighted && "!bg-[var(--app-action-tint)]",
				),
			}}
			title={
				<Text span size="sm" c="dimmed">
					{new Date(chunk.timestamp).toLocaleTimeString()}
				</Text>
			}
			bottomSection={
				showAudioPlayer && (
					<>
						<Divider />
						{!chunk.path ? (
							<Text size="xs" px="sm" c="dimmed">
								<Trans>Submitted via text input</Trans>
							</Text>
						) : audioUrlQuery.isLoading ? (
							<Skeleton height={36} width="100%" />
						) : audioUrlQuery.isError ? (
							<Text size="xs" c="dimmed">
								<Trans>
									Failed to load audio or the audio is not available
								</Trans>
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
						<Text span c="dimmed" className="italic">
							{t`Unable to process this chunk`}
						</Text>
					) : !chunk.transcript ? (
						<Text span c="dimmed" className="italic">
							{t`Transcribing...`}
						</Text>
					) : (
						<RedactedText>{chunk.transcript}</RedactedText>
					)}
				</Text>
			)}
		</BaseMessage>
	);
};
