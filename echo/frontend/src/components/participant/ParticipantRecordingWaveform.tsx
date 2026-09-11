import { useEffect, useRef, useState } from "react";
import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import {
	VOICE_LEVEL_SAMPLE_MS,
	VOICE_WAVEFORM_BARS,
} from "@/components/voice/voiceInput";

/** What the meter is reporting, worst case first.
 *
 * `problem` is the recording itself failing: nothing reaching the microphone,
 * or a run that was interrupted. `unhealthy` is the connection: the recording
 * is fine, getting it to dembrane is not. */
export type RecordingMeterStatus = "healthy" | "unhealthy" | "problem";

const METER_COLORS: Record<RecordingMeterStatus, string> = {
	healthy: "var(--mantine-color-primary-6)",
	problem: "var(--mantine-color-red-6)",
	unhealthy: "var(--mantine-color-yellow-6)",
};

/** Below this the microphone is producing nothing at all.
 *
 * Not "nobody is talking": a live microphone in a silent room still returns
 * room tone well above this. A muted, unplugged, or stolen-by-another-app
 * microphone returns a flat signal, which is what this catches. */
const SILENT_LEVEL = 0.002;

/** How long that has to hold before we say so. Long enough to sit through a
 * pause in the conversation, short enough that somebody who is talking into a
 * dead microphone finds out while they still remember what they said. */
const SILENCE_MS = 8000;

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
	onSilence,
	peekAudioLevel,
	status = "healthy",
}: {
	/** Called once when the microphone goes quiet and stays quiet. Fires again
	 * only after sound has returned, so it cannot pester somebody who has
	 * already dismissed whatever it opened. */
	onSilence?: () => void;
	peekAudioLevel?: () => number;
	status?: RecordingMeterStatus;
}) => {
	const [levels, setLevels] = useState<number[]>([]);
	const [isSilent, setIsSilent] = useState(false);

	const silentSinceRef = useRef<number | null>(null);
	const reportedRef = useRef(false);
	const onSilenceRef = useRef(onSilence);
	onSilenceRef.current = onSilence;

	useEffect(() => {
		if (!peekAudioLevel) return;

		const id = setInterval(() => {
			const level = peekAudioLevel();
			setLevels((previous) => [...previous, level].slice(-VOICE_WAVEFORM_BARS));

			if (level > SILENT_LEVEL) {
				silentSinceRef.current = null;
				reportedRef.current = false;
				setIsSilent(false);
				return;
			}

			silentSinceRef.current ??= Date.now();
			if (Date.now() - silentSinceRef.current < SILENCE_MS) return;

			setIsSilent(true);
			if (reportedRef.current) return;
			reportedRef.current = true;
			onSilenceRef.current?.();
		}, VOICE_LEVEL_SAMPLE_MS);

		return () => clearInterval(id);
	}, [peekAudioLevel]);

	if (!peekAudioLevel) return null;

	// Twice the swing of the composer's meter. This one sits above the timer at
	// arm's length on a phone on a table, not under the reader's nose.
	return (
		<VoiceWaveform
			className="w-full"
			color={METER_COLORS[isSilent ? "problem" : status]}
			gain={2}
			levels={levels}
		/>
	);
};
