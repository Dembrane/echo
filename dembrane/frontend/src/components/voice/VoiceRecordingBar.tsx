import { Trans } from "@lingui/react/macro";
import { Group, Loader, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";
import { VoiceWaveform } from "./VoiceWaveform";
import { formatElapsed } from "./voiceInput";

/** What stands in for the text input while a voice note is being taken.
 *
 * Sized to roughly the height of the two-row composer so swapping one for the
 * other does not make the whole panel jump.
 */
export const VoiceRecordingBar = ({
	elapsedMs,
	isTranscribing,
	levels,
}: {
	elapsedMs: number;
	isTranscribing: boolean;
	levels: number[];
}) => (
	<Group
		align="center"
		className="min-h-[68px] px-1 py-2"
		gap="sm"
		wrap="nowrap"
		{...testId("chat-voice-recording-bar")}
	>
		{isTranscribing ? (
			<>
				<Loader size={18} />
				<Text role="status" size="sm">
					<Trans>Turning your voice note into text</Trans>
				</Text>
			</>
		) : (
			<>
				<Text role="status" size="sm">
					<Trans>Recording</Trans>
				</Text>
				<VoiceWaveform className="flex-1" levels={levels} />
				<Text size="sm" {...testId("chat-voice-elapsed")}>
					{formatElapsed(elapsedMs)}
				</Text>
			</>
		)}
	</Group>
);
