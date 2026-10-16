import { Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { RedactedText } from "../common/RedactedText";
import { activeSentenceIndex, type FinalSentence } from "./sentences";

/**
 * The final transcript as running text. With timed sentences and the merged audio the
 * sentence being played is highlighted and a click on one seeks to it; the player stays at
 * the bottom of the screen while the text scrolls. An anonymised conversation has text only.
 */
export const FinalTranscript = ({
	text,
	sentences,
	audioUrl,
}: {
	text: string;
	sentences: FinalSentence[];
	audioUrl: string | null;
}) => {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [time, setTime] = useState(0);
	// Nothing is highlighted until the audio has been played: at rest the first sentence is not "the one being read".
	const [started, setStarted] = useState(false);
	const timed = Boolean(audioUrl) && sentences.length > 0;
	const active = timed && started ? activeSentenceIndex(sentences, time) : -1;
	const activeRef = useRef<HTMLButtonElement | null>(null);

	// Follow the audio: the sentence in play stays in view, without jumping the page for
	// a person who is reading elsewhere (nearest only moves when it is out of view).
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the sentence changes
	useEffect(() => {
		if (active < 0 || audioRef.current?.paused) return;
		activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [active]);

	const seek = (start: number) => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.currentTime = start;
		void audio.play().catch(() => undefined);
	};

	if (!timed) {
		return (
			<Text style={{ whiteSpace: "pre-wrap" }}>
				<RedactedText>{text}</RedactedText>
			</Text>
		);
	}

	return (
		<Stack gap="md">
			<Text lh={1.8} data-testid="final-transcript-text">
				{sentences.map((s, i) => (
					<span key={`${s.start}-${i}`}>
						<button
							type="button"
							ref={i === active ? activeRef : undefined}
							onClick={() => seek(s.start)}
							className={cn(
								"cursor-pointer rounded-sm border-0 bg-transparent px-0.5 text-left align-baseline font-[inherit] text-[inherit] leading-[inherit] transition-colors hover:bg-[var(--app-action-tint)]",
								i === active && "bg-[var(--app-action-tint)]",
							)}
							data-active={i === active}
						>
							{s.text}
						</button>{" "}
					</span>
				))}
			</Text>
			<div
				className="sticky bottom-0 z-20 py-2"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				{/* biome-ignore lint/a11y/useMediaCaption: the transcript is the text above */}
				<audio
					ref={audioRef}
					src={audioUrl ?? undefined}
					className="h-10 w-full"
					preload="metadata"
					controls
					onPlay={() => setStarted(true)}
					onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
					onSeeked={(e) => setTime(e.currentTarget.currentTime)}
				/>
			</div>
		</Stack>
	);
};
