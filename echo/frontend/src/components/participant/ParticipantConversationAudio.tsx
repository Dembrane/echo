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
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { ENABLE_MONITOR } from "@/config";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useVideoWakeLockFallback } from "@/hooks/useVideoWakeLockFallback";
import { useWakeLock } from "@/hooks/useWakeLock";
import {
	finishConversation,
	pingConversation,
	pingConversationLeft,
} from "@/lib/api";
import {
	readBatteryTelemetry,
	readNetworkTelemetry,
} from "@/lib/deviceTelemetry";
import { testId } from "@/lib/testUtils";
import { getVisitorId } from "@/lib/visitorId";
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
import { useS3ConnectivityCheck } from "./hooks/useS3ConnectivityCheck";
import { PermissionErrorModal } from "./PermissionErrorModal";
import { StopRecordingConfirmationModal } from "./StopRecordingConfirmationModal";
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
	const artefactsQuery = useConversationArtefacts(conversationId);
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
		// Capture the recording time before stopping.
		interruptionRecordingTimeRef.current = audioRecorder.recordingTime;

		// Fire at detection, not only if the user later reconnects.
		const chunkHistory = audioRecorder.getChunkHistory();
		posthog.capture("portal_recording_interrupted", {
			conversation_id: conversationId,
			project_id: projectId,
			recording_time_seconds: interruptionRecordingTimeRef.current,
			suspicious_chunk_count: chunkHistory.filter((c) => c.size < 1024).length,
			total_chunks: chunkHistory.length,
		});

		// Stop recording and release wake lock.
		audioRecorder.stopRecording();
		wakeLock.releaseWakeLock();
		wakeLock.disableAutoReacquire();

		// Show the interruption modal.
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

	// Keep the latest audio-level reader in a ref so the (state-scoped) beacon
	// effect can sample it each tick without re-subscribing every render.
	const getAudioLevelRef = useRef(audioRecorder.getAudioLevel);
	getAudioLevelRef.current = audioRecorder.getAudioLevel;

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

	// Tab hidden / phone locked — iOS suspends the mic, so recording effectively
	// pauses. We report this as its own gentle state (not a scary "no audio"),
	// and it fires an immediate beacon via the state-change effect below.
	const [documentHidden, setDocumentHidden] = useState(
		typeof document !== "undefined" ? document.hidden : false,
	);
	useEffect(() => {
		const onVisibility = () => setDocumentHidden(document.hidden);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onVisibility);
		};
	}, []);

	// Snapshot of ticking state so the edge-triggered effects below don't re-subscribe each tick.
	const recordingScreenStateRef = useRef({ isRecording, recordingTime });
	recordingScreenStateRef.current = { isRecording, recordingTime };

	// Backgrounding while recording is our proxy for a call/lock/tab-switch; edge-triggered per transition.
	const backgroundedAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!conversationId) return;
		if (documentHidden && isRecording && backgroundedAtRef.current === null) {
			backgroundedAtRef.current = Date.now();
			posthog.capture("portal_recording_backgrounded", {
				conversation_id: conversationId,
				project_id: projectId,
				recording_time_seconds: recordingScreenStateRef.current.recordingTime,
			});
		} else if (!documentHidden && backgroundedAtRef.current !== null) {
			posthog.capture("portal_recording_foregrounded", {
				backgrounded_seconds: Math.round(
					(Date.now() - backgroundedAtRef.current) / 1000,
				),
				conversation_id: conversationId,
				project_id: projectId,
			});
			backgroundedAtRef.current = null;
		}
	}, [documentHidden, isRecording, conversationId, projectId]);

	// Browser-level connectivity (radio drop), distinct from the per-chunk upload failures below.
	const offlineAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!conversationId) return;
		const onOffline = () => {
			if (offlineAtRef.current !== null) return;
			offlineAtRef.current = Date.now();
			posthog.capture("portal_network_offline", {
				conversation_id: conversationId,
				effective_type: readNetworkTelemetry()?.effective_type,
				project_id: projectId,
				recording_time_seconds: recordingScreenStateRef.current.recordingTime,
			});
		};
		const onOnline = () => {
			if (offlineAtRef.current === null) return;
			posthog.capture("portal_network_online", {
				conversation_id: conversationId,
				offline_seconds: Math.round((Date.now() - offlineAtRef.current) / 1000),
				project_id: projectId,
			});
			offlineAtRef.current = null;
		};
		window.addEventListener("offline", onOffline);
		window.addEventListener("online", onOnline);
		return () => {
			window.removeEventListener("offline", onOffline);
			window.removeEventListener("online", onOnline);
		};
	}, [conversationId, projectId]);

	// What the participant is doing right now, for the host monitor. Reported
	// with every beacon so the monitor can show recording / paused / verifying
	// / backgrounded / just-waiting between audio chunks.
	const participantState = isStopping
		? "finishing"
		: documentHidden && isRecording
			? "backgrounded"
			: isOnVerifyRoute
				? "verifying"
				: isOnRefineRoute
					? "refining"
					: isRecording
						? "recording"
						: stoppedRecordingTime !== null
							? "paused"
							: "waiting";

	// Liveness + telemetry beacon. Runs the whole time the participant is on the
	// conversation screen (not just while recording) so the monitor sees a
	// session the moment it is initiated, and reflects pauses / verify without
	// waiting for the next chunk. Best-effort; failures never disrupt recording.
	useEffect(() => {
		// Monitor off: no host reads these, so don't collect/beacon telemetry.
		if (!conversationId || !ENABLE_MONITOR) return;
		let cancelled = false;
		const sendPing = async () => {
			// Stamp before the battery await so a ping delayed by getBattery keeps
			// its initiation time and can't out-order a later "left" beacon.
			const client_ts = Date.now();
			// Backgrounded/locked: skip the extra device reads (battery is an
			// async native call, network reads sensor state) to avoid waking the
			// device just to report telemetry nobody is looking at. Still send
			// the lightweight state ping so the monitor sees "backgrounded".
			const hidden = document.hidden;
			const battery = hidden ? undefined : await readBatteryTelemetry();
			if (cancelled) return;
			const rawLevel = getAudioLevelRef.current?.();
			const audio_level =
				typeof rawLevel === "number" && Number.isFinite(rawLevel)
					? Math.round(Math.min(1, Math.max(0, rawLevel)) * 100) / 100
					: undefined;
			void pingConversation(conversationId, {
				audio_level,
				battery,
				client_ts,
				mode: "voice",
				network: hidden ? undefined : readNetworkTelemetry(),
				project_id: projectId,
				state: participantState,
				visitor_id: projectId ? getVisitorId(projectId) : undefined,
			});
		};
		void sendPing();
		// A snappier beacon while on the recording screen so the host sees state
		// changes in a few seconds rather than tens of seconds.
		const interval = setInterval(() => void sendPing(), 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [conversationId, projectId, participantState]);

	// Terminal "left" beacon on tab close (fires on real unload, not SPA
	// navigation), so a graceful exit shows as "left" on the host monitor
	// instead of aging paused -> idle -> finished over minutes.
	const abandonStateRef = useRef({
		isRecording,
		participantState,
		recordingTime,
	});
	abandonStateRef.current = { isRecording, participantState, recordingTime };
	useEffect(() => {
		if (!conversationId || !ENABLE_MONITOR) return;
		const onPageHide = () => {
			pingConversationLeft(conversationId, projectId);
			if (abandonStateRef.current.isRecording) {
				posthog.capture("portal_abandoned", {
					conversation_id: conversationId,
					participant_state: abandonStateRef.current.participantState,
					pending_uploads: pendingUploadsRef.current.length,
					project_id: projectId,
					recording_time_seconds: abandonStateRef.current.recordingTime,
				});
			}
		};
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, [conversationId, projectId]);

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
					posthog.capture("portal_uploads_incomplete_on_finish", {
						context: "finish",
						conversation_id: conversationId,
						pending_uploads: pendingUploadsRef.current.length,
						project_id: projectId,
					});
				}
			}

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

	// Report interruption to PostHog error tracking
	const reportInterruption = () => {
		if (!audioRecorder.hadInterruption) return;

		const chunkHistory = audioRecorder.getChunkHistory();

		// Send to PostHog error tracking
		posthog.captureException(
			new Error("Recording interrupted by consecutive suspicious chunks"),
			{
				chunkSizes: chunkHistory.map((c) => c.size),
				conversationId,
				deviceInfo: navigator.userAgent,
				issue_type: "audio_interruption",
				platform: "participant_portal",
				projectId,
				recordingDurationSeconds: interruptionRecordingTimeRef.current,
				suspiciousChunkIndices: chunkHistory
					.map((c, i) => (c.size < 1024 ? i : -1))
					.filter((i) => i >= 0),
				totalChunks: chunkHistory.length,
			},
		);

		// Also emit a plain event so we can chart a recording-error rate (the
		// exception above lands in error tracking, which doesn't funnel cleanly).
		posthog.capture("portal_recording_error", {
			conversation_id: conversationId,
			issue_type: "audio_interruption",
			project_id: projectId,
			recording_duration_seconds: interruptionRecordingTimeRef.current,
			total_chunks: chunkHistory.length,
		});
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
					posthog.capture("portal_uploads_incomplete_on_finish", {
						context: "reconnect",
						conversation_id: conversationId,
						pending_uploads: pendingUploadsRef.current.length,
						project_id: projectId,
					});
				}
			}

			reportInterruption();

			window.location.reload();
		} catch (_error) {
			toast.error(t`Failed to reconnect. Please try reloading the page.`);
			setIsReconnecting(false);
		}
	};

	const handleStartRecording = () => {
		if (s3Status !== "passed") {
			return;
		}

		startRecording();
		posthog.capture("recording_started", {
			conversation_id: conversationId,
			project_id: projectId,
		});
		if (wakeLock.isSupported) {
			wakeLock.obtainWakeLock();
			wakeLock.enableAutoReacquire();
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
			return t`Take some time to create an outcome that makes your contribution concrete or get an immediate reply from dembrane to help you deepen the conversation.`;
		}
		if (showVerify) {
			return t`Take some time to create an outcome that makes your contribution concrete.`;
		}
		if (showEcho) {
			return t`Get an immediate reply from dembrane to help you deepen the conversation.`;
		}
		return "";
	};

	const getRefineModalTitle = () => {
		if (showVerify && showEcho) {
			return (
				<Trans id="participant.modal.echo.info.title.generic">
					"ECHO" available soon
				</Trans>
			);
		}
		if (showVerify) {
			return (
				<Trans id="participant.modal.echo.info.title.concrete">
					"Verify" available soon
				</Trans>
			);
		}
		if (showEcho) {
			return (
				<Trans id="participant.modal.echo.info.title.go.deeper">
					"Explore" available soon
				</Trans>
			);
		}
		return (
			<Trans id="participant.modal.echo.info.title">
				Feature available soon
			</Trans>
		);
	};

	const getRefineInfoReason = () => {
		return (
			<Trans id="participant.modal.echo.info.reason">
				We need a bit more context to help you use ECHO effectively. Please
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

			{/* modal for S3 connectivity error */}
			<Modal
				opened={s3Status === "failed"}
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
				{...testId("portal-audio-s3-check-modal")}
			>
				<Stack gap="md">
					<Group gap="xs">
						<IconAlertTriangle size={24} color="#FF9AA2" />
						<Text fw={600} size="lg">
							<Trans id="participant.modal.s3check.title">
								Connection issue
							</Trans>
						</Text>
						<IconAlertTriangle size={24} color="#FF9AA2" />
					</Group>
					<Text>
						<Trans id="participant.modal.s3check.message">
							Something is blocking your connection. Your audio will not be
							saved unless this is resolved.
						</Trans>
					</Text>
					<Text size="sm" c="dimmed">
						<Trans id="participant.modal.s3check.suggestions">
							This can happen when a VPN or firewall is blocking the connection.
							Try disabling your VPN, switching to a different network (e.g.
							mobile hotspot), or contact your IT department for help.
						</Trans>
					</Text>
					<Button
						onClick={handleS3Reconnect}
						loading={s3Status === "checking"}
						disabled={s3Status === "checking"}
						fullWidth
						radius="md"
						size="xl"
						{...testId("portal-audio-s3-check-reconnect-button")}
					>
						<Trans id="participant.button.s3check.reconnect">Reconnect</Trans>
					</Button>
				</Stack>
			</Modal>

			{/* modal for stop recording confirmation */}
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
						recordingTime,
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
										onClick={handleStartRecording}
										loading={s3Status === "checking" || s3Status === "pending"}
										disabled={s3Status !== "passed"}
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
												<Trans id="participant.button.echo">ECHO</Trans>
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
