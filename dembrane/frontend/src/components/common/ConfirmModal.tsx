import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	getDefaultZIndex,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import type { ReactNode } from "react";

type ConfirmModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
	/** The second button, when it answers differently from closing (Decline). */
	onCancel?: () => void;
	title: string;
	message: ReactNode;
	/** A block under the message, such as the note someone wrote. It brings its own text. */
	detail?: ReactNode;
	confirmLabel?: ReactNode;
	cancelLabel?: ReactNode;
	confirmColor?: string;
	loading?: boolean;
	/**
	 * For a dialog that opens by itself: focus starts on its text, not on a control, so no
	 * ring shows and Enter answers nothing by accident.
	 */
	focusBody?: boolean;
	"data-testid"?: string;
};

export const ConfirmModal = ({
	opened,
	onClose,
	onConfirm,
	onCancel,
	title,
	message,
	detail,
	confirmLabel,
	cancelLabel,
	confirmColor = "primary",
	loading = false,
	focusBody = false,
	"data-testid": dataTestId,
}: ConfirmModalProps) => (
	<Modal
		opened={opened}
		onClose={onClose}
		title={title}
		// Above the dialog that asked for it, whichever mounted first.
		zIndex={getDefaultZIndex("modal") + 1}
		data-testid={dataTestId}
	>
		<Stack
			gap="md"
			{...(focusBody && {
				className: "outline-none",
				"data-autofocus": true,
				tabIndex: -1,
			})}
		>
			<Text size="sm">{message}</Text>
			{detail}
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
					onClick={onCancel ?? onClose}
					data-testid={dataTestId ? `${dataTestId}-cancel` : undefined}
				>
					{cancelLabel ?? <Trans>Cancel</Trans>}
				</Button>
			</Group>
		</Stack>
	</Modal>
);
