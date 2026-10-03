import {
	Box,
	Group,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { UserPlusIcon } from "@phosphor-icons/react";
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

// Full-box pressable card rendered as the first row in a Members list; opens the unified InviteModal or ProjectSharingModal.
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
			p="md"
			className="app-do"
			style={disabled ? { cursor: "not-allowed", opacity: 0.5 } : undefined}
		>
			<Group gap="sm" wrap="nowrap">
				{icon ?? <UserPlusIcon size={20} />}
				<Stack gap={0}>
					<Text size="sm">{label}</Text>
					{helperText && (
						<Text size="xs" c="dimmed">
							{helperText}
						</Text>
					)}
				</Stack>
			</Group>
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
