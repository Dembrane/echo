import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Group,
	Skeleton,
	Stack,
	Switch,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useCallback, useEffect, useRef } from "react";
import { useInView } from "react-intersection-observer";
import useSessionStorageState from "use-session-storage-state";
import { ScrollToBottomButton } from "@/components/common/ScrollToBottom";
import { testId } from "@/lib/testUtils";
import { ConversationChunkAudioTranscript } from "./ConversationChunkAudioTranscript";
import { CopyConversationTranscriptActionIcon } from "./CopyConversationTranscript";
import { DownloadConversationTranscriptModalActionIcon } from "./DownloadConversationTranscript";
import { useInfiniteConversationChunks } from "./hooks";
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
				className="sticky top-0 z-10 py-2"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<Group>
					<Title order={2} {...testId("transcript-title")}>
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

				<Group>
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
				</Group>
			</Group>

			{isLocked ? (
				<LockedTranscriptOverlay />
			) : (
				<Stack className="relative">
					{allChunks.length === 0 ? (
						<Alert
							icon={<IconAlertCircle size={16} />}
							title={t`No Transcript Available`}
							color="gray"
							{...testId("transcript-empty-alert")}
						>
							<Trans>
								No transcript exists for this conversation yet. Please check
								back later.
							</Trans>
						</Alert>
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
										showAudioPlayer={isAnonymized ? false : showAudioPlayer}
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
								elementRef={bottomTargetRef}
								isVisible={isBottomVisible}
							/>
						</Group>
					) : null}
				</Stack>
			)}
		</Stack>
	);
};
