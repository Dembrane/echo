import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { WarningIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

type RecordingInterruptedModalProps = {
	opened: boolean;
	isReconnecting: boolean;
	onReconnect: () => void;
};

/** The recorder lost audio; the only way on is to reconnect. Queued audio sends after the reload. */
export const RecordingInterruptedModal = ({
	opened,
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

			<Button
				onClick={onReconnect}
				loading={isReconnecting}
				disabled={isReconnecting}
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
