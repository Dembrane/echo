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
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useLocation, useParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import { ConversationChunkAudioTranscript } from "@/components/conversation/ConversationChunkAudioTranscript";
import { CopyConversationTranscriptActionIcon } from "@/components/conversation/CopyConversationTranscript";
import { DownloadConversationTranscriptModalActionIcon } from "@/components/conversation/DownloadConversationTranscript";
import {
	useConversationById,
	useInfiniteConversationChunks,
} from "@/components/conversation/hooks";
import { RetranscribeConversationModalActionIcon } from "@/components/conversation/RetranscribeConversation";
import { testId } from "@/lib/testUtils";

export const ProjectConversationTranscript = () => {
	const { conversationId } = useParams();
	const location = useLocation();
	const conversationQuery = useConversationById({
		conversationId: conversationId ?? "",
		loadConversationChunks: false,
		query: {
			fields: ["id", "participant_name", "is_finished", "is_anonymized"],
		},
	});
	const { ref: loadMoreRef, inView } = useInView();

	const {
		data: chunksData,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		status,
	} = useInfiniteConversationChunks(conversationId ?? "");

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
	const targetChunkId = location.hash.startsWith("#chunk-")
		? decodeURIComponent(location.hash.slice("#chunk-".length))
		: null;

	const isAnonymized = conversationQuery.data?.is_anonymized ?? false;

	const hasValidTranscripts = allChunks.some(
		(chunk) => chunk.transcript && chunk.transcript.trim().length > 0,
	);
	const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(
		null,
	);

	const isEmptyConversation =
		!hasValidTranscripts && conversationQuery.data?.is_finished;

	useEffect(() => {
		if (!targetChunkId) return;
		const hasTargetChunk = allChunks.some(
			(chunk) => chunk.id === targetChunkId,
		);
		if (hasTargetChunk || !hasNextPage || isFetchingNextPage) return;
		void fetchNextPage();
	}, [
		allChunks,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		targetChunkId,
	]);

	useEffect(() => {
		if (!targetChunkId) return;
		const targetChunk = allChunks.find((chunk) => chunk.id === targetChunkId);
		if (!targetChunk) return;
		const targetElement = document.getElementById(`chunk-${targetChunk.id}`);
		if (!targetElement) return;
		targetElement.scrollIntoView({
			behavior: "smooth",
			block: "center",
		});
		setHighlightedChunkId(targetChunkId);
	}, [allChunks, targetChunkId]);

	useEffect(() => {
		if (!highlightedChunkId) return;
		const timeoutId = window.setTimeout(() => {
			setHighlightedChunkId(null);
		}, 5000);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [highlightedChunkId]);

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
			<Stack>
				<Group justify="space-between">
					<Group>
						<Title order={2} {...testId("transcript-title")}>
							<Trans>Transcript</Trans>
						</Title>
						{/* TODO: (@ussaama) what u think about extracting into reusable flags? - useConversationFlags(conversationId) */}
						{isEmptyConversation && (
							<Badge
								color="red"
								variant="light"
								{...testId("transcript-empty-badge")}
							>
								<Trans>Empty</Trans>
							</Badge>
						)}
						{/* Actions */}
						<DownloadConversationTranscriptModalActionIcon
							conversationId={conversationId ?? ""}
						/>
						<CopyConversationTranscriptActionIcon
							conversationId={conversationId ?? ""}
						/>
						<RetranscribeConversationModalActionIcon
							conversationId={conversationId ?? ""}
							conversationName={conversationQuery.data?.participant_name ?? ""}
							disabled={isAnonymized}
						/>
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

				<Stack>
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
				</Stack>
			</Stack>
		</Stack>
	);
};
