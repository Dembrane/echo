import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	Stack,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";

interface InviteEmailListProps {
	/** Controlled list of email strings. Always has at least one entry. */
	emails: string[];
	onChange: (emails: string[]) => void;
	/** Autofocus the first row (used when the list is the primary field on a step). */
	autoFocusFirst?: boolean;
}

/**
 * Editable list of invite emails: one input per row, add/remove controls.
 * Shared by the onboarding invite step and the create-organisation modal so
 * the two stay in lockstep.
 */
export const InviteEmailList = ({
	emails,
	onChange,
	autoFocusFirst = false,
}: InviteEmailListProps) => {
	const updateEmail = (index: number, value: string) => {
		const next = [...emails];
		next[index] = value;
		onChange(next);
	};
	const addEmailField = () => onChange([...emails, ""]);
	const removeEmailField = (index: number) =>
		onChange(emails.filter((_, i) => i !== index));

	return (
		<Stack gap={10}>
			{emails.map((email, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: row identity tracks position; emails are user-editable so value-based keys cause remount-on-keystroke (focus loss)
				<Group key={`invite-${index}`} gap={8} wrap="nowrap">
					<TextInput
						flex={1}
						placeholder={t`name@example.com`}
						size="sm"
						value={email}
						autoFocus={autoFocusFirst && index === 0}
						onChange={(e) => updateEmail(index, e.currentTarget.value)}
					/>
					{emails.length > 1 && (
						<ActionIcon
							color="gray"
							size="sm"
							variant="subtle"
							aria-label={t`Remove`}
							onClick={() => removeEmailField(index)}
						>
							<IconX size={14} />
						</ActionIcon>
					)}
				</Group>
			))}
			<Box>
				<Button
					leftSection={<IconPlus size={14} />}
					size="sm"
					variant="subtle"
					onClick={addEmailField}
				>
					<Trans>Add another</Trans>
				</Button>
			</Box>
		</Stack>
	);
};
