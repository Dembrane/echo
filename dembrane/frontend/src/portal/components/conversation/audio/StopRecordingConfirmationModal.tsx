import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import {
	CheckCircleIcon,
	SealCheckIcon,
	WifiSlashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { TipBanner } from "@/components/common/TipBanner";
import { testId } from "@/lib/testUtils";

type StopRecordingConfirmationModalProps = {
	opened: boolean;
	close: () => void;
	/** Finishing: waiting for the audio and the finish to reach the server. */
	isStopping: boolean;
	isOnline?: boolean;
	/** This conversation's chunks since the page loaded: `sent` of `total`. */
	uploadProgress?: { sent: number; total: number };
	handleConfirmFinish: () => void;
	/** Also calls off a finish still waiting on the audio. */
	handleResume: () => void;
	handleSwitchToText: () => void;
	showVerifyOnFinish?: boolean;
	handleSkipVerification?: () => void;
	handleVerify?: () => void;
};

export const StopRecordingConfirmationModal = ({
	opened,
	close,
	isStopping,
	isOnline = true,
	uploadProgress = { sent: 0, total: 0 },
	handleConfirmFinish,
	handleResume,
	handleSwitchToText,
	showVerifyOnFinish = false,
	handleSkipVerification,
	handleVerify,
}: StopRecordingConfirmationModalProps) => {
	const { sent, total } = uploadProgress;
	const isComplete = sent === total;
	// Offline the audio can't be sent, so finishing can't be either. Once
	// started, a finish waits out a lost connection.
	const canFinish = isOnline && !isStopping;
	const [showVerifyPrompt, setShowVerifyPrompt] = useState(false);

	const handleClose = () => {
		handleResume();
		setShowVerifyPrompt(false);
		close();
	};

	const handleFinishClick = () => {
		if (showVerifyOnFinish) {
			setShowVerifyPrompt(true);
			return;
		}
		handleConfirmFinish();
	};

	const handleModalClose = () => {
		if (isStopping) return;
		setShowVerifyPrompt(false);
		handleClose();
	};

	return (
		<Modal
			opened={opened}
			onClose={handleModalClose}
			closeOnClickOutside={!isStopping}
			closeOnEscape={!isStopping}
			centered
			title={
				showVerifyPrompt ? (
					<Trans id="participant.modal.verify_prompt.title">
						Verification reminder
					</Trans>
				) : (
					<Trans id="participant.modal.pause.title">Recording paused</Trans>
				)
			}
			size="sm"
			padding="xl"
			{...testId("portal-audio-stop-modal")}
		>
			<Stack gap="lg">
				{showVerifyPrompt ? (
					<>
						<Text size="sm" c="dimmed">
							<Trans id="participant.modal.verify_prompt.description">
								You haven't verified any outcomes yet. Would you like to verify
								before finishing?
							</Trans>
						</Text>
						<Group gap="sm" py="sm">
							<Button
								variant="filled"
								onClick={() => {
									setShowVerifyPrompt(false);
									handleVerify?.();
								}}
								miw={100}
								size="md"
								leftSection={<SealCheckIcon size={20} />}
								{...testId("portal-audio-verify-button")}
							>
								<Trans id="participant.button.verify_prompt.verify">
									Verify
								</Trans>
							</Button>
							<Button
								variant="subtle"
								color="gray"
								onClick={() => {
									setShowVerifyPrompt(false);
									handleSkipVerification?.();
								}}
								disabled={!isOnline}
								miw={100}
								size="md"
								{...testId("portal-audio-verify-skip-button")}
							>
								<Trans id="participant.button.verify_prompt.skip">Skip</Trans>
							</Button>
						</Group>
					</>
				) : (
					<>
						{/* Also why Finish is greyed out, so it shows even with nothing queued. */}
						{!isOnline && (
							<TipBanner
								icon={WifiSlashIcon}
								message={t`Connection lost. Your audio will continue to be saved on device.`}
								color="yellow"
							/>
						)}

						{/* Stays once everything is sent, so it doesn't flash by. */}
						{total > 0 && (
							<Group
								gap="xs"
								justify="flex-start"
								py="xs"
								wrap="nowrap"
								{...testId("portal-audio-upload-progress")}
							>
								{isComplete ? (
									<CheckCircleIcon size={20} color="var(--app-success)" />
								) : (
									// The size of the check's drawn circle, not its 20px box.
									<Loader size={16} />
								)}
								<Text size="sm" c="dimmed">
									{isComplete ? (
										<Trans id="participant.modal.upload_complete">
											Upload complete: {sent} of{" "}
											<Plural value={total} one="# part" other="# parts" /> sent
										</Trans>
									) : isOnline ? (
										<Trans id="participant.modal.upload_in_progress">
											Uploading audio: {sent} of{" "}
											<Plural value={total} one="# part" other="# parts" /> sent
										</Trans>
									) : (
										<Trans id="participant.modal.upload_awaiting_connection">
											Awaiting connection: {sent} of{" "}
											<Plural value={total} one="# part" other="# parts" /> sent
										</Trans>
									)}
								</Text>
							</Group>
						)}

						<Group gap="sm" py="sm">
							<Button
								variant="filled"
								onClick={handleClose}
								miw={100}
								size="md"
								{...testId("portal-audio-stop-resume-button")}
							>
								<Trans id="participant.button.stop.resume">Resume</Trans>
							</Button>
							<Button
								onClick={handleFinishClick}
								loading={isStopping}
								disabled={!canFinish}
								miw={100}
								size="md"
								leftSection={
									showVerifyOnFinish ? <SealCheckIcon size={20} /> : undefined
								}
								{...testId("portal-audio-stop-finish-button")}
							>
								<Trans id="participant.button.stop.finish">Finish</Trans>
							</Button>
						</Group>
						<Anchor
							component="button"
							onClick={handleSwitchToText}
							size="sm"
							pt="sm"
							ta="left"
							disabled={isStopping}
							{...testId("portal-audio-stop-switch-to-text-link")}
						>
							<Trans id="participant.link.switch.text">
								Switch to text input
							</Trans>
						</Anchor>
					</>
				)}
			</Stack>
		</Modal>
	);
};
