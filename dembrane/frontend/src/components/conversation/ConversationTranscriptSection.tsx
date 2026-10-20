import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Popover,
	SegmentedControl,
	Skeleton,
	Stack,
	Switch,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { Eye } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInView } from "react-intersection-observer";
import useSessionStorageState from "use-session-storage-state";
import { ScrollToBottomButton } from "@/components/common/ScrollToBottom";
import { testId } from "@/lib/testUtils";
import { ConversationChunkAudioTranscript } from "./ConversationChunkAudioTranscript";
import { CopyConversationTranscriptActionIcon } from "./CopyConversationTranscript";
import { DownloadConversationTranscriptModalActionIcon } from "./DownloadConversationTranscript";
import { FinalTranscript } from "./FinalTranscript";
import {
	useConversationFinalTranscript,
	useInfiniteConversationChunks,
} from "./hooks";
import { ImproveTranscriptAnimation } from "./ImproveTranscriptAnimation";
import { LockedTranscriptOverlay } from "./LockedTranscriptOverlay";
import { RetranscribeConversationModalActionIcon } from "./RetranscribeConversation";
import { useChunkAnchorScroll } from "./useChunkAnchorScroll";

type ConversationTranscriptSectionProps = {
	conversationId: string;
	isAnonymized: boolean;
	isFinished: boolean;
	isLocked: boolean;
	participantName: string;
};

const VIEW_KEY = "conversation-transcript-view";
type TranscriptView = "final" | "live";

const viewOptions = () => [
	{ label: t`Improved`, value: "final" },
	{ label: t`Original`, value: "live" },
];

/** The eye beside the switch: hover, focus or tap shows how the improved transcript is made. */
function HowItImproves() {
	const [opened, setOpened] = useState(false);
	const label = t`How dembrane improves your transcript`;
	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			position="bottom-end"
			shadow="md"
			withArrow
		>
			<Popover.Target>
				<ActionIcon
					variant="subtle"
					color="gray"
					aria-label={label}
					onMouseEnter={() => setOpened(true)}
					onMouseLeave={() => setOpened(false)}
					onFocus={() => setOpened(true)}
					onBlur={() => setOpened(false)}
					onClick={() => setOpened((o) => !o)}
					{...testId("transcript-how-it-improves")}
				>
					<Eye size={18} />
				</ActionIcon>
			</Popover.Target>
			<Popover.Dropdown p="xs" w={320}>
				{opened && <ImproveTranscriptAnimation />}
			</Popover.Dropdown>
		</Popover>
	);
}

// Remembered per browser, not per conversation: a person who prefers the parts keeps them.
const readView = (): TranscriptView => {
	try {
		return localStorage.getItem(VIEW_KEY) === "live" ? "live" : "final";
	} catch {
		return "final";
	}
};

export const ConversationTranscriptSection = ({
	conversationId,
	isAnonymized,
	isFinished,
	isLocked,
	participantName,
}: ConversationTranscriptSectionProps) => {
	const { ref: loadMoreRef, inView } = useInView();
	const { ref: bottomInViewRef, inView: isBottomVisible } = useInView({
		threshold: 0.2,
	});
	const bottomTargetRef = useRef<HTMLDivElement | null>(null);
	const setBottomTargetRef = useCallback(
		(node: HTMLDivElement | null) => {
			bottomTargetRef.current = node;
			bottomInViewRef(node);
		},
		[bottomInViewRef],
	);

	const {
		data: chunksData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		status,
	} = useInfiniteConversationChunks(conversationId);

	useEffect(() => {
		if (inView && hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

	const [showAudioPlayer, setShowAudioPlayer] = useSessionStorageState<boolean>(
		"conversation-transcript-show-audio-player",
		{
			defaultValue: false,
		},
	);

	const finalQuery = useConversationFinalTranscript(conversationId, isFinished);
	const finalTranscript =
		finalQuery.data?.available && !finalQuery.data.locked
			? finalQuery.data
			: null;
	const [view, setView] = useState<TranscriptView>(readView);
	const changeView = (next: string) => {
		const v: TranscriptView = next === "live" ? "live" : "final";
		setView(v);
		try {
			localStorage.setItem(VIEW_KEY, v);
		} catch {
			// The choice just is not remembered.
		}
	};
	const hasFinal = finalTranscript !== null;
	const showFinal = hasFinal && view === "final";
	// Under Live after the conversation ended, each part has its own player, as while it was recorded.
	const partsPlayer = hasFinal ? !isAnonymized : showAudioPlayer;
	// A final transcript is on its way: say so in one line, and say nothing once it is here.
	const isDraft =
		!showFinal &&
		finalQuery.data?.available === false &&
		Boolean(finalQuery.data.expected);

	const allChunks = (chunksData?.pages ?? []).flatMap((page) => page.chunks);
	const highlightedChunkId = useChunkAnchorScroll({
		chunks: allChunks,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	});

	const hasValidTranscripts = allChunks.some(
		(chunk) => chunk.transcript && chunk.transcript.trim().length > 0,
	);

	const isEmptyConversation = !hasValidTranscripts && isFinished;

	if (status === "pending") {
		return (
			<Stack>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} height={200} />
				))}
			</Stack>
		);
	}

	return (
		<Stack>
			<Group
				justify="space-between"
				className="sticky top-0 z-10 py-2 reading-measure"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<Group gap="sm">
					<Title order={4} {...testId("transcript-title")}>
						<Trans>Transcript</Trans>
					</Title>
					{isEmptyConversation && !isLocked && (
						<Badge
							color="red"
							variant="light"
							{...testId("transcript-empty-badge")}
						>
							<Trans>Empty</Trans>
						</Badge>
					)}
					{!isLocked && (
						<>
							<DownloadConversationTranscriptModalActionIcon
								conversationId={conversationId}
							/>
							<CopyConversationTranscriptActionIcon
								conversationId={conversationId}
							/>
							<RetranscribeConversationModalActionIcon
								conversationId={conversationId}
								conversationName={participantName}
								disabled={isAnonymized}
							/>
						</>
					)}
				</Group>

				<Group gap="xs">
					{hasFinal && !isLocked && (
						<>
							<SegmentedControl
								size="xs"
								value={view}
								onChange={changeView}
								data={viewOptions()}
								{...testId("transcript-view-toggle")}
							/>
							<HowItImproves />
						</>
					)}
					{!hasFinal && (
						<Tooltip
							label={t`Audio playback not available for anonymized conversations`}
							disabled={!isAnonymized}
							refProp="rootRef"
						>
							<Switch
								checked={isAnonymized ? false : showAudioPlayer}
								onChange={(event) =>
									setShowAudioPlayer(event.currentTarget.checked)
								}
								disabled={isAnonymized}
								label={t`Show audio player`}
								{...testId("transcript-show-audio-player-toggle")}
							/>
						</Tooltip>
					)}
				</Group>
			</Group>

			{isLocked ? (
				<LockedTranscriptOverlay />
			) : showFinal ? (
				<Stack gap="xs" {...testId("transcript-final")}>
					<FinalTranscript
						text={finalTranscript.text}
						sentences={finalTranscript.sentences}
						audioUrl={isAnonymized ? null : finalTranscript.audio_url}
					/>
				</Stack>
			) : (
				<Stack className="relative reading-measure">
					{isDraft && allChunks.length > 0 && (
						<Text size="xs" c="dimmed" {...testId("transcript-draft")}>
							{isFinished ? (
								<Trans>An improved transcript is on its way.</Trans>
							) : (
								<Trans>
									You get an improved transcript when the conversation ends.
								</Trans>
							)}
						</Text>
					)}
					{allChunks.length === 0 ? (
						<Text size="sm" c="dimmed" {...testId("transcript-empty-alert")}>
							<Trans>
								No transcript exists for this conversation yet. Please check
								back later.
							</Trans>
						</Text>
					) : (
						allChunks.map((chunk, index, array) => {
							const isLastChunk = index === array.length - 1;
							return (
								<div
									key={chunk.id}
									id={`chunk-${chunk.id}`}
									ref={isLastChunk ? loadMoreRef : undefined}
									{...testId(`transcript-chunk-${index}`)}
								>
									<ConversationChunkAudioTranscript
										chunk={{
											conversation_id: chunk.conversation_id as string,
											error: chunk.error ?? "",
											id: chunk.id,
											path: chunk.path ?? "",
											timestamp: chunk.timestamp ?? "",
											transcript: chunk.transcript ?? "",
										}}
										highlighted={highlightedChunkId === chunk.id}
										showAudioPlayer={isAnonymized ? false : partsPlayer}
										transcriptLocked={!!chunk.transcript_locked}
									/>
								</div>
							);
						})
					)}
					{isFetchingNextPage && (
						<Stack>
							{[0, 1].map((i) => (
								<Skeleton key={i} height={200} />
							))}
						</Stack>
					)}
					<div ref={setBottomTargetRef} aria-hidden="true" />
					{allChunks.length > 0 ? (
						<Group
							justify="center"
							className="fixed bottom-6 right-6 z-50"
							{...testId("transcript-scroll-to-bottom")}
						>
							<ScrollToBottomButton
								visible={!isBottomVisible}
								onClick={() =>
									bottomTargetRef.current?.scrollIntoView({
										behavior: "smooth",
									})
								}
							/>
						</Group>
					) : null}
				</Stack>
			)}
		</Stack>
	);
};
