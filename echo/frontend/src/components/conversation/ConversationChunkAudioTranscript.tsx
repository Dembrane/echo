import { t } from "@lingui/core/macro";
import {
	ActionIcon,
	Badge,
	Divider,
	Group,
	Modal,
	Skeleton,
	Switch,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconClockPlay, IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BaseMessage } from "../chat/BaseMessage";
import DiffViewer from "../common/DiffViewer";
import { useConversationChunkContentUrl } from "./hooks";

type Word = { text: string; start: number; end: number; confidence?: number };
type Segment = { id: string; text: string; startSec: number; endSec: number };

function isMs(v: number) {
	return v > 600;
}
function toSec(v: number) {
	return isMs(v) ? v / 1000 : v;
}
function formatTime(sec: number) {
	const s = Math.max(0, Math.floor(sec));
	const m = Math.floor(s / 60);
	const r = s % 60;
	return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
}

function splitSentences(s: string): string[] {
	if (!s?.trim()) return [];
	const matches = s.replace(/\r\n/g, "\n").match(/[^.!?\n]+[.!?]?(?:\s+|$)/g);
	if (!matches) return [s.trim()];
	return matches.map((p) => p.trim()).filter(Boolean);
}

function groupSentencesToParagraphs(
	sentences: string[],
	maxChars = 280,
	maxSentences = 3,
) {
	const paras: string[] = [];
	let cur: string[] = [];
	let curLen = 0;
	for (const s of sentences) {
		if (!s) continue;
		if (cur.length >= maxSentences || curLen + s.length > maxChars) {
			paras.push(cur.join(" "));
			cur = [];
			curLen = 0;
		}
		cur.push(s);
		curLen += s.length + 1;
	}
	if (cur.length) paras.push(cur.join(" "));
	return paras.length ? paras : [sentences.join(" ")];
}

export const ConversationChunkAudioTranscript = ({
	chunk,
	showAudioPlayer = true,
	isActive = false,
	onSeek,
	currentTime,
	chunkOffsetStart = 0,
	legacyView = false,
	precomputedSegments,
}: {
	chunk: {
		conversation_id: string;
		id: string;
		path: string;
		timestamp: string;
		transcript: string;
		error?: string | null;
		diarization?: any;
	};
	showAudioPlayer?: boolean;
	isActive?: boolean;
	onSeek?: (timeSec: number) => void;
	currentTime?: number;
	chunkOffsetStart?: number;
	legacyView?: boolean;
	precomputedSegments?: Segment[];
}) => {
	const audioUrlQuery = useConversationChunkContentUrl(
		chunk.conversation_id as string,
		chunk.id,
		showAudioPlayer && !!chunk.path,
	);

	const localAudioRef = useRef<HTMLAudioElement>(null);

	const [rawTranscript, setRawTranscript] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	// Follow toggle
	const [follow, setFollow] = useState(true);

	// Active segment index for auto-scroll
	const [activeSeg, setActiveSeg] = useState<number>(-1);

	// Raw transcript for Diff modal
	useEffect(() => {
		if (chunk.diarization?.schema === "Dembrane-25-09") {
			const data = chunk.diarization.data;
			setRawTranscript(data?.raw?.text ?? null);
			setNote(data?.note ?? null);
		}
	}, [chunk.diarization]);

	// Choose segments: prefer precomputed
	const segments: Segment[] = useMemo(
		() => precomputedSegments ?? [],
		[precomputedSegments],
	);

	// Playback time helpers
	const absoluteStart = chunkOffsetStart ?? 0;

	const getNow = useCallback(() => {
		if (currentTime != null) return currentTime;
		if (localAudioRef.current) return localAudioRef.current.currentTime;
		return undefined;
	}, [currentTime]);

	// Update active segment on time change
	const updateActiveFromTime = useCallback(() => {
		const now = getNow();
		if (now == null || !segments.length) return;
		const t = now - absoluteStart;
		if (t < 0) return;

		// binary search for performance could replace this
		let idx = -1;
		for (let i = 0; i < segments.length; i++) {
			if (t >= segments[i].startSec && t < segments[i].endSec) {
				idx = i;
				break;
			}
		}
		if (idx !== activeSeg) setActiveSeg(idx);
	}, [getNow, absoluteStart, segments, activeSeg]);

	useEffect(() => {
		updateActiveFromTime();
	}, [currentTime, updateActiveFromTime]);

	useEffect(() => {
		const el = localAudioRef.current;
		if (!el) return;
		const onTime = () => updateActiveFromTime();
		el.addEventListener("timeupdate", onTime);
		return () => el.removeEventListener("timeupdate", onTime);
	}, [updateActiveFromTime]);

	// Auto-scroll to active segment
	useEffect(() => {
		if (!follow || activeSeg < 0) return;
		const node = document.getElementById(`${chunk.id}-seg-${activeSeg}`);
		if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
	}, [activeSeg, follow, chunk.id]);

	// Next/prev paragraph via global keyboard
	useEffect(() => {
		const prev = () => {
			if (!isActive || segments.length === 0) return;
			const target = Math.max(0, activeSeg >= 0 ? activeSeg - 1 : 0);
			const start = segments[target].startSec + absoluteStart;
			if (onSeek) onSeek(start);
			else if (localAudioRef.current) localAudioRef.current.currentTime = start;
		};
		const next = () => {
			if (!isActive || segments.length === 0) return;
			const target = Math.min(
				segments.length - 1,
				activeSeg >= 0 ? activeSeg + 1 : 0,
			);
			const start = segments[target].startSec + absoluteStart;
			if (onSeek) onSeek(start);
			else if (localAudioRef.current) localAudioRef.current.currentTime = start;
		};
		const onPrev = () => prev();
		const onNext = () => next();
		window.addEventListener("dembrane-transcript-prev", onPrev as any);
		window.addEventListener("dembrane-transcript-next", onNext as any);
		return () => {
			window.removeEventListener("dembrane-transcript-prev", onPrev as any);
			window.removeEventListener("dembrane-transcript-next", onNext as any);
		};
	}, [isActive, segments, activeSeg, absoluteStart, onSeek]);

	// Click-to-seek helper
	const seekTo = (seg: Segment) => {
		const absolute = seg.startSec + absoluteStart;
		if (onSeek) onSeek(absolute);
		else if (localAudioRef.current) {
			localAudioRef.current.currentTime = absolute;
			localAudioRef.current.play().catch(() => void 0);
		}
	};

	// Legacy plain rendering
	const renderLegacy = () => {
		if (!chunk.transcript || chunk.transcript.trim().length === 0) {
			return chunk.error ? (
				<span className="italic text-gray-500">{t`Transcript not available`}</span>
			) : (
				<span className="italic text-gray-500">{t`Transcription in progress…`}</span>
			);
		}
		const sentences = splitSentences(chunk.transcript);
		const paragraphs = groupSentencesToParagraphs(sentences);
		return (
			<div className="space-y-4 text-md">
				{paragraphs.map((p, i) => (
					<Text key={i}>{p}</Text>
				))}
			</div>
		);
	};

	const processedRawTranscript = useMemo(() => {
		if (!rawTranscript) return "";
		return splitSentences(rawTranscript).join("\n");
	}, [rawTranscript]);

	const processedEnhancedTranscript = useMemo(() => {
		if (!chunk.transcript) return "";
		return splitSentences(chunk.transcript).join("\n");
	}, [chunk.transcript]);

	const [
		diarizationModalOpened,
		{ open: openDiarizationModal, close: closeDiarizationModal },
	] = useDisclosure(false);

	return (
		<BaseMessage
			title=""
			rightSection={
				<Group gap="xs" align="center">
					<div className="text-gray-500 text-xs">
						{new Date(chunk.timestamp).toLocaleTimeString()}
					</div>
					{!legacyView && onSeek && (
						<div>
							<Tooltip label={t`Follow playback`}>
								<Switch
									size="xs"
									checked={follow}
									onChange={(e) => setFollow(e.currentTarget.checked)}
									label={t`Follow`}
								/>
							</Tooltip>
						</div>
					)}

					{rawTranscript && (
						<ActionIcon
							onClick={openDiarizationModal}
							variant="transparent"
							color="gray"
							size="xs"
							aria-label="Open diff viewer"
							title="Open diff viewer"
							className="mb-1"
						>
							<IconInfoCircle />
						</ActionIcon>
					)}
				</Group>
			}
			bottomSection={
				showAudioPlayer ? (
					<>
						<Divider />
						{!chunk.path ? (
							<Text size="xs" className="px-2" c="dimmed">
								{t`Submitted via text input`}
							</Text>
						) : audioUrlQuery.isLoading ? (
							<Skeleton height={36} width="100%" />
						) : audioUrlQuery.isError ? (
							<Text size="xs" c="gray">
								{t`Failed to load audio or the audio is not available`}
							</Text>
						) : (
							<audio
								ref={localAudioRef}
								src={audioUrlQuery.data}
								className="h-6 w-full p-0"
								preload="none"
								controls
								onPlay={() => setFollow(true)}
							/>
						)}
					</>
				) : (
					<></>
				)
			}
		>
			{legacyView ? (
				renderLegacy()
			) : (
				<div className="space-y-2">
					{segments.length ? (
						segments.map((s, i) => {
							const active = i === activeSeg && isActive;
							const canClickToSeek = !!onSeek || showAudioPlayer;
							return (
								<div
									key={s.id}
									id={`${chunk.id}-seg-${i}`}
									onClick={canClickToSeek ? () => seekTo(s) : undefined}
									className={`group rounded-md px-2 py-1 ${active ? "bg-blue-50" : "hover:bg-gray-50"} ${canClickToSeek ? "cursor-pointer" : ""}`}
								>
									{/* Timestamp and transcript on the same line, align start */}
									<div className="flex flex-col items-baseline gap-1">
										<div className="flex items-center gap-2">
											<Badge
												size="sm"
												variant="light"
												leftSection={<IconClockPlay size={12} />}
											>
												{formatTime(s.startSec + chunkOffsetStart)}
											</Badge>

											{active && (
												<Badge size="sm" color="green" variant="dot">
													{t`Now`}
												</Badge>
											)}
										</div>

										<Text className="leading-6">{s.text}</Text>
									</div>
								</div>
							);
						})
					) : (
						<Text c="dimmed">
							{chunk.transcript?.trim()?.length
								? chunk.transcript
								: t`No content`}
						</Text>
					)}
				</div>
			)}

			{rawTranscript && (
				<Modal
					title="Diff Viewer"
					opened={diarizationModalOpened}
					onClose={closeDiarizationModal}
					fullScreen
				>
					<DiffViewer
						className="h-full"
						leftTitle="Raw Transcript"
						rightTitle="Enhanced Transcript"
						note={note ?? ""}
						leftText={processedRawTranscript}
						rightText={processedEnhancedTranscript}
						topStickyContent={
							<div className="flex flex-col gap-2 p-3">
								{!chunk.path ? (
									<Text size="xs" className="px-2" c="dimmed">
										{t`Submitted via text input`}
									</Text>
								) : audioUrlQuery.isLoading ? (
									<Skeleton height={36} width="100%" />
								) : audioUrlQuery.isError ? (
									<Text size="xs" c="gray">
										{t`Failed to load audio or the audio is not available`}
									</Text>
								) : (
									<audio
										src={audioUrlQuery.data}
										className="h-6 w-full p-0"
										preload="none"
										controls
									/>
								)}
								<Divider className="mt-1" />
							</div>
						}
					/>
				</Modal>
			)}
		</BaseMessage>
	);
};
