import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
} from "@mantine/core";

type StopRecordingConfirmationModalProps = {
	opened: boolean;
	close: () => void;
	isStopping: boolean;
	isUploading?: boolean;
	handleConfirmFinish: () => void;
	handleResume: () => void;
	handleSwitchToText: () => void;
};

export const StopRecordingConfirmationModal = ({
	opened,
	close,
	isStopping,
	isUploading = false,
	handleConfirmFinish,
	handleResume,
	handleSwitchToText,
}: StopRecordingConfirmationModalProps) => {
	const isFinishDisabled = isStopping || isUploading;

	const handleClose = () => {
		handleResume();
		close();
	};

	return (
		<Modal
			opened={opened}
			onClose={isStopping ? () => {} : handleClose}
			closeOnClickOutside={!isStopping}
			closeOnEscape={!isStopping}
			centered
			title={
				<Text fw={500}>
					<Trans id="participant.modal.pause.title">Recording Paused</Trans>
				</Text>
			}
			size="sm"
			radius="md"
			padding="xl"
		>
			<Stack gap="lg">
				{/* Uploading indicator */}
				{isUploading && (
					<Group gap="xs" justify="flex-start" py="xs">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							<Trans id="participant.modal.uploading">
								Uploading audio...
							</Trans>
						</Text>
					</Group>
				)}

				<Group grow gap="md" py="sm">
					<Button
						onClick={handleClose}
						disabled={isStopping}
						miw={100}
						radius="md"
						size="md"
					>
						<Trans id="participant.button.stop.resume">Resume</Trans>
					</Button>
					<Button
						variant="default"
						onClick={handleConfirmFinish}
						loading={isStopping}
						disabled={isFinishDisabled}
						miw={100}
						radius="md"
						size="md"
					>
						<Trans id="participant.button.stop.finish">Finish</Trans>
					</Button>
				</Group>
				<Anchor
					component="button"
					onClick={handleSwitchToText}
					c="blue"
					size="sm"
					pt="sm"
					ta="left"
					disabled={isStopping}
				>
					<Trans id="participant.link.switch.text">Switch to text input</Trans>
				</Anchor>
			</Stack>
		</Modal>
	);
};
