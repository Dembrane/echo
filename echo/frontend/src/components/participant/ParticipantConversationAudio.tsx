import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Group,
	Loader,
	LoadingOverlay,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { useDisclosure, useLocalStorage, useWindowEvent } from "@mantine/hooks";
import * as Sentry from "@sentry/react";
import {
	IconAlertTriangle,
	IconCheck,
	IconMicrophone,
	IconPlayerPause,
	IconPlayerStopFilled,
	IconTextCaption,
} from "@tabler/icons-react";
import clsx from "clsx";
import Cookies from "js-cookie";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router";

import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useVideoWakeLockFallback } from "@/hooks/useVideoWakeLockFallback";
import { useWakeLock } from "@/hooks/useWakeLock";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
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
import { PermissionErrorModal } from "./PermissionErrorModal";
import { StopRecordingConfirmationModal } from "./StopRecordingConfirmationModal";

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
	const pendingUploadsRef = useRef<Promise<unknown>[]>([]);

	const onChunk = (chunk: Blob) => {
		const uploadPromise = uploadChunkMutation.mutateAsync({
			chunk,
			conversationId: conversationId ?? "",
			runFinishHook: false,
			source: "PORTAL_AUDIO",
			timestamp: new Date(),
		});

		pendingUploadsRef.current.push(uploadPromise);

		// Clean up promise from array when done (success or error)
		uploadPromise.finally(() => {
			pendingUploadsRef.current = pendingUploadsRef.current.filter(
				(p) => p !== uploadPromise,
			);
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

	const [interruptionModalOpened, { open: openInterruptionModal }] =
		useDisclosure(false);
	const [isReconnecting, setIsReconnecting] = useState(false);
	const interruptionRecordingTimeRef = useRef<number>(0);
	// Navigation and language
	const navigate = useI18nNavigate();
	const newConversationLink = useProjectSharingLink(projectQuery.data);
	const wakeLock = useWakeLock();

	// Ref to store callback that will be set after audioRecorder is created
	const onRecordingInterruptedRef = useRef<(() => void) | null>(null);

	const audioRecorder = useChunkedAudioRecorder({
		deviceId,
		onChunk,
		onRecordingInterrupted: () => onRecordingInterruptedRef.current?.(),
	});

	// Set up the interruption callback after audioRecorder is available
	onRecordingInterruptedRef.current = () => {
		// Capture the recording time before stopping
		interruptionRecordingTimeRef.current = audioRecorder.recordingTime;

		// Stop recording and release wake lock
		audioRecorder.stopRecording();
		wakeLock.releaseWakeLock();
		wakeLock.disableAutoReacquire();

		// Show the interruption modal
		openInterruptionModal();
	};

	const {
		startRecording,
		stopRecording,
		isRecording,
		recordingTime,
		errored,
		permissionError,
	} = audioRecorder;

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
			setStoppedRecordingTime(recordingTime); // Capture time before stopping
			stopRecording(); // Actually stop to trigger final chunk upload immediately
			// Release wakelock and disable auto-reacquire when stopping
			wakeLock.releaseWakeLock();
			wakeLock.disableAutoReacquire();
			open();
		}
	};

	const handleConfirmFinish = async () => {
		setIsStopping(true);
		try {
			stopRecording();
			// Release wakelock when finishing
			wakeLock.releaseWakeLock();
			wakeLock.disableAutoReacquire();

			// Small delay to ensure final chunk's upload promise is added to the array
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Wait for all pending uploads to complete (with timeout)
			if (pendingUploadsRef.current.length > 0) {
				const timeoutPromise = new Promise<"timeout">((resolve) =>
					setTimeout(() => resolve("timeout"), 30000),
				);

				const result = await Promise.race([
					Promise.allSettled(pendingUploadsRef.current).then(() => "done"),
					timeoutPromise,
				]);

				if (result === "timeout") {
					console.warn("Upload wait timeout reached, proceeding anyway");
				}
			}

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
		setStoppedRecordingTime(null);
		close();
		navigate(textModeUrl);
	};

	const handleResumeRecording = () => {
		const timeToResume = stoppedRecordingTime ?? 0;
		// Don't clear stoppedRecordingTime here - let the useEffect do it when recording starts
		startRecording(timeToResume);
		// Obtain wakelock on user interaction
		if (wakeLock.isSupported) {
			wakeLock.obtainWakeLock();
			wakeLock.enableAutoReacquire();
		}
	};

	// Clear stoppedRecordingTime when recording actually starts (avoids UI flash)
	useEffect(() => {
		if (isRecording && stoppedRecordingTime !== null) {
			setStoppedRecordingTime(null);
		}
	}, [isRecording, stoppedRecordingTime]);

	// Report interruption to Sentry and Plausible
	const reportInterruption = () => {
		if (!audioRecorder.hadInterruption) return;

		const chunkHistory = audioRecorder.getChunkHistory();

		// Send to Sentry
		Sentry.captureMessage(
			"Recording interrupted by consecutive suspicious chunks",
			{
				extra: {
					chunkSizes: chunkHistory.map((c) => c.size),
					conversationId,
					deviceInfo: navigator.userAgent,
					projectId,
					recordingDurationSeconds: interruptionRecordingTimeRef.current,
					suspiciousChunkIndices: chunkHistory
						.map((c, i) => (c.size < 1024 ? i : -1))
						.filter((i) => i >= 0),
					timestamp: new Date().toISOString(),
					totalChunks: chunkHistory.length,
				},
				level: "warning",
				tags: {
					issue_type: "audio_interruption",
					platform: "participant_portal",
				},
			},
		);

		// Send to Plausible
		try {
			analytics.trackEvent(events.AUDIO_CHUNK_INTERRUPTION_ERROR);
		} catch (error) {
			console.warn("Analytics tracking failed:", error);
		}
	};

	// Handler for reconnect button - waits for uploads, reports error, then reloads
	const handleReconnect = async () => {
		setIsReconnecting(true);
		try {
			// Small delay to ensure final chunk's upload promise is added to the array
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Wait for all pending uploads to complete (with timeout)
			if (pendingUploadsRef.current.length > 0) {
				const timeoutPromise = new Promise<"timeout">((resolve) =>
					setTimeout(() => resolve("timeout"), 30000),
				);

				const result = await Promise.race([
					Promise.allSettled(pendingUploadsRef.current).then(() => "done"),
					timeoutPromise,
				]);

				if (result === "timeout") {
					console.warn("Upload wait timeout reached, proceeding anyway");
				}
			}

			reportInterruption();

			window.location.reload();
		} catch (_error) {
			toast.error(t`Failed to reconnect. Please try reloading the page.`);
			setIsReconnecting(false);
		}
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
				isUploading={uploadChunkMutation.isPending}
				handleConfirmFinish={handleConfirmFinish}
				handleResume={handleResumeRecording}
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
				{...testId("portal-audio-echo-info-modal")}
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
						{...testId("portal-audio-echo-info-close-button")}
					>
						<Trans id="participant.button.i.understand">I understand</Trans>
					</Button>
				</Stack>
			</Modal>

			{/* Modal for recording interruption */}
			<Modal
				opened={interruptionModalOpened}
				onClose={() => {}}
				withCloseButton={false}
				centered
				size="sm"
				radius="md"
				padding="xl"
				closeOnClickOutside={false}
				closeOnEscape={false}
				overlayProps={{
					color: "#FF9AA2",
				}}
				role="alertdialog"
				aria-live="assertive"
				aria-atomic="true"
				{...testId("portal-audio-interruption-modal")}
			>
				<Stack gap="md">
					<Group gap="xs">
						<IconAlertTriangle size={24} color="#FF9AA2" />
						<Text fw={600} size="lg">
							<Trans id="participant.modal.interruption.title">
								Recording interrupted
							</Trans>
						</Text>
						<IconAlertTriangle size={24} color="#FF9AA2" />
					</Group>
					<Text>
						<Trans id="participant.modal.interruption.issue.message">
							Attention! We lost the last 60 seconds or so of your recording due
							to some interruption. Please press the button below to reconnect.
						</Trans>
					</Text>

					{/* Uploading indicator - same pattern as StopRecordingConfirmationModal */}
					{uploadChunkMutation.isPending && (
						<Group gap="xs" justify="flex-start" py="xs">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								<Trans id="participant.modal.interruption.uploading">
									Uploading audio...
								</Trans>
							</Text>
						</Group>
					)}

					<Button
						onClick={handleReconnect}
						loading={isReconnecting}
						disabled={isReconnecting || uploadChunkMutation.isPending}
						fullWidth
						radius="md"
						size="xl"
						{...testId("portal-audio-interruption-reconnect-button")}
					>
						<Trans id="participant.button.interruption.reconnect">
							Reconnect
						</Trans>
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
					bg="var(--app-background)"
					gap="lg"
					className="sticky bottom-0 z-10 w-full min-h-[84px] border-t border-slate-300 p-4"
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
						{/* Recording time indicator - show when recording OR when stop modal is open OR when interruption modal is open OR resuming */}
						{(isRecording ||
							opened ||
							interruptionModalOpened ||
							stoppedRecordingTime !== null) && (
							<div
								className="border-slate-300"
								{...testId("portal-audio-recording-timer")}
							>
								<Group justify="center" align="center" gap="xs" mih={50}>
									{opened ||
									interruptionModalOpened ||
									stoppedRecordingTime !== null ? (
										<IconPlayerPause />
									) : (
										<div className="h-4 w-4 animate-pulse rounded-full bg-red-500" />
									)}
									<Text className="text-2xl">
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
										radius="md"
										rightSection={<IconMicrophone />}
										onClick={() => {
											startRecording();
											// Obtain wakelock on user interaction
											if (wakeLock.isSupported) {
												wakeLock.obtainWakeLock();
												wakeLock.enableAutoReacquire();
											}
										}}
										className="flex-grow"
										{...testId("portal-audio-record-button")}
									>
										<Trans id="participant.button.record">Record</Trans>
									</Button>

									<I18nLink to={textModeUrl}>
										<Button
											size="lg"
											variant="outline"
											px="lg"
											{...testId("portal-audio-switch-to-text-button")}
										>
											<IconTextCaption />
										</Button>
									</I18nLink>

									{!isStopping && chunks?.data && chunks.data.length > 0 && (
										<Button
											size="lg"
											onClick={open}
											variant="outline"
											rightSection={<IconCheck className="hidden sm:block" />}
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
											radius={100}
											onClick={handleRefineClick}
											disabled={isStopping || isRefineDisabled}
											className="relative overflow-hidden"
											variant={
												recordingTime < REFINE_BUTTON_THRESHOLD_SECONDS
													? "light"
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
												<Trans id="participant.button.refine">Refine</Trans>
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
									{...testId("portal-audio-stop-button")}
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
