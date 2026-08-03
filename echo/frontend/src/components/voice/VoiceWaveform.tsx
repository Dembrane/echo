import { useReducedMotion } from "@mantine/hooks";
import { testId } from "@/lib/testUtils";
import { VOICE_WAVEFORM_BARS, waveformHeights } from "./voiceInput";

/** A live level meter for a recording in progress.
 *
 * Decorative: it proves audio is reaching the browser, which a spinner cannot.
 * The liveness a screen reader needs comes from the status text and the timer
 * beside it, so this is hidden from the accessibility tree.
 *
 * Under `prefers-reduced-motion` the bars stop moving entirely and settle at a
 * fixed height. Nothing is lost, because the elapsed timer next to it ticks
 * every second and is the honest proof that recording is still running.
 */
export const VoiceWaveform = ({
	className,
	levels,
}: {
	className?: string;
	levels: number[];
}) => {
	const reduceMotion = useReducedMotion();
	const heights = reduceMotion
		? Array<number>(VOICE_WAVEFORM_BARS).fill(30)
		: waveformHeights(levels);

	return (
		<div
			aria-hidden="true"
			className={`flex h-8 items-center gap-[3px] ${className ?? ""}`}
			{...testId("chat-voice-waveform")}
		>
			{heights.map((height, index) => (
				<div
					className="flex-1 rounded-full"
					// biome-ignore lint/suspicious/noArrayIndexKey: bars are positions in a fixed-length meter, not data
					key={index}
					style={{
						backgroundColor: "var(--mantine-color-primary-6)",
						height: `${height}%`,
						minHeight: "2px",
						transition: reduceMotion ? undefined : "height 90ms linear",
					}}
				/>
			))}
		</div>
	);
};
