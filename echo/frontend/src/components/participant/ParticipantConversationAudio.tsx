import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	LoadingOverlay,
	Modal,
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
import { useEffect, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router";

import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useVideoWakeLockFallback } from "@/hooks/useVideoWakeLockFallback";
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
	useParticipantProjectById,
	useUploadConversationChunk,
} from "./hooks";
import useChunkedAudioRecorder from "./hooks/useChunkedAudioRecorder";
import { PermissionErrorModal } from "./PermissionErrorModal";
import { useRefineSelectionCooldown } from "./refine/hooks/useRefineSelectionCooldown";
import { StopRecordingConfirmationModal } from "./StopRecordingConfirmationModal";

const CONVERSATION_DELETION_STATUS_CODES = [404, 403, 410];
const REFINE_BUTTON_THRESHOLD_SECONDS = 60;

export const ParticipantConversationAudio = () => {
	const { projectId, conversationId } = useParams();
	const location = useLocation();
	const textModeUrl = `/${projectId}/conversation/${conversationId}/text`;
	const finishUrl = `/${projectId}/conversation/${conversationId}/finish`;

	// Check if we're on the verify or refine route
	const isOnVerifyRoute = location.pathname.includes("/verify");
	const isOnRefineRoute = location.pathname.includes("/refine");

	// Get device ID from cookies for audio recording
	const savedDeviceId = Cookies.get("micDeviceId");
	const deviceId = savedDeviceId || "";

	const projectQuery = useParticipantProjectById(projectId ?? "");
	const conversationQuery = useConversationQuery(projectId, conversationId);
	const chunks = useConversationChunksQuery(projectId, conversationId);
	const uploadChunkMutation = useUploadConversationChunk();

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
	const [
		refineInfoModalOpened,
		{ open: openRefineInfoModal, close: closeRefineInfoModal },
	] = useDisclosure(false);
	// Navigation and language
	const navigate = useI18nNavigate();
	const newConversationLink = useProjectSharingLink(projectQuery.data);
	const cooldown = useRefineSelectionCooldown(conversationId);

	const audioRecorder = useChunkedAudioRecorder({ deviceId, onChunk });
	const wakeLock = useWakeLock({ obtainWakeLockOnMount: true });

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

	// iOS low battery mode fallback: play silent 1-pixel video only when wakelock fails
	useVideoWakeLockFallback({
		isRecording,
		isWakeLockActive: wakeLock.isActive,
	});

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

	// Auto-close refine info modal when threshold is reached
	useEffect(() => {
		if (
			refineInfoModalOpened &&
			recordingTime >= REFINE_BUTTON_THRESHOLD_SECONDS
		) {
			closeRefineInfoModal();
		}
	}, [refineInfoModalOpened, recordingTime, closeRefineInfoModal]);

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

	const showVerify = projectQuery.data?.is_verify_enabled;
	const showEcho = projectQuery.data?.is_get_reply_enabled;

	const handleRefineClick = () => {
		if (recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS) {
			openRefineInfoModal();
			return;
		}

		if (showVerify && !showEcho) {
			navigate(`/${projectId}/conversation/${conversationId}/verify`);
			return;
		}

		if (showEcho && !showVerify) {
			cooldown.startEchoCooldown();
			navigate(`/${projectId}/conversation/${conversationId}?echo=1`);
			return;
		}

		navigate(`/${projectId}/conversation/${conversationId}/refine`);
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

	const refineProgress = Math.min(
		(recordingTime / REFINE_BUTTON_THRESHOLD_SECONDS) * 100,
		100,
	);

	const getRefineInfoText = () => {
		if (showVerify && showEcho) {
			return t`Take some time to create an outcome that makes your contribution concrete or get an immediate reply from Dembrane to help you deepen the conversation.`;
		}
		if (showVerify) {
			return t`Take some time to create an outcome that makes your contribution concrete.`;
		}
		if (showEcho) {
			return t`Get an immediate reply from Dembrane to help you deepen the conversation.`;
		}
		return "";
	};

	const getRefineModalTitle = () => {
		if (showVerify && showEcho) {
			return (
				<Trans id="participant.modal.refine.info.title.generic">
					"Refine" available soon
				</Trans>
			);
		}
		if (showVerify) {
			return (
				<Trans id="participant.modal.refine.info.title.concrete">
					"Make it concrete" available soon
				</Trans>
			);
		}
		if (showEcho) {
			return (
				<Trans id="participant.modal.refine.info.title.go.deeper">
					"Go deeper" available soon
				</Trans>
			);
		}
		return (
			<Trans id="participant.modal.refine.info.title">
				Feature available soon
			</Trans>
		);
	};

	const getRefineButtonText = () => {
		if (showVerify && showEcho) {
			return <Trans id="participant.button.refine">Refine</Trans>;
		}
		if (showVerify) {
			return (
				<Trans id="participant.button.make.concrete">Make it concrete</Trans>
			);
		}
		if (showEcho) {
			return <Trans id="participant.button.go.deeper">Go deeper</Trans>;
		}
		return <Trans id="participant.button.refine">Refine</Trans>;
	};

	const getRefineInfoReason = () => {
		return (
			<Trans id="participant.modal.refine.info.reason">
				We need a bit more context to help you refine effectively. Please
				continue recording so we can provide better suggestions.
			</Trans>
		);
	};

	const remainingTime = Math.max(
		0,
		REFINE_BUTTON_THRESHOLD_SECONDS - Math.floor(recordingTime),
	);

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

			{/* Modal for refine info */}
			<Modal
				opened={refineInfoModalOpened}
				onClose={closeRefineInfoModal}
				centered
				size="sm"
				radius="md"
				padding="xl"
				title={
					<Text fw={600} size="lg">
						{getRefineModalTitle()}
					</Text>
				}
			>
				<Stack gap="lg">
					<Text>{getRefineInfoText()}</Text>
					<Text c="dimmed" size="sm">
						{getRefineInfoReason()}
					</Text>
					<Text c="dimmed" size="sm">
						<Trans id="participant.modal.refine.info.available.in">
							This feature will be available in {remainingTime} seconds.
						</Trans>
					</Text>
					<Button
						onClick={closeRefineInfoModal}
						fullWidth
						radius="md"
						size="md"
					>
						<Trans id="participant.button.i.understand">I understand</Trans>
					</Button>
				</Stack>
			</Modal>

			<Box className={clsx("relative flex-grow p-4 transition-all")}>
				<Outlet
					context={{
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
							isOnVerifyRoute || isOnRefineRoute ? "hidden" : ""
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
							<Group className="w-full" wrap="nowrap">
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
											rightSection={<IconCheck className="hidden sm:block" />}
											className="w-auto"
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
								{!isOnVerifyRoute &&
									!isOnRefineRoute &&
									(projectQuery.data?.is_verify_enabled ||
										projectQuery.data?.is_get_reply_enabled) && (
										<Button
											size="lg"
											radius="md"
											onClick={handleRefineClick}
											disabled={isStopping}
											className="relative overflow-hidden"
											variant={
												recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS
													? "light"
													: "filled"
											}
										>
											{recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS && (
												<div
													className="absolute bottom-0 left-0 top-0 bg-blue-200/50 transition-all duration-1000 ease-linear"
													style={{ width: `${refineProgress}%` }}
												/>
											)}
											<span className="relative z-10">
												{getRefineButtonText()}
											</span>
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
