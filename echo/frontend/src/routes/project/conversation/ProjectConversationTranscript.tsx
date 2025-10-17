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
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useEffect } from "react";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import useSessionStorageState from "use-session-storage-state";
import { ConversationChunkAudioTranscript } from "@/components/conversation/ConversationChunkAudioTranscript";
import { CopyConversationTranscriptActionIcon } from "@/components/conversation/CopyConversationTranscript";
import { DownloadConversationTranscriptModalActionIcon } from "@/components/conversation/DownloadConversationTranscript";
import {
	useConversationById,
	useInfiniteConversationChunks,
} from "@/components/conversation/hooks";
import { RetranscribeConversationModalActionIcon } from "@/components/conversation/RetranscribeConversation";

export const ProjectConversationTranscript = () => {
	const { conversationId } = useParams();
	const conversationQuery = useConversationById({
		conversationId: conversationId ?? "",
		loadConversationChunks: true,
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

	const hasValidTranscripts = allChunks.some(
		(chunk) => chunk.transcript && chunk.transcript.trim().length > 0,
	);

	const isEmptyConversation =
		!hasValidTranscripts && conversationQuery.data?.is_finished;

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
						<Title order={2}>
							<Trans>Transcript</Trans>
						</Title>
						{/* TODO: (@ussaama) what u think about extracting into reusable flags? - useConversationFlags(conversationId) */}
						{isEmptyConversation && (
							<Badge color="red" variant="light">
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
						/>
					</Group>

					<Group>
						<Switch
							checked={showAudioPlayer}
							onChange={(event) =>
								setShowAudioPlayer(event.currentTarget.checked)
							}
							label={t`Show audio player`}
						/>
					</Group>
				</Group>

				<Stack>
					{allChunks.length === 0 ? (
						<Alert
							icon={<IconAlertCircle size={16} />}
							title={t`No Transcript Available`}
							color="gray"
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
								<div key={chunk.id} ref={isLastChunk ? loadMoreRef : undefined}>
									<ConversationChunkAudioTranscript
										chunk={{
											conversation_id: chunk.conversation_id as string,
											error: chunk.error ?? "",
											id: chunk.id,
											path: chunk.path ?? "",
											timestamp: chunk.timestamp ?? "",
											transcript: chunk.transcript ?? "",
										}}
										showAudioPlayer={showAudioPlayer}
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
