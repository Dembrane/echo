import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { ReactNode } from "react";

type OpenConfirmOptions = {
	title: ReactNode;
	children?: ReactNode;
	labels?: { confirm?: ReactNode; cancel?: ReactNode };
	/** A destructive confirm: the red pill. */
	danger?: boolean;
	onConfirm?: () => void;
	onCancel?: () => void;
};

// modals.openConfirmModal with the system's order: the confirm pill first,
// the quiet cancel after it. Mantine's own confirm modal puts cancel first.
export const openConfirm = ({
	title,
	children,
	labels,
	danger = false,
	onConfirm,
	onCancel,
}: OpenConfirmOptions) => {
	// modals.close also fires onClose, so the cancel runs only when the
	// dialog closes without a confirm (cancel button, escape, overlay).
	let confirmed = false;
	const id = modals.open({
		children: (
			<Stack gap="md">
				{typeof children === "string" ? (
					<Text size="sm">{children}</Text>
				) : (
					children
				)}
				<Group gap="sm">
					<Button
						variant="filled"
						color={danger ? "red" : "primary"}
						onClick={() => {
							confirmed = true;
							modals.close(id);
							onConfirm?.();
						}}
					>
						{labels?.confirm ?? <Trans>Confirm</Trans>}
					</Button>
					<Button
						variant="subtle"
						color="gray"
						onClick={() => modals.close(id)}
					>
						{labels?.cancel ?? <Trans>Cancel</Trans>}
					</Button>
				</Group>
			</Stack>
		),
		onClose: () => {
			if (!confirmed) onCancel?.();
		},
		title,
	});
	return id;
};
