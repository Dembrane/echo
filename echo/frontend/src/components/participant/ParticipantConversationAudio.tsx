import { useChat } from "@ai-sdk/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	LoadingOverlay,
	Stack,
	Text,
} from "@mantine/core";
import { useDisclosure, useWindowEvent } from "@mantine/hooks";
import {
	IconCheck,
	IconMicrophone,
	IconPlayerPause,
	IconPlayerStopFilled,
	IconTextCaption,
} from "@tabler/icons-react";
import clsx from "clsx";
import Cookies from "js-cookie";
import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router";

import { API_BASE_URL } from "@/config";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useWakeLock } from "@/hooks/useWakeLock";
import { finishConversation } from "@/lib/api";
import { I18nLink } from "../common/i18nLink";
import { ScrollToBottomButton } from "../common/ScrollToBottom";
import { toast } from "../common/Toaster";
import { useProjectSharingLink } from "../project/ProjectQRCode";
import { ConversationErrorView } from "./ConversationErrorView";

import {
	useConversationChunksQuery,
	useConversationQuery,
	useConversationRepliesQuery,
	useParticipantProjectById,
	useUploadConversationChunk,
} from "./hooks";
import useChunkedAudioRecorder from "./hooks/useChunkedAudioRecorder";
import { PermissionErrorModal } from "./PermissionErrorModal";
import { StopRecordingConfirmationModal } from "./StopRecordingConfirmationModal";

const DEFAULT_REPLY_COOLDOWN = 120; // 2 minutes in seconds
const CONVERSATION_DELETION_STATUS_CODES = [404, 403, 410];

export const ParticipantConversationAudio = () => {
	const { projectId, conversationId } = useParams();
	const location = useLocation();
	const textModeUrl = `/${projectId}/conversation/${conversationId}/text`;
	const finishUrl = `/${projectId}/conversation/${conversationId}/finish`;
	const verifyUrl = `/${projectId}/conversation/${conversationId}/verify`;

	// Check if we're on the verify route
	const isOnVerifyRoute = location.pathname.includes("/verify");

	// Get device ID from cookies for audio recording
	const savedDeviceId = Cookies.get("micDeviceId");
	const deviceId = savedDeviceId || "";

	const { iso639_1 } = useLanguage();
	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);
	const chunks = useConversationChunksQuery(projectId, conversationId);
	const uploadChunkMutation = useUploadConversationChunk();
	const repliesQuery = useConversationRepliesQuery(conversationId);

	// State for Echo cooldown management
	const [lastReplyTime, setLastReplyTime] = useState<Date | null>(null);
	const [remainingCooldown, setRemainingCooldown] = useState(0);
	const [showCooldownMessage, setShowCooldownMessage] = useState(false);

	// useChat hook for Echo messages
	const {
		messages: echoMessages,
		isLoading: echoIsLoading,
		status: echoStatus,
		error: echoError,
		handleSubmit,
	} = useChat({
		api: `${API_BASE_URL}/conversations/${conversationId}/get-reply`,
		body: { language: iso639_1 },
		experimental_prepareRequestBody() {
			return {
				language: iso639_1,
			};
		},
		initialMessages:
			repliesQuery.data?.map((msg) => ({
				content: msg.content_text ?? "",
				id: String(msg.id),
				role: msg.type === "assistant_reply" ? "assistant" : "user",
			})) ?? [],
		onError: (error) => {
			console.error("onError", error);
		},
	});

	const onChunk = (chunk: Blob) => {
		uploadChunkMutation.mutate({
			chunk,
			conversationId: conversationId ?? "",
			runFinishHook: false,
			source: "PORTAL_AUDIO",
			timestamp: new Date(),
		});
	};

	const [scrollTargetRef, isVisible] = useElementOnScreen({
		root: null,
		rootMargin: "-83px",
		threshold: 0.1,
	});

	const [
		conversationDeletedDuringRecording,
		setConversationDeletedDuringRecording,
	] = useState(false);

	const [isFinishing, _setIsFinishing] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [opened, { open, close }] = useDisclosure(false);
	// Navigation and language
	const navigate = useI18nNavigate();
	const newConversationLink = useProjectSharingLink(projectQuery.data);

	const audioRecorder = useChunkedAudioRecorder({ deviceId, onChunk });
	useWakeLock({ obtainWakeLockOnMount: true });

	const {
		startRecording,
		stopRecording,
		isRecording,
		isPaused,
		pauseRecording,
		resumeRecording,
		recordingTime,
		errored,
		permissionError,
	} = audioRecorder;

	const handleMicrophoneDeviceChanged = async () => {
		try {
			stopRecording();
		} catch (error) {
			toast.error(
				t`Failed to stop recording on device change. Please try again.`,
			);
			console.error("Failed to stop recording on device change:", error);
		}
	};

	useWindowEvent("microphoneDeviceChanged", handleMicrophoneDeviceChanged);

	// Calculate remaining cooldown time
	const getRemainingCooldown = useCallback(() => {
		if (!lastReplyTime) return 0;
		const cooldownSeconds = DEFAULT_REPLY_COOLDOWN;
		const elapsedSeconds = Math.floor(
			(Date.now() - lastReplyTime.getTime()) / 1000,
		);
		return Math.max(0, cooldownSeconds - elapsedSeconds);
	}, [lastReplyTime]);

	// Update cooldown timer
	useEffect(() => {
		if (!lastReplyTime) return;

		const interval = setInterval(() => {
			const remaining = getRemainingCooldown();
			setRemainingCooldown(remaining);

			if (remaining <= 0) {
				clearInterval(interval);
			}
		}, 1000);

		return () => clearInterval(interval);
	}, [lastReplyTime, getRemainingCooldown]);

	// Monitor conversation status during recording - handle deletion mid-recording
	useEffect(() => {
		if (!isRecording) return;

		if (
			conversationQuery.isError &&
			!conversationQuery.isFetching &&
			!conversationQuery.isLoading
		) {
			const error = conversationQuery.error;
			const httpStatus = error?.response?.status;

			if (
				httpStatus &&
				CONVERSATION_DELETION_STATUS_CODES.includes(httpStatus)
			) {
				console.warn(
					"Conversation was deleted or is no longer accessible during recording",
					{ message: error?.message, status: httpStatus },
				);
				stopRecording();
				setConversationDeletedDuringRecording(true);
			} else {
				console.warn(
					"Error fetching conversation during recording - continuing",
					{ message: error?.message, status: httpStatus },
				);
			}
		}
	}, [
		isRecording,
		conversationQuery.isError,
		conversationQuery.isLoading,
		conversationQuery.isFetching,
		conversationQuery.error,
		stopRecording,
	]);

	// Handlers
	const handleStopRecording = () => {
		if (isRecording) {
			pauseRecording();
			open();
		}
	};

	const handleConfirmFinish = async () => {
		setIsStopping(true);
		try {
			stopRecording();
			await finishConversation(conversationId ?? "");
			close();
			navigate(finishUrl);
		} catch (error) {
			console.error("Error finishing conversation:", error);
			toast.error(t`Failed to finish conversation. Please try again.`);
			setIsStopping(false);
		}
	};

	const handleSwitchToText = () => {
		stopRecording();
		close();
		navigate(textModeUrl);
	};

	const handleReply = async (e: React.MouseEvent<HTMLButtonElement>) => {
		const remaining = getRemainingCooldown();
		if (remaining > 0) {
			setShowCooldownMessage(true);
			const minutes = Math.floor(remaining / 60);
			const seconds = remaining % 60;
			const timeStr =
				minutes > 0
					? t`${minutes} minutes and ${seconds} seconds`
					: t`${seconds} seconds`;

			toast.info(t`Please wait ${timeStr} before requesting another ECHO.`);
			return;
		}

		try {
			setShowCooldownMessage(false);
			// Wait for pending uploads to complete
			while (uploadChunkMutation.isPending) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			// scroll to bottom of the page
			setTimeout(() => {
				if (scrollTargetRef.current) {
					scrollTargetRef.current.scrollIntoView({ behavior: "smooth" });
				}
			}, 0);

			handleSubmit(e, { allowEmptySubmit: true });
			setLastReplyTime(new Date());
			setRemainingCooldown(DEFAULT_REPLY_COOLDOWN);
		} catch (error) {
			console.error("Error during echo:", error);
		}
	};

	if (conversationQuery.isLoading || projectQuery.isLoading) {
		return <LoadingOverlay visible />;
	}

	// Check if conversation is not present or failed to load
	if (
		conversationQuery.isError ||
		!conversationQuery.data ||
		conversationDeletedDuringRecording
	) {
		return (
			<ConversationErrorView
				conversationDeletedDuringRecording={conversationDeletedDuringRecording}
				newConversationLink={newConversationLink}
			/>
		);
	}

	return (
		<Box className="container mx-auto flex h-full max-w-2xl flex-col justify-end">
			{/* modal for permissions error */}
			<PermissionErrorModal permissionError={permissionError} />

			{/* modal for stop recording confirmation */}
			<StopRecordingConfirmationModal
				opened={opened}
				close={close}
				isStopping={isStopping}
				handleConfirmFinish={handleConfirmFinish}
				handleResume={resumeRecording}
				handleSwitchToText={handleSwitchToText}
			/>

			<Box className={clsx("relative flex-grow p-4 transition-all")}>
				<Outlet
					context={{
						echoError,
						echoIsLoading,
						echoMessages,
						echoStatus,
						isRecording,
					}}
				/>
				<div ref={scrollTargetRef} />
			</Box>

			{!errored && (
				<Stack
					gap="lg"
					className="sticky bottom-0 z-10 w-full border-t border-slate-300 bg-white p-4"
				>
					<Group
						justify="center"
						className={`absolute left-1/2 z-50 translate-x-[-50%] bottom-[125%] ${
							isOnVerifyRoute ? "hidden" : ""
						}`}
					>
						<ScrollToBottomButton
							elementRef={scrollTargetRef}
							isVisible={isVisible}
						/>
					</Group>

					<Group justify="space-between">
						{/* Recording time indicator */}
						{isRecording && (
							<div className="border-slate-300 bg-white">
								<Group justify="center" align="center" gap="xs">
									{isPaused ? (
										<IconPlayerPause />
									) : (
										<div className="h-4 w-4 animate-pulse rounded-full bg-red-500" />
									)}
									<Text className="text-2xl">
										{Math.floor(recordingTime / 3600) > 0 && (
											<>
												{Math.floor(recordingTime / 3600)
													.toString()
													.padStart(2, "0")}
												:
											</>
										)}
										{Math.floor((recordingTime % 3600) / 60)
											.toString()
											.padStart(2, "0")}
										:{(recordingTime % 60).toString().padStart(2, "0")}
									</Text>
								</Group>
							</div>
						)}

						{!isRecording && (
							<Group className="w-full">
								<Button
									size="lg"
									radius="md"
									rightSection={<IconMicrophone />}
									onClick={startRecording}
									className="flex-grow"
								>
									<Trans id="participant.button.record">Record</Trans>
								</Button>

								<I18nLink to={textModeUrl}>
									<ActionIcon size="50" variant="default" radius="md">
										<IconTextCaption />
									</ActionIcon>
								</I18nLink>

								{!isRecording &&
									!isStopping &&
									chunks?.data &&
									chunks.data.length > 0 && (
										<Button
											size="lg"
											radius="md"
											onClick={open}
											variant="light"
											rightSection={<IconCheck />}
											className="w-full md:w-auto"
											loading={isFinishing}
											disabled={isFinishing}
										>
											<Trans id="participant.button.finish">Finish</Trans>
										</Button>
									)}
							</Group>
						)}

						{isRecording && (
							<Group gap="lg">
								{projectQuery.data?.is_get_reply_enabled &&
									!projectQuery.data?.is_verify_enabled &&
									!isOnVerifyRoute &&
									chunks?.data &&
									chunks.data.length > 0 && (
										<Button
											variant="default"
											size="lg"
											radius="md"
											onClick={(e) => {
												handleReply(e);
											}}
											loading={echoIsLoading}
											loaderProps={{ type: "dots" }}
										>
											{showCooldownMessage && remainingCooldown > 0 ? (
												<Text>
													<Trans>
														<span className="hidden md:inline">Wait </span>
														{Math.floor(remainingCooldown / 60)}:
														{(remainingCooldown % 60)
															.toString()
															.padStart(2, "0")}
													</Trans>
												</Text>
											) : (
												<Trans id="participant.button.echo">ECHO</Trans>
											)}
										</Button>
									)}
								{recordingTime >= 60 &&
									!isOnVerifyRoute &&
									projectQuery.data?.is_verify_enabled && (
										<Button
											size="lg"
											radius="md"
											onClick={() => navigate(verifyUrl)}
											disabled={isStopping}
										>
											<Trans id="participant.button.verify">Verify</Trans>
										</Button>
									)}
								<Button
									variant="outline"
									size="lg"
									radius="md"
									color="red"
									onClick={handleStopRecording}
									disabled={isStopping}
									className={
										!chunks?.data ||
										chunks.data.length === 0 ||
										!projectQuery.data?.is_get_reply_enabled
											? "px-7 md:px-10"
											: ""
									}
								>
									<Trans id="participant.button.stop">Stop</Trans>
									<IconPlayerStopFilled
										size={18}
										className="ml-0 hidden md:ml-1 md:block"
									/>
								</Button>
							</Group>
						)}
					</Group>
				</Stack>
			)}
		</Box>
	);
};
