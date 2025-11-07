import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Modal, Stack, Title } from "@mantine/core";

import { useDisclosure } from "@mantine/hooks";
import { IconExclamationCircle, IconWifiOff } from "@tabler/icons-react";
import { type PropsWithChildren, useEffect, useMemo, useRef } from "react";
import WelcomeImage from "@/assets/participant-welcome-pattern.png";
import { Toaster } from "@/components/common/Toaster";
import {
	combineUserChunks,
	useConversationChunksQuery,
	useConversationRepliesQuery,
	useParticipantProjectById,
} from "@/components/participant/hooks";
import { useConversationIssueBanner } from "@/components/participant/hooks/useConversationIssueBanner";
import { useConversationsHealthStream } from "@/components/participant/hooks/useConversationsHealthStream";
import { ENABLE_CONVERSATION_HEALTH } from "@/config";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { ConnectionHealthStatus } from "../common/ConnectionHealthStatus";
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
}: PropsWithChildren<{
	projectId: string;
	conversationId: string;
	viewResponses?: boolean;
	interleaveMessages?: boolean;
	isRecording?: boolean;
}>) => {
	const [ref] = useAutoAnimate();
	const [chatRef] = useAutoAnimate();
	const bottomRef = useRef<HTMLDivElement>(null);

	const projectQuery = useParticipantProjectById(projectId);
	const chunksQuery = useConversationChunksQuery(projectId, conversationId);
	const repliesQuery = useConversationRepliesQuery(conversationId);
	const isOnline = useOnlineStatus();
	const {
		sseConnectionHealthy,

		conversationIssue,
	} = useConversationsHealthStream(
		ENABLE_CONVERSATION_HEALTH ? [conversationId] : undefined,
	);

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

	const conversationIssueBanner = useConversationIssueBanner(
		ENABLE_CONVERSATION_HEALTH ? (conversationIssue ?? "NONE") : "NONE",
	);

	return (
		<Stack ref={ref} className="max-h-full">
			<Toaster position="top-center" richColors />

			{!isRecording && (
				<h2 className="text-center text-3xl transition-opacity duration-500 ease-in-out">
					<Trans>Welcome</Trans>
				</h2>
			)}

			{isRecording && (
				<div className="flex min-h-[2.25rem] justify-center transition-opacity duration-500 ease-in-out">
					{ENABLE_CONVERSATION_HEALTH && (
						<ConnectionHealthStatus
							isOnline={isOnline}
							sseConnectionHealthy={sseConnectionHealthy}
						/>
					)}
				</div>
			)}

			{!isOnline && (
				<TipBanner
					icon={IconWifiOff}
					message={t`You seem to be offline, please check your internet connection`}
					tipLabel={t`Tip`}
					color="blue"
				/>
			)}

			{ENABLE_CONVERSATION_HEALTH && !sseConnectionHealthy && (
				<TipBanner
					icon={IconExclamationCircle}
					message={t`Something went wrong with the conversation. Please try refreshing the page or contact support if the issue persists`}
					color="blue"
				/>
			)}

			{ENABLE_CONVERSATION_HEALTH && conversationIssueBanner && (
				<TipBanner
					icon={conversationIssueBanner.icon}
					message={conversationIssueBanner.message}
					tipLabel={conversationIssueBanner.tipLabel}
					color={conversationIssueBanner.color}
				/>
			)}

			<img
				className={`w-full object-contain ${isOnline ? "animate-pulse duration-1000" : "grayscale filter"} ${ENABLE_CONVERSATION_HEALTH && conversationIssueBanner ? "opacity-50" : "saturate-200"}`}
				src={WelcomeImage}
				alt="Welcome pattern"
			/>
			{projectQuery.data && (
				<Stack ref={chatRef} py="md" pb={9}>
					<Title order={3}>
						{projectQuery.data.default_conversation_title}
					</Title>

					{projectQuery.data.default_conversation_description && (
						<SystemMessage
							markdown={
								projectQuery.data.default_conversation_description ?? ""
							}
						/>
					)}

					<SystemMessage
						markdown={t`Please record your response by clicking the "Record" button below. You may also choose to respond in text by clicking the text icon.  
**Please keep this screen lit up**  
(black screen = not recording)`}
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
											message={message.data}
											className={
												index !== combinedMessages.length - 1 ? "border-b" : ""
											}
										/>
									)}
								</div>
							))}
						</Stack>
					) : viewResponses ? (
						<div className="flex justify-end">
							<Stack gap="sm">
								{chunksQuery.data
									?.sort(
										(a, b) =>
											new Date(a.timestamp).getTime() -
											new Date(b.timestamp).getTime(),
									)
									.map((chunk) => (
										<UserChunkMessage key={chunk.id} chunk={chunk} />
									))}
							</Stack>
						</div>
					) : (
						<>
							{chunksQuery.data && chunksQuery.data.length > 0 && (
								<div className="flex justify-end">
									<Button variant="transparent" onClick={open}>
										<Trans>View your responses</Trans>
									</Button>
								</div>
							)}
							<Modal
								opened={opened}
								onClose={close}
								size="lg"
								padding="xl"
								radius="md"
								title={t`Your responses`}
							>
								<div>
									<Stack gap="sm">
										{chunksQuery.data
											?.sort(
												(a, b) =>
													new Date(a.timestamp).getTime() -
													new Date(b.timestamp).getTime(),
											)
											.map((chunk) => (
												<UserChunkMessage key={chunk.id} chunk={chunk} />
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
