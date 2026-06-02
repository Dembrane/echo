import {
	Box,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { IconUserPlus } from "@tabler/icons-react";
import type { MouseEventHandler, ReactNode } from "react";

interface Props {
	label: ReactNode;
	helperText?: ReactNode;
	onClick: MouseEventHandler<HTMLButtonElement>;
	disabled?: boolean;
	icon?: ReactNode;
	// Tooltip shown on hover. Useful when the card is disabled — the
	// disabled state dims helperText to near-unreadable, so the tooltip
	// surfaces the same explanation in a high-contrast layer.
	tooltip?: ReactNode;
}

// Dotted-border card rendered as the first row in a Members list; opens the unified InviteModal or ProjectSharingModal.
export function InviteMemberCard({
	label,
	helperText,
	onClick,
	disabled,
	icon,
	tooltip,
}: Props) {
	const card = (
		<UnstyledButton
			onClick={onClick}
			disabled={disabled}
			w="100%"
			style={{
				borderRadius: "var(--mantine-radius-md)",
				cursor: disabled ? "not-allowed" : "pointer",
				opacity: disabled ? 0.5 : 1,
			}}
		>
			<Paper
				radius="md"
				p="md"
				style={{
					background: "transparent",
					borderColor: "var(--mantine-color-gray-4)",
					borderStyle: "dashed",
					borderWidth: 1,
				}}
			>
				<Group gap="sm" wrap="nowrap">
					<Group
						justify="center"
						align="center"
						style={{
							borderColor: "var(--mantine-color-gray-4)",
							borderRadius: "50%",
							borderStyle: "dashed",
							borderWidth: 1,
							color: "var(--mantine-color-gray-6)",
							height: 40,
							width: 40,
						}}
					>
						{icon ?? <IconUserPlus size={18} />}
					</Group>
					<Stack gap={0}>
						<Text size="sm" fw={500}>
							{label}
						</Text>
						{helperText && (
							<Text size="xs" c="dimmed">
								{helperText}
							</Text>
						)}
					</Stack>
				</Group>
			</Paper>
		</UnstyledButton>
	);

	if (!tooltip) return card;
	return (
		<Tooltip
			label={tooltip}
			withArrow
			multiline
			w={280}
			// Disabled UnstyledButton blocks pointer events on some browsers, suppressing the tooltip; Box wrapper + events flag keep it firing.
			events={{ focus: true, hover: true, touch: true }}
		>
			<Box>{card}</Box>
		</Tooltip>
	);
}
