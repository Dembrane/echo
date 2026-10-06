import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Modal, Stack, Title } from "@mantine/core";

import { useDisclosure } from "@mantine/hooks";
import { WarningCircleIcon, WifiSlashIcon } from "@phosphor-icons/react";
import { type PropsWithChildren, useEffect, useMemo, useRef } from "react";

import {
	combineUserChunks,
	useConversationChunksQuery,
	useConversationRepliesQuery,
	useParticipantProjectById,
} from "@/components/participant/hooks";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { testId } from "@/lib/testUtils";

import { TipBanner } from "../common/TipBanner";
import SpikeMessage from "./SpikeMessage";
import SystemMessage from "./SystemMessage";
import UserChunkMessage from "./UserChunkMessage";

export const ParticipantBody = ({
	projectId,
	conversationId,
	viewResponses = false,
	children,
	interleaveMessages = true,
	isRecording = false,
	isAnonymized = false,
	connectionHealthy = true,
}: PropsWithChildren<{
	projectId: string;
	conversationId: string;
	viewResponses?: boolean;
	interleaveMessages?: boolean;
	isRecording?: boolean;
	isAnonymized?: boolean;
	/** From the recording screen's liveness ping. */
	connectionHealthy?: boolean;
}>) => {
	const [ref] = useAutoAnimate();
	const [chatRef] = useAutoAnimate();
	const bottomRef = useRef<HTMLDivElement>(null);

	const projectQuery = useParticipantProjectById(projectId);
	const chunksQuery = useConversationChunksQuery(projectId, conversationId);
	const repliesQuery = useConversationRepliesQuery(projectId, conversationId);
	const isOnline = useOnlineStatus();

	const combinedMessages = useMemo(() => {
		const userChunks = (chunksQuery.data ?? []).map((chunk) => ({
			data: chunk,
			timestamp: new Date(chunk.timestamp),
			type: "user_chunk" as const,
		}));

		const replies = (repliesQuery.data ?? [])
			.filter((m) => ["assistant_reply"].includes(m.type ?? ""))
			.map((m) => ({
				data: m,
				timestamp: new Date(m.date_created ?? ""),
				type: "assistant_chunk" as const,
			}));

		const allMessages = [...userChunks, ...replies].sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
		);

		const combinedResult = [];
		let currentUserChunks = [];

		for (let i = 0; i < allMessages.length; i++) {
			const message = allMessages[i];
			if (message.type === "user_chunk") {
				currentUserChunks.push(message);
			} else {
				if (currentUserChunks.length > 0) {
					if (currentUserChunks.length > 1) {
						combinedResult.push(combineUserChunks(currentUserChunks));
					} else {
						combinedResult.push(currentUserChunks[0]);
					}
					currentUserChunks = [];
				}
				combinedResult.push(message);
			}
		}
		if (currentUserChunks.length > 0) {
			if (currentUserChunks.length > 1) {
				combinedResult.push(combineUserChunks(currentUserChunks));
			} else {
				combinedResult.push(currentUserChunks[0]);
			}
		}

		return combinedResult;
	}, [chunksQuery.data, repliesQuery.data]);

	const [opened, { open, close }] = useDisclosure(false);

	useEffect(() => {
		if (interleaveMessages && bottomRef.current) {
			bottomRef.current.scrollIntoView();
		}
	}, [interleaveMessages]);

	return (
		<Stack ref={ref} className="max-h-full">
			{!isRecording && (
				<Title order={2} mt="sm" {...testId("portal-welcome-heading")}>
					<Trans>Welcome</Trans>
				</Title>
			)}

			{!isOnline && (
				<TipBanner
					icon={WifiSlashIcon}
					message={t`You seem to be offline, please check your internet connection`}
					tipLabel={t`Tip`}
					color="yellow"
				/>
			)}

			{!connectionHealthy && (
				<TipBanner
					icon={WarningCircleIcon}
					message={t`Something went wrong with the conversation. Please try refreshing the page or contact support if the issue persists`}
					color="yellow"
				/>
			)}

			{projectQuery.data && (
				<Stack ref={chatRef} pt="xs" pb="xl">
					{projectQuery.data.default_conversation_title && (
						<Title order={4} {...testId("portal-conversation-title")}>
							{projectQuery.data.default_conversation_title}
						</Title>
					)}

					{projectQuery.data.default_conversation_description && (
						<div {...testId("portal-conversation-description")}>
							<SystemMessage
								markdown={
									projectQuery.data.default_conversation_description ?? ""
								}
							/>
						</div>
					)}

					<SystemMessage
						markdown={
							isAnonymized
								? t`Please record your response by clicking the "Record" button below. You may also choose to respond in text by clicking the text icon.
**Please keep this screen lit up**
(locked screen = not recording).
This transcript will be anonymized and your host will not be able to listen to your recording.`
								: t`Please record your response by clicking the "Record" button below. You may also choose to respond in text by clicking the text icon.
**Please keep this screen lit up**
(locked screen = not recording)`
						}
						className="mb-4"
					/>

					{children}

					{interleaveMessages ? (
						<Stack gap="sm">
							{combinedMessages.map((message, index) => (
								<div key={message.data.id || `message-${index}`}>
									{message.type === "user_chunk" ? (
										<UserChunkMessage chunk={message.data} />
									) : (
										<SpikeMessage
											message={message.data as unknown as ConversationReply}
											className={
												index !== combinedMessages.length - 1 ? "border-b" : ""
											}
										/>
									)}
								</div>
							))}
						</Stack>
					) : viewResponses ? (
						<div
							className="flex justify-end"
							{...testId("portal-view-responses-inline")}
						>
							<Stack gap="sm">
								{chunksQuery.data
									?.sort(
										(a, b) =>
											new Date(a.timestamp).getTime() -
											new Date(b.timestamp).getTime(),
									)
									.map((chunk, index) => (
										<div
											key={chunk.id}
											{...testId(`portal-view-responses-chunk-${index}`)}
										>
											<UserChunkMessage chunk={chunk} />
										</div>
									))}
							</Stack>
						</div>
					) : (
						<>
							{chunksQuery.data && chunksQuery.data.length > 0 && (
								<div className="flex justify-end">
									<Button
										variant="transparent"
										onClick={open}
										{...testId("portal-view-responses-button")}
									>
										<Trans>View your responses</Trans>
									</Button>
								</div>
							)}
							<Modal
								opened={opened}
								onClose={close}
								size="lg"
								padding="xl"
								title={t`Your responses`}
								{...testId("portal-view-responses-modal")}
							>
								<div {...testId("portal-view-responses-modal-content")}>
									<Stack gap="sm">
										{chunksQuery.data
											?.sort(
												(a, b) =>
													new Date(a.timestamp).getTime() -
													new Date(b.timestamp).getTime(),
											)
											.map((chunk, index) => (
												<div
													key={chunk.id}
													{...testId(
														`portal-view-responses-modal-chunk-${index}`,
													)}
												>
													<UserChunkMessage chunk={chunk} />
												</div>
											))}
									</Stack>
								</div>
							</Modal>
						</>
					)}

					<div ref={bottomRef} className={viewResponses ? "" : "hidden"} />
				</Stack>
			)}
		</Stack>
	);
};
