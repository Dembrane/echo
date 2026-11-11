import { t } from "@lingui/core/macro";
import { ActionIcon, Group, Stack, Text, Tooltip } from "@mantine/core";
import { ArrowClockwise, ArrowCounterClockwise } from "@phosphor-icons/react";
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

	// Jumps within the recording, never past either end; it plays on if it was playing.
	const skip = (seconds: number) => {
		const audio = audioRef.current;
		if (!audio) return;
		const end = Number.isFinite(audio.duration)
			? audio.duration
			: audio.currentTime + seconds;
		audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), end);
		setStarted(true);
	};

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
				<Group gap={4} wrap="nowrap">
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
					<SkipButton
						label={t`Back 15 seconds`}
						onClick={() => skip(-SKIP_SECONDS)}
					>
						<ArrowCounterClockwise size={18} />
					</SkipButton>
					<SkipButton
						label={t`Forward 15 seconds`}
						onClick={() => skip(SKIP_SECONDS)}
					>
						<ArrowClockwise size={18} />
					</SkipButton>
				</Group>
			</div>
		</Stack>
	);
};

const SKIP_SECONDS = 15;

/** A round button with the number of seconds under the arrow, as players show it. */
function SkipButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip label={label}>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="lg"
				aria-label={label}
				onClick={onClick}
				style={{ flexShrink: 0 }}
			>
				<span style={{ display: "inline-flex", position: "relative" }}>
					{children}
					<span
						style={{
							display: "grid",
							fontSize: 7,
							fontWeight: 600,
							inset: 0,
							paddingTop: 1,
							placeItems: "center",
							position: "absolute",
						}}
					>
						{SKIP_SECONDS}
					</span>
				</span>
			</ActionIcon>
		</Tooltip>
	);
}
