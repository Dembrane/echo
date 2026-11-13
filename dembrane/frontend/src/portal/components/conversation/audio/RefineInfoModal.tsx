import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Modal, Stack, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";

type RefineInfoModalProps = {
	opened: boolean;
	onClose: () => void;
	showVerify: boolean;
	showEcho: boolean;
	remainingSeconds: number;
};

const RefineInfoTitle = ({
	showVerify,
	showEcho,
}: Pick<RefineInfoModalProps, "showVerify" | "showEcho">) => {
	if (showVerify && showEcho) {
		return (
			<Trans id="participant.modal.refine.info.title.both">
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
		<Trans id="participant.modal.echo.info.title">Feature available soon</Trans>
	);
};

const refineInfoText = (showVerify: boolean, showEcho: boolean) => {
	if (showVerify && showEcho) {
		return t`Check what we captured together, or get a question to go deeper.`;
	}
	if (showVerify) {
		return t`Check what we captured together.`;
	}
	if (showEcho) {
		return t`Get a question to go deeper.`;
	}
	return "";
};

/** Explains why ECHO isn't available until the recording is long enough. */
export const RefineInfoModal = ({
	opened,
	onClose,
	showVerify,
	showEcho,
	remainingSeconds,
}: RefineInfoModalProps) => (
	<Modal
		opened={opened}
		onClose={onClose}
		centered
		size="sm"
		padding="xl"
		title={<RefineInfoTitle showVerify={showVerify} showEcho={showEcho} />}
		{...testId("portal-audio-echo-info-modal")}
	>
		<Stack gap="lg">
			<Text>{refineInfoText(showVerify, showEcho)}</Text>
			<Text c="dimmed" size="sm">
				<Trans id="participant.modal.refine.info.reason">
					We need a bit more of your conversation first. Please keep recording.
				</Trans>
			</Text>
			<Text c="dimmed" size="sm">
				<Trans id="participant.modal.refine.info.available.in">
					This feature will be available in {remainingSeconds} seconds.
				</Trans>
			</Text>
			<Button
				onClick={onClose}
				fullWidth
				variant="filled"
				size="md"
				{...testId("portal-audio-echo-info-close-button")}
			>
				<Trans id="participant.button.i.understand">I understand</Trans>
			</Button>
		</Stack>
	</Modal>
);
