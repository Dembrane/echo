import { Trans } from "@lingui/react/macro";
import { Button, Modal, Stack, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";

export const WrapUpModal = ({
	opened,
	reason,
	onFinish,
	isFinishing = false,
}: {
	opened: boolean;
	reason: "conversation" | "account";
	onFinish: () => void;
	isFinishing?: boolean;
}) => (
	<Modal
		opened={opened}
		onClose={() => {}}
		withCloseButton={false}
		closeOnClickOutside={false}
		closeOnEscape={false}
		centered
		size="sm"
		padding="xl"
		title={<Trans id="participant.modal.wrap_up.title">That's a wrap</Trans>}
		{...testId("portal-audio-wrap-up-modal")}
	>
		<Stack gap="lg">
			<Text>
				{reason === "conversation" ? (
					<Trans id="participant.modal.wrap_up.conversation">
						This conversation has reached its maximum length. Everything you
						recorded is saved.
					</Trans>
				) : (
					<Trans id="participant.modal.wrap_up.account">
						Recording has stopped for now. Everything you recorded is saved.
					</Trans>
				)}
			</Text>
			<Button
				onClick={onFinish}
				loading={isFinishing}
				fullWidth
				variant="filled"
				size="lg"
				{...testId("portal-audio-wrap-up-finish-button")}
			>
				<Trans id="participant.modal.wrap_up.finish">Finish</Trans>
			</Button>
		</Stack>
	</Modal>
);
