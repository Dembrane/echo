import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	CloseButton,
	FileButton,
	Group,
	Image,
	Modal,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { Paperclip } from "@phosphor-icons/react";
import { IconPlayerStopFilled } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CharsRemainingIndicator } from "@/components/common/CharsRemainingIndicator";
import { toast } from "@/components/common/Toaster";
import { useVoiceTranscription } from "@/components/voice/useVoiceTranscription";
import { VoiceInputButton } from "@/components/voice/VoiceInputButton";
import { VoiceInputError } from "@/components/voice/VoiceInputError";
import { VoiceRecordingBar } from "@/components/voice/VoiceRecordingBar";
import { mergeTranscriptIntoDraft } from "@/components/voice/voiceInput";
import { IssueReportError, useSubmitIssueReportMutation } from "./hooks";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_FILES = 4;
const MAX_FILE_MB = 10;
const MAX_MESSAGE_CHARS = 5000;
// Past this the field scrolls instead of the modal.
const MAX_MESSAGE_ROWS = 20;

const getReplayUrl = (): string | undefined => {
	try {
		return posthog.get_session_replay_url({ withTimestamp: true });
	} catch {
		return undefined;
	}
};

export const ReportIssueModal = ({
	opened,
	onClose,
	locale,
	workspaceId,
	projectId,
}: {
	opened: boolean;
	onClose: () => void;
	locale?: string;
	workspaceId?: string;
	projectId?: string;
}) => {
	const [message, setMessage] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const resetFileInput = useRef<() => void>(null);
	const mutation = useSubmitIssueReportMutation();
	// Dictation lands in the textarea to be read over, never sent on its own.
	const voice = useVoiceTranscription({
		language: locale?.split("-")[0],
		onTranscript: (transcript) =>
			setMessage((current) =>
				mergeTranscriptIntoDraft(current, transcript).slice(
					0,
					MAX_MESSAGE_CHARS,
				),
			),
		...(projectId ? { projectId } : { purpose: "issue_report" as const }),
	});
	const isVoiceActive = voice.status !== "idle";
	const atMessageLimit = message.length >= MAX_MESSAGE_CHARS;

	const previews = useMemo(
		() => files.map((file) => URL.createObjectURL(file)),
		[files],
	);

	useEffect(
		() => () => {
			for (const url of previews) URL.revokeObjectURL(url);
		},
		[previews],
	);

	// Validation happens outside setState so the updater stays pure and toasts fire once.
	const addFiles = useCallback(
		(incoming: File[]) => {
			const accepted: File[] = [];
			let error: string | undefined;
			for (const file of incoming) {
				if (!ALLOWED_TYPES.includes(file.type)) {
					error ??= t`Only images can be attached`;
					continue;
				}
				if (file.size > MAX_FILE_MB * 1024 * 1024) {
					error ??= t`Images must be under ${MAX_FILE_MB}MB`;
					continue;
				}
				if (files.length + accepted.length >= MAX_FILES) {
					error ??= t`Up to ${MAX_FILES} images`;
					break;
				}
				accepted.push(file);
			}
			if (error) toast.error(error);
			if (accepted.length > 0) setFiles([...files, ...accepted]);
			// Without this the same file cannot be picked again after removing it.
			resetFileInput.current?.();
		},
		[files],
	);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent) => {
			const pasted = Array.from(event.clipboardData.files);
			if (pasted.length > 0) addFiles(pasted);
		},
		[addFiles],
	);

	const handleClose = () => {
		voice.cancel();
		onClose();
	};

	// Reset only after the close animation, so the content does not blank mid-fade.
	const resetForm = () => {
		setMessage("");
		setFiles([]);
	};

	const handleSubmit = () => {
		mutation.mutate(
			{
				attachments: files,
				locale,
				message: message.trim(),
				pageUrl: window.location.href,
				projectId,
				sessionReplayUrl: getReplayUrl(),
				userAgent: navigator.userAgent,
				workspaceId,
			},
			{
				onError: (error) => {
					const status = error instanceof IssueReportError ? error.status : 0;
					if (status === 429) {
						toast.error(t`Too many reports. Wait a few minutes and try again`);
					} else if (status === 400) {
						toast.error(t`Check the text and images, then try again`);
					} else {
						toast.error(t`Could not send the report. Try again`);
					}
				},
				onSuccess: (result) => {
					const attachmentCount = files.length;
					toast.success(t`Report sent. Thank you`);
					handleClose();
					try {
						posthog.capture("issue_report_submitted", {
							attachment_count: attachmentCount,
							report_id: result.report_id,
							support_request_id: result.support_request_id,
						});
					} catch {
						// analytics must never block the confirmation
					}
				},
			},
		);
	};

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			onExitTransitionEnd={resetForm}
			title={<Trans>Report an issue</Trans>}
			size="lg"
			data-testid="report-issue-modal"
		>
			<Stack>
				{voice.errorKind && (
					<VoiceInputError
						kind={voice.errorKind}
						onDismiss={voice.dismissError}
					/>
				)}
				{/* One input frame: the text scrolls, the footer with mic controls does not. */}
				<Box
					className="border border-[var(--mantine-color-default-border)] focus-within:border-[var(--mantine-primary-color-filled)]"
					px="sm"
					pt="xs"
					pb="xs"
					style={{
						backgroundColor: "var(--app-background)",
						borderRadius: "var(--mantine-radius-default)",
					}}
				>
					<Textarea
						value={message}
						onChange={(event) => setMessage(event.currentTarget.value)}
						onPaste={handlePaste}
						readOnly={isVoiceActive}
						aria-label={t`Describe the issue`}
						placeholder={t`What happened? Paste a screenshot here to attach it`}
						maxLength={MAX_MESSAGE_CHARS}
						minRows={6}
						maxRows={MAX_MESSAGE_ROWS}
						autosize
						resize="none"
						variant="unstyled"
						styles={{ input: { backgroundColor: "transparent", padding: 0 } }}
						data-testid="report-issue-message"
					/>
					<Group
						justify="flex-end"
						align="center"
						gap="sm"
						wrap="nowrap"
						mt="xs"
					>
						{isVoiceActive && (
							<Box className="flex-1">
								<VoiceRecordingBar
									elapsedMs={voice.elapsedMs}
									isTranscribing={voice.status === "transcribing"}
									levels={voice.levels}
								/>
							</Box>
						)}
						{voice.status === "recording" ? (
							<Button
								aria-label={t`Stop recording and turn it into text`}
								onClick={voice.stop}
								rightSection={<IconPlayerStopFilled size={18} />}
								size="compact-sm"
								type="button"
								data-testid="report-issue-voice-stop"
							>
								<Trans>Stop</Trans>
							</Button>
						) : voice.status === "transcribing" ? null : (
							<VoiceInputButton
								ariaLabel={t`Record a voice message`}
								disabled={voice.isStarting || atMessageLimit}
								onClick={voice.start}
								testId="report-issue-voice-record"
								tooltip={
									atMessageLimit
										? t`Up to ${MAX_MESSAGE_CHARS} characters`
										: undefined
								}
							/>
						)}
					</Group>
				</Box>
				<CharsRemainingIndicator value={message} max={MAX_MESSAGE_CHARS} />
				{files.length > 0 && (
					<Group gap="xs">
						{files.map((file, index) => (
							<Group key={`${file.name}-${index}`} gap={4}>
								<Image
									src={previews[index]}
									w={56}
									h={56}
									fit="cover"
									radius="sm"
									alt={file.name}
								/>
								<CloseButton
									size="sm"
									aria-label={t`Remove ${file.name}`}
									onClick={() =>
										setFiles((current) => current.filter((_, i) => i !== index))
									}
								/>
							</Group>
						))}
					</Group>
				)}
				<Group justify="space-between">
					<Group gap="xs">
						<FileButton
							onChange={(picked) => addFiles(picked)}
							resetRef={resetFileInput}
							accept={ALLOWED_TYPES.join(",")}
							multiple
						>
							{(props) => (
								<Button
									{...props}
									variant="subtle"
									leftSection={<Paperclip size={16} />}
								>
									<Trans>Add images</Trans>
								</Button>
							)}
						</FileButton>
						<Text size="xs">({t`Up to ${MAX_FILES} images`})</Text>
					</Group>
					<Button
						onClick={handleSubmit}
						loading={mutation.isPending}
						disabled={message.trim().length === 0 || isVoiceActive}
						data-testid="report-issue-submit"
					>
						<Trans>Send report</Trans>
					</Button>
				</Group>
				<Text size="sm">
					<Trans>
						Your name, email and current page are included so we can follow up.
					</Trans>
				</Text>
			</Stack>
		</Modal>
	);
};
