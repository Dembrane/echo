import { Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { RedactedText } from "../common/RedactedText";
import {
	activeSentenceIndex,
	type FinalSentence,
	paragraphs,
} from "./sentences";

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
	const activeRef = useRef<HTMLSpanElement | null>(null);

	// Follow the audio: the sentence in play stays in view, without jumping the page for
	// a person who is reading elsewhere (nearest only moves when it is out of view).
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the sentence changes
	useEffect(() => {
		if (active < 0 || audioRef.current?.paused) return;
		activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [active]);

	const seek = (start: number) => {
		const audio = audioRef.current;
		if (!audio) return;
		audio.currentTime = start;
		void audio.play().catch(() => undefined);
	};

	if (!timed) {
		return (
			<Text className="reading-measure" style={{ whiteSpace: "pre-wrap" }}>
				<RedactedText>{text}</RedactedText>
			</Text>
		);
	}

	return (
		<Stack gap="md">
			<Stack
				gap="sm"
				className="reading-measure"
				data-testid="final-transcript-text"
			>
				{paragraphs(sentences).map((para) => (
					<Text key={para[0]?.index} lh={1.8}>
						{para.map(({ sentence: s, index: i }) => (
							<span key={`${s.start}-${i}`}>
								{/* biome-ignore lint/a11y/useSemanticElements: a button is a box and breaks the line at every segment; a span lets the text flow */}
								<span
									role="button"
									tabIndex={0}
									ref={i === active ? activeRef : undefined}
									onClick={() => seek(s.start)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											seek(s.start);
										}
									}}
									className={cn(
										"cursor-pointer rounded-sm transition-colors hover:bg-[var(--app-action-tint)]",
										i === active && "bg-[var(--app-action-tint)]",
									)}
									data-active={i === active}
								>
									{s.text.trim()}
								</span>{" "}
							</span>
						))}
					</Text>
				))}
			</Stack>
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
