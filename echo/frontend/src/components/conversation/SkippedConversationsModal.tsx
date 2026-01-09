import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Tabs,
	Text,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconCheck,
	IconFileOff,
	IconScale,
	IconX,
} from "@tabler/icons-react";

type SkippedConversationsModalProps = {
	opened: boolean;
	onClose: () => void;
	addedConversations: SelectAllConversationResult[];
	skippedConversations: SelectAllConversationResult[];
	contextLimitReached: boolean;
};

const getReasonLabel = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return t`Already in context`;
		case "context_limit_reached":
			return t`Context limit reached`;
		case "empty":
			return t`No content`;
		case "too_long":
			return t`Too long`;
		case "error":
			return t`Error occurred`;
		default:
			return t`Unknown reason`;
	}
};

const getReasonIcon = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return <IconCheck size={14} />;
		case "context_limit_reached":
			return <IconScale size={14} />;
		case "empty":
			return <IconFileOff size={14} />;
		case "too_long":
			return <IconAlertTriangle size={14} />;
		case "error":
			return <IconX size={14} />;
		default:
			return <IconAlertTriangle size={14} />;
	}
};

const getReasonColor = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return "blue";
		case "context_limit_reached":
			return "orange";
		case "empty":
			return "gray";
		case "too_long":
			return "red";
		case "error":
			return "red";
		default:
			return "gray";
	}
};

export const SkippedConversationsModal = ({
	opened,
	onClose,
	addedConversations,
	skippedConversations,
	contextLimitReached,
}: SkippedConversationsModalProps) => {
	// Filter out "already_in_context" from the displayed skipped list since those aren't really failures
	const reallySkipped = skippedConversations.filter(
		(c) => c.reason !== "already_in_context",
	);

	const skippedDueToLimit = reallySkipped.filter(
		(c) => c.reason === "context_limit_reached",
	);
	const skippedDueToOther = reallySkipped.filter(
		(c) => c.reason !== "context_limit_reached",
	);

	// Determine default tab - first non-empty tab
	const getDefaultTab = () => {
		if (addedConversations.length > 0) return "added";
		if (skippedDueToLimit.length > 0) return "limit";
		if (skippedDueToOther.length > 0) return "other";
		return "added";
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Text fw={500} size="lg">
					<Trans>Select All Conversation Results</Trans>
				</Text>
			}
			size="lg"
		>
			<Stack gap="md">
				{/* Summary badges */}
				<Group gap="md">
					<Badge color="primary" size="lg" variant="light">
						<Trans>{addedConversations.length} added</Trans>
					</Badge>
					{reallySkipped.length > 0 && (
						<Badge color="orange" size="lg" variant="light">
							<Trans>{reallySkipped.length} not added</Trans>
						</Badge>
					)}
				</Group>

				{contextLimitReached && (
					<Box className="rounded-md border border-orange-200 bg-orange-50 p-3">
						<Group gap="xs">
							<IconScale size={18} className="text-orange-600" />
							<Text size="sm" fw={500} c="orange.7">
								<Trans>
									Context limit was reached. Some conversations could not be
									added.
								</Trans>
							</Text>
						</Group>
					</Box>
				)}

				{/* Tabs for conversation lists */}
				<Tabs defaultValue={getDefaultTab()} variant="default">
					<Tabs.List grow>
						{addedConversations.length > 0 && (
							<Tabs.Tab
								value="added"
								leftSection={<IconCheck size={16} />}
								rightSection={
									<Badge
										size="md"
										miw={30}
										variant="light"
										color="primary"
										circle
									>
										{addedConversations.length}
									</Badge>
								}
							>
								<Trans>Added</Trans>
							</Tabs.Tab>
						)}
						{skippedDueToLimit.length > 0 && (
							<Tabs.Tab
								value="limit"
								leftSection={<IconScale size={16} />}
								rightSection={
									<Badge
										size="md"
										miw={30}
										variant="light"
										color="orange"
										circle
									>
										{skippedDueToLimit.length}
									</Badge>
								}
							>
								<Trans>Context limit</Trans>
							</Tabs.Tab>
						)}
						{skippedDueToOther.length > 0 && (
							<Tabs.Tab
								value="other"
								leftSection={<IconAlertTriangle size={16} />}
								rightSection={
									<Badge size="md" miw={30} variant="light" color="gray" circle>
										{skippedDueToOther.length}
									</Badge>
								}
							>
								<Trans>Other reasons</Trans>
							</Tabs.Tab>
						)}
					</Tabs.List>

					{/* Added conversations tab */}
					{addedConversations.length > 0 && (
						<Tabs.Panel value="added" pt="md">
							<ScrollArea.Autosize h={400}>
								<Stack gap="xs">
									{addedConversations.map((conv) => (
										<Group
											key={conv.conversation_id}
											gap="md"
											wrap="nowrap"
											className="rounded-md border border-primary-100 bg-primary-50 px-3 py-2"
										>
											<IconCheck
												size={16}
												className="flex-shrink-0 text-primary-600"
											/>
											<Text size="sm" lineClamp={1}>
												{conv.participant_name}
											</Text>
										</Group>
									))}
								</Stack>
							</ScrollArea.Autosize>
						</Tabs.Panel>
					)}

					{/* Skipped due to context limit tab */}
					{skippedDueToLimit.length > 0 && (
						<Tabs.Panel value="limit" pt="md">
							<Stack gap="sm">
								<Text size="xs" c="dimmed">
									<Trans>
										These conversations were skipped because the context limit
										was reached.
									</Trans>
								</Text>
								<ScrollArea.Autosize h={400}>
									<Stack gap="xs">
										{skippedDueToLimit.map((conv) => (
											<Group
												key={conv.conversation_id}
												gap="sm"
												wrap="nowrap"
												justify="space-between"
												className="rounded-md border border-orange-100 bg-orange-50 px-3 py-2"
											>
												<Text size="sm" lineClamp={1}>
													{conv.participant_name}
												</Text>
												<Badge
													color={getReasonColor(conv.reason)}
													size="sm"
													variant="light"
													leftSection={getReasonIcon(conv.reason)}
													className="flex-shrink-0"
												>
													{getReasonLabel(conv.reason)}
												</Badge>
											</Group>
										))}
									</Stack>
								</ScrollArea.Autosize>
							</Stack>
						</Tabs.Panel>
					)}

					{/* Skipped due to other reasons tab */}
					{skippedDueToOther.length > 0 && (
						<Tabs.Panel value="other" pt="md">
							<Stack gap="sm">
								<Text size="xs" c="dimmed">
									<Trans>
										These conversations were excluded due to missing
										transcripts.
									</Trans>
								</Text>
								<ScrollArea.Autosize h={400}>
									<Stack gap="xs">
										{skippedDueToOther.map((conv) => (
											<Group
												key={conv.conversation_id}
												gap="md"
												wrap="nowrap"
												justify="space-between"
												className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2"
											>
												<Text size="sm" lineClamp={1}>
													{conv.participant_name}
												</Text>
												<Badge
													color={getReasonColor(conv.reason)}
													size="sm"
													variant="light"
													leftSection={getReasonIcon(conv.reason)}
													className="flex-shrink-0"
												>
													{getReasonLabel(conv.reason)}
												</Badge>
											</Group>
										))}
									</Stack>
								</ScrollArea.Autosize>
							</Stack>
						</Tabs.Panel>
					)}
				</Tabs>

				<Divider />

				<Group justify="flex-end">
					<Button variant="light" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
