import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { useState } from "react";
import type { SupportVisit } from "./supportVisit";

/**
 * Staff ask a workspace's admins for access, with an optional note the admins read in their
 * inbox, their email and the consent dialog.
 */
export function SupportRequestNoteModal({
	opened,
	onClose,
	visit,
}: {
	opened: boolean;
	onClose: () => void;
	visit: SupportVisit;
}) {
	const [note, setNote] = useState("");
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Request support access`}
			data-testid="support-access-request-modal"
		>
			<Stack gap="sm">
				<Text size="sm">
					<Trans>
						Tell the workspace admins what you need access for. This note is
						optional.
					</Trans>
				</Text>
				<Textarea
					value={note}
					onChange={(e) => setNote(e.currentTarget.value)}
					placeholder={t`e.g. investigating the report issue you emailed about`}
					autosize
					minRows={3}
					data-testid="support-access-request-note"
				/>
				<Group justify="flex-start" gap="sm">
					<Button
						variant="filled"
						loading={visit.sendRequest.isPending}
						onClick={() =>
							visit.sendRequest.mutate(note, {
								onSuccess: () => {
									onClose();
									setNote("");
								},
							})
						}
					>
						<Trans>Send request</Trans>
					</Button>
					<Button variant="subtle" color="gray" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
