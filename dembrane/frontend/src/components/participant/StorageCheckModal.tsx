import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { WarningIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";
import type { S3Status } from "./hooks/useS3ConnectivityCheck";

type StorageCheckModalProps = {
	status: S3Status;
	onReconnect: () => void;
};

/** Blocks recording while audio storage can't be reached. */
export const StorageCheckModal = ({
	status,
	onReconnect,
}: StorageCheckModalProps) => (
	<Modal
		opened={status === "failed"}
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
				<Trans id="participant.modal.s3check.title">Connection issue</Trans>
			</Group>
		}
		role="alertdialog"
		aria-live="assertive"
		aria-atomic="true"
		{...testId("portal-audio-s3-check-modal")}
	>
		<Stack gap="md">
			<Text>
				<Trans id="participant.modal.s3check.message">
					Something is blocking your connection. Your audio will not be saved
					unless this is resolved.
				</Trans>
			</Text>
			<Text size="sm" c="dimmed">
				<Trans id="participant.modal.s3check.suggestions">
					This can happen when a VPN or firewall is blocking the connection. Try
					disabling your VPN, switching to a different network (e.g. mobile
					hotspot), or contact your IT department for help.
				</Trans>
			</Text>
			<Button
				onClick={onReconnect}
				loading={status === "checking"}
				disabled={status === "checking"}
				fullWidth
				variant="filled"
				size="lg"
				{...testId("portal-audio-s3-check-reconnect-button")}
			>
				<Trans id="participant.button.s3check.reconnect">Reconnect</Trans>
			</Button>
		</Stack>
	</Modal>
);
