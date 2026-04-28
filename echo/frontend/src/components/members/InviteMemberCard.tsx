import { Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconUserPlus } from "@tabler/icons-react";
import type { MouseEventHandler, ReactNode } from "react";

interface Props {
	label: ReactNode;
	helperText?: ReactNode;
	onClick: MouseEventHandler<HTMLButtonElement>;
	disabled?: boolean;
	icon?: ReactNode;
}

/**
 * Dotted-border card that lives as the first row in a Members list.
 * Clicking opens the scope-specific invite flow (TeamInviteWizard,
 * WorkspaceInviteWizard, ProjectSharingModal). Sits in the list so the
 * invite affordance has the same visual weight as a member row —
 * replaces the old "Invite member" button floating in the header.
 */
export function InviteMemberCard({
	label,
	helperText,
	onClick,
	disabled,
	icon,
}: Props) {
	return (
		<UnstyledButton
			onClick={onClick}
			disabled={disabled}
			w="100%"
			style={{
				borderRadius: "var(--mantine-radius-md)",
				opacity: disabled ? 0.5 : 1,
				cursor: disabled ? "not-allowed" : "pointer",
			}}
		>
			<Paper
				radius="md"
				p="md"
				style={{
					borderStyle: "dashed",
					borderWidth: 1,
					borderColor: "var(--mantine-color-gray-4)",
					background: "transparent",
				}}
			>
				<Group gap="sm" wrap="nowrap">
					<Group
						justify="center"
						align="center"
						style={{
							width: 40,
							height: 40,
							borderRadius: "50%",
							borderStyle: "dashed",
							borderWidth: 1,
							borderColor: "var(--mantine-color-gray-4)",
							color: "var(--mantine-color-gray-6)",
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
}
