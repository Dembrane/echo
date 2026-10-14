import { Trans } from "@lingui/react/macro";
import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { WarningIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

type RecordingInterruptedModalProps = {
	opened: boolean;
	isUploading: boolean;
	isReconnecting: boolean;
	onReconnect: () => void;
};

/** The recorder lost audio; the only way on is to reconnect. */
export const RecordingInterruptedModal = ({
	opened,
	isUploading,
	isReconnecting,
	onReconnect,
}: RecordingInterruptedModalProps) => (
	<Modal
		opened={opened}
		onClose={() => {}}
		withCloseButton={false}
		centered
		size="sm"
		padding="xl"
		closeOnClickOutside={false}
		closeOnEscape={false}
		title={
			<Group gap="sm" wrap="nowrap">
				<WarningIcon size={20} color="var(--mantine-color-error)" />
				<Trans id="participant.modal.interruption.title">
					Recording interrupted
				</Trans>
			</Group>
		}
		role="alertdialog"
		aria-live="assertive"
		aria-atomic="true"
		{...testId("portal-audio-interruption-modal")}
	>
		<Stack gap="md">
			<Text>
				<Trans id="participant.modal.interruption.issue.message">
					Attention! We lost the last 60 seconds or so of your recording due to
					some interruption. Please press the button below to reconnect.
				</Trans>
			</Text>

			{/* Uploading indicator - same pattern as StopRecordingConfirmationModal */}
			{isUploading && (
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
				onClick={onReconnect}
				loading={isReconnecting}
				disabled={isReconnecting || isUploading}
				fullWidth
				variant="filled"
				size="lg"
				{...testId("portal-audio-interruption-reconnect-button")}
			>
				<Trans id="participant.button.interruption.reconnect">Reconnect</Trans>
			</Button>
		</Stack>
	</Modal>
);
