import { Trans } from "@lingui/react/macro";
import { Badge, Button, Group, Modal, Stack, Text } from "@mantine/core";

type AddTagFilterModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
	onExitTransitionEnd?: () => void;
	tagName: string;
};

export const AddTagFilterModal = ({
	opened,
	onClose,
	onConfirm,
	onExitTransitionEnd,
	tagName,
}: AddTagFilterModalProps) => {
	const handleConfirm = () => {
		onConfirm();
		onClose();
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			onExitTransitionEnd={onExitTransitionEnd}
			title={
				<Text size="lg">
					<Trans id="add.tag.filter.modal.title">Add tag to filters</Trans>
				</Text>
			}
			size="md"
			centered
		>
			<Stack gap="lg">
				<Stack gap="xl" py="lg">
					<Text size="sm">
						<Trans id="add.tag.filter.modal.description">
							Would you like to add this tag to your current filters?
						</Trans>
					</Text>

					<Group gap="xs" align="center">
						<Badge size="md" color="gray">
							{tagName}
						</Badge>
					</Group>

					<Text size="sm" c="dimmed">
						<Trans id="add.tag.filter.modal.info">
							This will filter the conversation list to show conversations with
							this tag.
						</Trans>
					</Text>
				</Stack>

				<Group justify="flex-start" gap="sm">
					<Button variant="filled" onClick={handleConfirm}>
						<Trans id="add.tag.filter.modal.add">Add to filters</Trans>
					</Button>
					<Button variant="subtle" color="gray" onClick={onClose}>
						<Trans id="add.tag.filter.modal.cancel">Cancel</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
