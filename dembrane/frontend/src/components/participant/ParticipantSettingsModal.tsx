import { Trans } from "@lingui/react/macro";
import { Modal } from "@mantine/core";
import { testId } from "@/lib/testUtils";
import MicrophoneTest from "./MicrophoneTest";

interface ParticipantSettingsModalProps {
	opened: boolean;
	onClose: () => void;
	onMicTestSuccess?: (success: boolean) => void;
}

export function ParticipantSettingsModal({
	opened,
	onClose,
	onMicTestSuccess = () => {},
}: ParticipantSettingsModalProps) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={<Trans id="participant.settings.modal.title">Settings</Trans>}
			size="sm"
			padding="xl"
			centered
			{...testId("portal-settings-modal")}
		>
			<MicrophoneTest
				onContinue={(_id: string) => {
					onClose();
				}}
				onMicTestSuccess={onMicTestSuccess}
				isInModal={true}
			/>
		</Modal>
	);
}
