import { useEffect, useState } from "react";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import {
	VOICE_LEVEL_SAMPLE_MS,
	VOICE_WAVEFORM_BARS,
} from "@/components/voice/voiceInput";

/** The live level meter, on the portal's recording screen.
 *
 * The chat composer's waveform, fed by the portal's own recorder. It polls
 * rather than subscribing so the samples land in this component's state and
 * nothing above it re-renders eight times a second while somebody talks.
 *
 * `peekAudioLevel` is the non-resetting read: the liveness beacon keeps the
 * destructive one, and drawing the meter cannot take a sample away from it.
 */
export const ParticipantRecordingWaveform = ({
	peekAudioLevel,
}: {
	peekAudioLevel?: () => number;
}) => {
	const [levels, setLevels] = useState<number[]>([]);

	useEffect(() => {
		if (!peekAudioLevel) return;
		const id = setInterval(() => {
			setLevels((previous) =>
				[...previous, peekAudioLevel()].slice(-VOICE_WAVEFORM_BARS),
			);
		}, VOICE_LEVEL_SAMPLE_MS);
		return () => clearInterval(id);
	}, [peekAudioLevel]);

	if (!peekAudioLevel) return null;

	// Twice the swing of the composer's meter. This one sits above the timer at
	// arm's length on a phone on a table, not under the reader's nose.
	return <VoiceWaveform className="w-full" gain={2} levels={levels} />;
};
