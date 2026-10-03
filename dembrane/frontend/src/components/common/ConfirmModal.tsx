import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

type ConfirmModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
	title: string;
	message: ReactNode;
	confirmLabel?: ReactNode;
	cancelLabel?: ReactNode;
	confirmColor?: string;
	loading?: boolean;
	"data-testid"?: string;
};

export const ConfirmModal = ({
	opened,
	onClose,
	onConfirm,
	title,
	message,
	confirmLabel,
	cancelLabel,
	confirmColor = "primary",
	loading = false,
	"data-testid": dataTestId,
}: ConfirmModalProps) => (
	<Modal
		opened={opened}
		onClose={onClose}
		title={title}
		data-testid={dataTestId}
	>
		<Stack gap="md">
			<Text size="sm">{message}</Text>
			<Group gap="sm">
				<Button
					variant="filled"
					color={confirmColor}
					onClick={onConfirm}
					loading={loading}
					data-testid={dataTestId ? `${dataTestId}-confirm` : undefined}
				>
					{confirmLabel ?? <Trans>Confirm</Trans>}
				</Button>
				<Button
					variant="subtle"
					color="gray"
					onClick={onClose}
					data-testid={dataTestId ? `${dataTestId}-cancel` : undefined}
				>
					{cancelLabel ?? <Trans>Cancel</Trans>}
				</Button>
			</Group>
		</Stack>
	</Modal>
);
