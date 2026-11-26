import { Group, Paper, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { PersonAvatar } from "./UserAvatar";

/**
 * Something a person wrote, shown as a message from them: their picture, then their words
 * in a bubble (the chat's Paper). The picture falls back to their initials. The label names
 * the writer for a screen reader, since the picture alone says nothing there.
 */
export const PersonNote = ({
	person,
	label,
	children,
	"data-testid": dataTestId,
}: {
	person: { avatar?: string | null; name?: string | null };
	label: string;
	children: ReactNode;
	"data-testid"?: string;
}) => (
	<Group
		gap="sm"
		align="flex-start"
		wrap="nowrap"
		role="group"
		aria-label={label}
		data-testid={dataTestId}
	>
		<PersonAvatar person={person} size={32} />
		<Paper px="sm" py="xs" className="min-w-0">
			<Text size="sm" className="whitespace-pre-wrap break-words">
				{children}
			</Text>
		</Paper>
	</Group>
);
