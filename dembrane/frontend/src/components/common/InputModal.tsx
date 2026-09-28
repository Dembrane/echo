import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";

type InputModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: (value: string) => void;
	title: string;
	label?: ReactNode;
	placeholder?: string;
	initialValue?: string;
	confirmLabel?: ReactNode;
	cancelLabel?: ReactNode;
	loading?: boolean;
	"data-testid"?: string;
};

export const InputModal = ({
	opened,
	onClose,
	onConfirm,
	title,
	label,
	placeholder,
	initialValue = "",
	confirmLabel,
	cancelLabel,
	loading = false,
	"data-testid": dataTestId,
}: InputModalProps) => {
	const [value, setValue] = useState(initialValue);

	useEffect(() => {
		if (opened) {
			setValue(initialValue);
		}
	}, [opened, initialValue]);

	const handleSubmit = () => {
		const trimmed = value.trim();
		if (trimmed) {
			onConfirm(trimmed);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={title}
			size="sm"
			data-testid={dataTestId}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
			>
				<Stack gap="md">
					<TextInput
						label={label}
						placeholder={placeholder}
						value={value}
						onChange={(e) => setValue(e.currentTarget.value)}
						autoFocus
						data-testid={dataTestId ? `${dataTestId}-input` : undefined}
					/>
					<Group justify="flex-end" gap="sm">
						<Button
							variant="subtle"
							onClick={onClose}
							type="button"
							data-testid={dataTestId ? `${dataTestId}-cancel` : undefined}
						>
							{cancelLabel ?? <Trans>Cancel</Trans>}
						</Button>
						<Button
							type="submit"
							loading={loading}
							disabled={!value.trim()}
							data-testid={dataTestId ? `${dataTestId}-confirm` : undefined}
						>
							{confirmLabel ?? <Trans>Save</Trans>}
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
};
