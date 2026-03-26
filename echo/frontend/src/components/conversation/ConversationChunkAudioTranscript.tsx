import { t } from "@lingui/core/macro";
import { Divider, Skeleton, Text } from "@mantine/core";
import { cn } from "@/lib/utils";
import { BaseMessage } from "../chat/BaseMessage";
import { RedactedText } from "../common/RedactedText";
import { useConversationChunkContentUrl } from "./hooks";

export const ConversationChunkAudioTranscript = ({
	chunk,
	showAudioPlayer = true,
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
					highlighted && "!bg-cyan-50 ring-2 ring-cyan-300",
				),
			}}
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
			<Text>
				{chunk.error ? (
					<span className="italic text-gray-500">{t`Unable to process this chunk`}</span>
				) : !chunk.transcript ? (
					<span className="italic text-gray-500">{t`Transcribing...`}</span>
				) : (
					<RedactedText>{chunk.transcript}</RedactedText>
				)}
			</Text>
		</BaseMessage>
	);
};
