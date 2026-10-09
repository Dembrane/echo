import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { useDisclosure, useLocalStorage, useWindowEvent } from "@mantine/hooks";
import {
	ArticleNyTimesIcon,
	CheckIcon,
	MicrophoneIcon,
	PauseIcon,
	StopIcon,
} from "@phosphor-icons/react";
import clsx from "clsx";
import Cookies from "js-cookie";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useVideoWakeLockFallback } from "@/hooks/useVideoWakeLockFallback";
import { finishConversation } from "@/lib/api";
import { testId } from "@/lib/testUtils";
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
import { useDocumentHidden } from "./hooks/useDocumentHidden";
import { useMonitorBeacon } from "./hooks/useMonitorBeacon";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { usePingConnectionHealth } from "./hooks/usePingConnectionHealth";
import {
	captureInterruptionError,
	captureRecordingInterrupted,
	useRecordingTelemetry,
} from "./hooks/useRecordingTelemetry";
import { useRecordingWakeLock } from "./hooks/useRecordingWakeLock";
import { useS3ConnectivityCheck } from "./hooks/useS3ConnectivityCheck";
import type { RecordingMeterStatus } from "./ParticipantRecordingWaveform";
import { ParticipantRecordingWaveform } from "./ParticipantRecordingWaveform";
import { ParticipantSettingsModal } from "./ParticipantSettingsModal";
import { PermissionErrorModal } from "./PermissionErrorModal";
import { deriveParticipantState } from "./participantState";
import { RecordingInterruptedModal } from "./RecordingInterruptedModal";
import { RefineInfoModal } from "./RefineInfoModal";
import { StopRecordingConfirmationModal } from "./StopRecordingConfirmationModal";
import { StorageCheckModal } from "./StorageCheckModal";
import { useConversationArtefacts } from "./verify/hooks";

const CONVERSATION_DELETION_STATUS_CODES = [404, 403, 410];
const REFINE_BUTTON_THRESHOLD_SECONDS = 60;

export const ParticipantConversationAudio = () => {
	const { projectId, conversationId } = useParams();
	const location = useLocation();
	const [isRefineDisabled, _setIsRefineDisabled] = useLocalStorage({
		defaultValue: false,
		key: `refine_disabled_${conversationId}`,
	});
	const textModeUrl = `/${projectId}/conversation/${conversationId}/text`;
	const finishUrl = `/${projectId}/conversation/${conversationId}/finish${location.search}`;

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
	const artefactsQuery = useConversationArtefacts(conversationId);
	const pendingUploads = usePendingUploads();

	const onChunk = (chunk: Blob) => {
		pendingUploads.track(
			uploadChunkMutation.mutateAsync({
				chunk,
				conversationId: conversationId ?? "",
				runFinishHook: false,
				source: "PORTAL_AUDIO",
				timestamp: new Date(),
			}),
		);
	};

	// Before leaving the screen. Gives up after 30s rather than strand the
	// participant, and records that some audio may not have landed.
	const waitForPendingUploads = async (context: "finish" | "reconnect") => {
		if ((await pendingUploads.waitForAll()) === "done") return;
		console.warn("Upload wait timeout reached, proceeding anyway");
		posthog.capture("portal_uploads_incomplete_on_finish", {
			context,
			conversation_id: conversationId,
			pending_uploads: pendingUploads.count(),
			project_id: projectId,
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
	const [stoppedRecordingTime, setStoppedRecordingTime] = useState<
		number | null
	>(null);
	const [opened, { open, close }] = useDisclosure(false);
	const [
		refineInfoModalOpened,
		{ open: openRefineInfoModal, close: closeRefineInfoModal },
	] = useDisclosure(false);

	// Connection state comes from the liveness ping below, not a stream of its
	// own. The meter reads it here, and the body reads it through the outlet
	// context.
	const isOnline = useOnlineStatus();
	const { connectionHealthy, reportPing } = usePingConnectionHealth();

	const [
		forcedSettingsOpened,
		{ close: closeForcedSettings, open: openForcedSettings },
	] = useDisclosure(false);

	const [interruptionModalOpened, { open: openInterruptionModal }] =
		useDisclosure(false);
	const [isReconnecting, setIsReconnecting] = useState(false);
	const interruptionRecordingTimeRef = useRef<number>(0);

	const { s3Status, retry: handleS3Reconnect } = useS3ConnectivityCheck(
		conversationId,
		{ queriesLoading: conversationQuery.isLoading || projectQuery.isLoading },
	);

	// Navigation and language
	const navigate = useI18nNavigate();
	const newConversationLink = useProjectSharingLink(
		projectQuery.data,
		"portal",
	);
	const wakeLock = useRecordingWakeLock();

	// Ref to store callback that will be set after audioRecorder is created
	const onRecordingInterruptedRef = useRef<(() => void) | null>(null);

	const audioRecorder = useChunkedAudioRecorder({
		deviceId,
		onChunk,
		onRecordingInterrupted: () => onRecordingInterruptedRef.current?.(),
	});

	// Set up the interruption callback after audioRecorder is available
	onRecordingInterruptedRef.current = () => {
		// Capture the recording time before stopping.
		interruptionRecordingTimeRef.current = audioRecorder.recordingTime;

		captureRecordingInterrupted({
			chunkHistory: audioRecorder.getChunkHistory(),
			conversationId,
			projectId,
			recordingTime: interruptionRecordingTimeRef.current,
		});

		// Stop recording and release wake lock.
		audioRecorder.stopRecording();
		wakeLock.release();

		// Show the interruption modal.
		openInterruptionModal();
	};

	const {
		startRecording,
		stopRecording,
		isRecording,
		isStarting,
		recordingTime,
		errored,
		permissionError,
	} = audioRecorder;

	// What colour the meter runs in. A run that was interrupted is the recording
	// itself failing, so it outranks a connection that has merely gone quiet.
	// The meter escalates to `problem` on its own when no sound arrives at all.
	const meterStatus: RecordingMeterStatus = audioRecorder.hadInterruption
		? "problem"
		: !isOnline || !connectionHealthy
			? "unhealthy"
			: "healthy";

	// iOS low battery mode fallback: play silent 1-pixel video only when wakelock fails
	useVideoWakeLockFallback({
		isRecording,
		isWakeLockSupported: wakeLock.isSupported,
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

	const documentHidden = useDocumentHidden();

	const participantState = deriveParticipantState({
		documentHidden,
		isOnRefineRoute,
		isOnVerifyRoute,
		isPaused: stoppedRecordingTime !== null,
		isRecording,
		isStopping,
	});

	useMonitorBeacon({
		conversationId,
		getAudioLevel: audioRecorder.getAudioLevel,
		isRecording,
		participantState,
		projectId,
		recordingTime,
		reportPing,
		stoppedRecordingTime,
	});

	useRecordingTelemetry({
		conversationId,
		documentHidden,
		isRecording,
		participantState,
		pendingUploadCount: pendingUploads.count,
		projectId,
		recordingTime,
	});

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
				posthog.capture("portal_conversation_deleted_during_recording", {
					conversation_id: conversationId,
					project_id: projectId,
				});
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
		conversationId,
		projectId,
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

	const hasApprovedArtefacts = (artefactsQuery.data?.length ?? 0) > 0;
	const effectiveRecordingTime = stoppedRecordingTime ?? recordingTime;
	const shouldVerifyOnFinish =
		!!projectQuery.data?.is_verify_on_finish_enabled &&
		!!projectQuery.data?.is_verify_enabled &&
		!hasApprovedArtefacts &&
		effectiveRecordingTime >= REFINE_BUTTON_THRESHOLD_SECONDS;

	// Handlers
	const handleStopRecording = () => {
		if (isRecording) {
			setStoppedRecordingTime(recordingTime); // Capture time before stopping
			stopRecording(); // Actually stop to trigger final chunk upload immediately
			// Release wakelock and disable auto-reacquire when stopping
			wakeLock.release();
			open();
		}
	};

	const handleConfirmFinish = async () => {
		setIsStopping(true);
		try {
			stopRecording();
			// Release wakelock when finishing
			wakeLock.release();

			await waitForPendingUploads("finish");

			await finishConversation(conversationId ?? "");
			posthog.capture("conversation_finished", {
				conversation_id: conversationId,
				project_id: projectId,
			});
			close();
			navigate(finishUrl);
		} catch (error) {
			console.error("Error finishing conversation:", error);
			toast.error(t`Failed to finish conversation. Please try again.`);
			setIsStopping(false);
		}
	};

	const handleSkipVerification = async () => {
		close();
		await handleConfirmFinish();
	};

	const handleSwitchToText = () => {
		setStoppedRecordingTime(null);
		close();
		navigate(textModeUrl);
	};

	const handleResumeRecording = async () => {
		const timeToResume = stoppedRecordingTime ?? 0;
		// Don't clear stoppedRecordingTime here - let the useEffect do it when recording starts
		const started = await startRecording(timeToResume);
		if (!started) return;
		// Obtain wakelock on user interaction
		wakeLock.hold();
	};

	const handleVerify = () => {
		close();
		handleResumeRecording();
		navigate(`/${projectId}/conversation/${conversationId}/verify`);
	};

	// Clear stoppedRecordingTime when recording actually starts (avoids UI flash)
	useEffect(() => {
		if (isRecording && stoppedRecordingTime !== null) {
			setStoppedRecordingTime(null);
		}
	}, [isRecording, stoppedRecordingTime]);

	// Handler for reconnect button - waits for uploads, reports error, then reloads
	const handleReconnect = async () => {
		setIsReconnecting(true);
		try {
			await waitForPendingUploads("reconnect");

			if (audioRecorder.hadInterruption) {
				captureInterruptionError({
					chunkHistory: audioRecorder.getChunkHistory(),
					conversationId,
					projectId,
					recordingTime: interruptionRecordingTimeRef.current,
				});
			}

			window.location.reload();
		} catch (_error) {
			toast.error(t`Failed to reconnect. Please try reloading the page.`);
			setIsReconnecting(false);
		}
	};

	const handleStartRecording = async () => {
		if (s3Status !== "passed") {
			return;
		}

		const started = await startRecording();
		if (!started) return;

		posthog.capture("recording_started", {
			conversation_id: conversationId,
			project_id: projectId,
		});
		wakeLock.hold();
	};

	const showVerify = projectQuery.data?.is_verify_enabled;
	const showEcho = projectQuery.data?.is_get_reply_enabled;

	const handleRefineClick = () => {
		if (recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS) {
			openRefineInfoModal();
			return;
		}

		navigate(`/${projectId}/conversation/${conversationId}/refine`);
	};

	if (conversationQuery.isLoading || projectQuery.isLoading) {
		return <BeautifulLoading quiet className="min-h-dvh" />;
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

	const remainingTime = Math.max(
		0,
		REFINE_BUTTON_THRESHOLD_SECONDS - Math.floor(recordingTime),
	);

	return (
		<Box className="container mx-auto flex h-full max-w-2xl flex-col justify-end">
			{/* modal for permissions error */}
			<PermissionErrorModal permissionError={permissionError} />

			<StorageCheckModal status={s3Status} onReconnect={handleS3Reconnect} />

			{/* modal for stop recording confirmation */}
			<ParticipantSettingsModal
				opened={forcedSettingsOpened}
				onClose={closeForcedSettings}
			/>

			<StopRecordingConfirmationModal
				opened={opened}
				close={close}
				isStopping={isStopping}
				isUploading={uploadChunkMutation.isPending}
				handleConfirmFinish={handleConfirmFinish}
				handleResume={handleResumeRecording}
				handleSwitchToText={handleSwitchToText}
				showVerifyOnFinish={shouldVerifyOnFinish}
				handleSkipVerification={handleSkipVerification}
				handleVerify={handleVerify}
			/>

			<RefineInfoModal
				opened={refineInfoModalOpened}
				onClose={closeRefineInfoModal}
				showVerify={!!showVerify}
				showEcho={!!showEcho}
				remainingSeconds={remainingTime}
			/>

			<RecordingInterruptedModal
				opened={interruptionModalOpened}
				isUploading={uploadChunkMutation.isPending}
				isReconnecting={isReconnecting}
				onReconnect={handleReconnect}
			/>

			<Box className={clsx("relative flex-grow p-4 transition-all")}>
				<Outlet
					context={{
						connectionHealthy,
						isRecording,
						recordingTime,
					}}
				/>
				<div ref={scrollTargetRef} />
			</Box>

			{!errored && (
				<Stack
					bg="var(--app-background)"
					gap="lg"
					className="sticky bottom-0 z-10 w-full min-h-[84px] border-t p-4"
					style={{ borderColor: "var(--app-rule-color)" }}
				>
					<Group
						justify="center"
						className={`absolute left-1/2 z-50 translate-x-[-50%] bottom-[125%] ${
							isOnVerifyRoute || isOnRefineRoute ? "hidden" : ""
						}`}
					>
						<ScrollToBottomButton
							visible={!isVisible}
							onClick={() =>
								scrollTargetRef.current?.scrollIntoView({ behavior: "smooth" })
							}
						/>
					</Group>

					{isRecording && (
						<ParticipantRecordingWaveform
							onSilence={openForcedSettings}
							peekAudioLevel={audioRecorder.peekAudioLevel}
							status={meterStatus}
						/>
					)}

					<Group justify="space-between">
						{/* Recording time indicator - show when recording OR when stop modal is open OR when interruption modal is open OR resuming */}
						{(isRecording ||
							opened ||
							interruptionModalOpened ||
							stoppedRecordingTime !== null) && (
							<div {...testId("portal-audio-recording-timer")}>
								<Group justify="center" align="center" gap="xs" mih={50}>
									{opened ||
									interruptionModalOpened ||
									stoppedRecordingTime !== null ? (
										<PauseIcon size={20} />
									) : (
										<div
											className="h-4 w-4 animate-pulse rounded-full"
											style={{ background: "var(--app-danger)" }}
										/>
									)}
									<Text size="lg">
										{(() => {
											const displayTime = interruptionModalOpened
												? interruptionRecordingTimeRef.current
												: stoppedRecordingTime !== null
													? stoppedRecordingTime
													: recordingTime;
											return (
												<>
													{Math.floor(displayTime / 3600) > 0 && (
														<>
															{Math.floor(displayTime / 3600)
																.toString()
																.padStart(2, "0")}
															:
														</>
													)}
													{Math.floor((displayTime % 3600) / 60)
														.toString()
														.padStart(2, "0")}
													:{(displayTime % 60).toString().padStart(2, "0")}
												</>
											);
										})()}
									</Text>
								</Group>
							</div>
						)}

						{!isRecording &&
							!opened &&
							!interruptionModalOpened &&
							stoppedRecordingTime === null && (
								<Group className="w-full" wrap="nowrap">
									<Button
										size="lg"
										variant="filled"
										leftSection={<MicrophoneIcon size={20} />}
										onClick={handleStartRecording}
										loading={
											isStarting ||
											s3Status === "checking" ||
											s3Status === "pending"
										}
										disabled={s3Status !== "passed"}
										className="flex-grow"
										{...testId("portal-audio-record-button")}
									>
										<Trans id="participant.button.record">Record</Trans>
									</Button>

									<I18nLink to={textModeUrl}>
										<Button
											size="lg"
											px="lg"
											aria-label={t`Switch to text`}
											{...testId("portal-audio-switch-to-text-button")}
										>
											<ArticleNyTimesIcon size={20} />
										</Button>
									</I18nLink>

									{!isStopping && chunks?.data && chunks.data.length > 0 && (
										<Button
											size="lg"
											onClick={open}
											leftSection={
												<CheckIcon size={20} className="hidden sm:block" />
											}
											className="w-auto"
											loading={isFinishing}
											disabled={isFinishing}
											{...testId("portal-audio-finish-button")}
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
											onClick={handleRefineClick}
											disabled={isStopping || isRefineDisabled}
											className="relative overflow-hidden"
											variant={
												recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS
													? undefined
													: "filled"
											}
											{...testId("portal-audio-echo-button")}
										>
											{recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS && (
												<div
													className="absolute bottom-0 left-0 top-0 bg-primary-600/20 transition-all duration-1000 ease-linear"
													style={{ width: `${refineProgress}%` }}
												/>
											)}
											<span className="relative z-10">
												<Trans id="participant.button.echo">ECHO</Trans>
											</span>
										</Button>
									)}
								<Button
									size="lg"
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
									leftSection={
										<StopIcon size={20} className="hidden md:block" />
									}
									{...testId("portal-audio-stop-button")}
								>
									<Trans id="participant.button.stop">Stop</Trans>
								</Button>
							</Group>
						)}
					</Group>
				</Stack>
			)}
		</Box>
	);
};
