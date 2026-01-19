import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Modal,
	Pill,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import { IconTag } from "@tabler/icons-react";

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
				<Text fw={600} size="lg">
					<Trans id="add.tag.filter.modal.title">Add Tag to Filters</Trans>
				</Text>
			}
			size="md"
			centered
			classNames={{
				header: "border-b",
			}}
		>
			<Stack gap="lg">
				<Stack gap="xl" py="lg">
					<Text size="sm">
						<Trans id="add.tag.filter.modal.description">
							Would you like to add this tag to your current filters?
						</Trans>
					</Text>

					<Group gap="xs" align="center">
						<ThemeIcon variant="subtle" color="primary" size={18}>
							<IconTag size={18} />
						</ThemeIcon>
						<Pill
							size="md"
							classNames={{
								root: "!bg-[var(--mantine-primary-color-light)] !font-medium",
							}}
						>
							{tagName}
						</Pill>
					</Group>

					<Text size="sm" c="dimmed">
						<Trans id="add.tag.filter.modal.info">
							This will filter the conversation list to show conversations with
							this tag.
						</Trans>
					</Text>
				</Stack>

				<Group justify="flex-end" gap="sm">
					<Button variant="subtle" onClick={onClose}>
						<Trans id="add.tag.filter.modal.cancel">Cancel</Trans>
					</Button>
					<Button onClick={handleConfirm}>
						<Trans id="add.tag.filter.modal.add">Add to Filters</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
