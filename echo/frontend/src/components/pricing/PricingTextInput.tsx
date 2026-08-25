import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Stack, Text, Textarea } from "@mantine/core";
import { IconPlayerStopFilled } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatComposerShell } from "@/components/chat/ChatComposer";
import { useVoiceRecorder } from "@/components/voice/useVoiceRecorder";
import { VoiceInputButton } from "@/components/voice/VoiceInputButton";
import { VoiceRecordingBar } from "@/components/voice/VoiceRecordingBar";
import {
	formatElapsed,
	isEmptyTranscript,
	mergeTranscriptIntoDraft,
	transcribeErrorKind,
	VOICE_MAX_UPLOAD_BYTES,
	VOICE_MIN_DURATION_MS,
	type VoiceErrorKind,
} from "@/components/voice/voiceInput";
import { transcribeStateless } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import type { VoiceAttachment } from "./submitConfiguration";

/** The one free text control in the configurator, used by all three boxes.
 *
 * It is the agentic chat composer, not a second one. `ChatComposerShell`,
 * `VoiceInputButton` and `VoiceRecordingBar` are reused as they are, and so is
 * the swap that matters: while the mic is open the input is replaced, not
 * disabled. One composer, one way in at a time.
 *
 * It stops short of `useVoiceTranscription` for two reasons, both measured:
 *
 * 1. That hook takes a required `projectId`, and the gate opens from org and
 *    workspace routes where no project exists. The endpoint accepts a named
 *    purpose instead of a project, and the hook has no way to send one.
 * 2. It consumes the recording and throws it away when transcription fails. The
 *    agreed behaviour here keeps the recording, offers one retry, and lets the
 *    audio travel with the answers after the second failure. None of that is
 *    reachable through a hook that never hands the blob back.
 *
 * So this composes `useVoiceRecorder` and the pure rules in `voiceInput.ts`
 * directly. Every ceiling, error mapping and merge rule is the shared one.
 */

type VoiceOutcome = "transcribed" | "blocked" | "failed" | "cancelled";

/** The mic said no. These step the button aside rather than failing a send. */
const BLOCKED_KINDS = new Set<VoiceErrorKind>([
	"permission",
	"unsupported",
	"device",
]);

export const PricingTextInput = ({
	ariaLabelledBy,
	minRows = 3,
	onAudioRetained,
	onChange,
	onSubmit,
	onVoiceAttempt,
	placeholder,
	projectId,
	questionKey,
	testIdPrefix,
	value,
}: {
	ariaLabelledBy?: string;
	minRows?: number;
	/** Called with the recording that never became text, or null once it did.
	 * The audio travels with the answers instead of being lost. */
	onAudioRetained?: (attachment: VoiceAttachment | null) => void;
	onChange: (value: string) => void;
	/** Enter without shift advances the step, the same as the composer sends. */
	onSubmit?: () => void;
	onVoiceAttempt?: (
		outcome: VoiceOutcome,
		attempt: number,
		seconds: number,
	) => void;
	placeholder?: string;
	/** The project the transcription is billed to, where the mount has one.
	 * Without it the call names the intake purpose instead, which the endpoint
	 * accepts unmetered, so the record button renders either way. */
	projectId?: string;
	questionKey: string;
	testIdPrefix: string;
	value: string;
}) => {
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [errorKind, setErrorKind] = useState<VoiceErrorKind | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [pending, setPending] = useState<{
		blob: Blob;
		durationMs: number;
	} | null>(null);
	const [audioUrl, setAudioUrl] = useState<string | null>(null);

	const valueRef = useRef(value);
	valueRef.current = value;
	const abortRef = useRef<AbortController | null>(null);
	const unmountedRef = useRef(false);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			abortRef.current?.abort();
		};
	}, []);

	// The object URL outlives React, so it is revoked when the recording goes.
	useEffect(() => {
		if (!pending) {
			setAudioUrl(null);
			return;
		}
		const url = URL.createObjectURL(pending.blob);
		setAudioUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [pending]);

	const runTranscription = useCallback(
		async (blob: Blob, durationMs: number, thisAttempt: number) => {
			const controller = new AbortController();
			abortRef.current = controller;
			setIsTranscribing(true);
			const seconds = Math.round(durationMs / 1000);
			try {
				// A project is billed for the transcription where the mount has
				// one. Where it does not, the call says what it is for instead,
				// which is the only thing that opens the endpoint without a
				// project to charge.
				const response = await transcribeStateless(
					projectId
						? {
								file: blob,
								filename: "voice-note.webm",
								projectId,
								signal: controller.signal,
							}
						: {
								file: blob,
								filename: "voice-note.webm",
								purpose: "pricing_intake",
								signal: controller.signal,
							},
				);
				if (unmountedRef.current || controller.signal.aborted) return;
				if (isEmptyTranscript(response.transcript)) {
					setErrorKind("empty");
					onVoiceAttempt?.("failed", thisAttempt, seconds);
					onAudioRetained?.({
						blob,
						duration_ms: durationMs,
						question_key: questionKey,
					});
					return;
				}
				onChange(
					mergeTranscriptIntoDraft(valueRef.current, response.transcript),
				);
				setErrorKind(null);
				setPending(null);
				onAudioRetained?.(null);
				onVoiceAttempt?.("transcribed", thisAttempt, seconds);
			} catch (error) {
				if (unmountedRef.current || controller.signal.aborted) return;
				setErrorKind(transcribeErrorKind(error));
				onVoiceAttempt?.("failed", thisAttempt, seconds);
				onAudioRetained?.({
					blob,
					duration_ms: durationMs,
					question_key: questionKey,
				});
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
				if (!unmountedRef.current) setIsTranscribing(false);
			}
		},
		[onAudioRetained, onChange, onVoiceAttempt, projectId, questionKey],
	);

	const recorder = useVoiceRecorder({
		onComplete: ({ blob, durationMs }) => {
			const seconds = Math.round(durationMs / 1000);
			setPending({ blob, durationMs });
			setAttempt(1);
			if (durationMs < VOICE_MIN_DURATION_MS) {
				setErrorKind("too_short");
				onVoiceAttempt?.("failed", 1, seconds);
				return;
			}
			if (blob.size === 0) {
				setErrorKind("empty");
				onVoiceAttempt?.("failed", 1, seconds);
				return;
			}
			if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
				setErrorKind("too_large");
				onVoiceAttempt?.("failed", 1, seconds);
				return;
			}
			void runTranscription(blob, durationMs, 1);
		},
		onError: (kind) => {
			setErrorKind(kind);
			if (BLOCKED_KINDS.has(kind)) onVoiceAttempt?.("blocked", 1, 0);
		},
	});

	const retry = () => {
		if (!pending) return;
		const next = attempt + 1;
		setAttempt(next);
		setErrorKind(null);
		void runTranscription(pending.blob, pending.durationMs, next);
	};

	const isBlocked = errorKind !== null && BLOCKED_KINDS.has(errorKind);
	const isVoiceActive = recorder.isRecording || isTranscribing;
	const voiceAvailable = !isBlocked;
	const showRetry = pending !== null && errorKind !== null && attempt < 2;
	const showFailure = errorKind !== null && !isBlocked;
	// The voice nudge line, which also demonstrates the feature. It sits above
	// every free text box, but ONLY where the record button really renders:
	// telling somebody to press a button that is not there is worse than
	// saying nothing. So the condition is the button's own. It steps aside
	// while the mic is open, because the button it names has become Stop.
	const showVoiceNudge =
		voiceAvailable && !recorder.isRecording && !isTranscribing;

	return (
		<Stack gap="xs">
			{showVoiceNudge && (
				<Text size="sm" {...testId(`${testIdPrefix}-voice-nudge`)}>
					<Trans>Prefer talking? Press record and just say it.</Trans>
				</Text>
			)}
			<ChatComposerShell
				footerRight={
					recorder.isRecording ? (
						<Button
							aria-label={t`Stop recording and turn it into text`}
							className="tap-target"
							onClick={recorder.stop}
							radius="md"
							rightSection={<IconPlayerStopFilled size={18} />}
							size="md"
							type="button"
							{...testId(`${testIdPrefix}-voice-stop`)}
						>
							<Trans>Stop</Trans>
						</Button>
					) : isTranscribing ? null : voiceAvailable ? (
						<VoiceInputButton
							ariaLabel={t`Record a voice message`}
							disabled={recorder.isStarting}
							onClick={() => {
								setErrorKind(null);
								void recorder.start();
							}}
							testId={`${testIdPrefix}-voice-record`}
						/>
					) : null
				}
			>
				{isVoiceActive ? (
					// The input is closed while the mic is open, not merely disabled:
					// one composer, one way in at a time.
					<VoiceRecordingBar
						elapsedMs={recorder.elapsedMs}
						isTranscribing={isTranscribing}
						levels={recorder.levels}
					/>
				) : (
					<Textarea
						aria-labelledby={ariaLabelledBy}
						autosize
						maxRows={10}
						minRows={minRows}
						onChange={(event) => onChange(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								onSubmit?.();
							}
						}}
						placeholder={placeholder}
						styles={{
							input: { backgroundColor: "transparent", resize: "none" },
						}}
						value={value}
						variant="unstyled"
						{...testId(`${testIdPrefix}-input`)}
					/>
				)}
			</ChatComposerShell>

			{isBlocked && (
				<Text size="sm" {...testId(`${testIdPrefix}-voice-blocked`)}>
					<Trans>
						The microphone is blocked in your browser, so recording is off.
						Typing works.
					</Trans>
				</Text>
			)}

			{showFailure && (
				<Box {...testId(`${testIdPrefix}-voice-failed`)}>
					{audioUrl && (
						<audio
							aria-label={t`Your recording, ${formatElapsed(pending?.durationMs ?? 0)}`}
							controls
							src={audioUrl}
						>
							<track kind="captions" />
						</audio>
					)}
					<Text size="sm">
						<Trans>That didn't work out. We have saved your recording.</Trans>
					</Text>
					{showRetry && (
						<Button
							mt="xs"
							onClick={retry}
							size="compact-sm"
							type="button"
							variant="subtle"
							{...testId(`${testIdPrefix}-voice-retry`)}
						>
							<Trans>Try again</Trans>
						</Button>
					)}
				</Box>
			)}
		</Stack>
	);
};
