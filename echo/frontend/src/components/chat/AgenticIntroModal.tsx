import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Button, Group, List, Modal, Stack, Text } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { MODE_COLORS } from "@/components/chat/ChatModeSelector";
import { testId } from "@/lib/testUtils";

export const AgenticIntroModal = ({
	onClose,
	onConfirm,
	opened,
}: {
	onClose: () => void;
	onConfirm: () => void;
	opened: boolean;
}) => (
	<Modal
		opened={opened}
		onClose={onClose}
		title={
			<Group gap="xs" align="center">
				<Text size="lg">
					<Trans>Agentic chat</Trans>
				</Text>
				<Badge size="sm" color="mauve" c="graphite">
					<Trans>Beta</Trans>
				</Badge>
			</Group>
		}
		size="md"
		padding="lg"
		{...testId("agentic-intro-modal")}
	>
		<Stack gap="md">
			<List
				spacing="md"
				size="sm"
				icon={<IconSparkles size={14} color={MODE_COLORS.agentic.primary} />}
				styles={{ itemWrapper: { alignItems: "baseline" } }}
			>
				<List.Item>
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							<Trans>Multi-step analysis.</Trans>
						</Text>
						<Text size="xs">
							<Trans>
								Plans, gathers, and checks its work across many conversations.
							</Trans>
						</Text>
					</Stack>
				</List.Item>
				<List.Item>
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							<Trans>Help setting up your project.</Trans>
						</Text>
						<Text size="xs">
							<Trans>Walks you through setup and suggests next steps.</Trans>
						</Text>
					</Stack>
				</List.Item>
				<List.Item>
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							<Trans>Ask about the app.</Trans>
						</Text>
						<Text size="xs">
							<Trans>
								Questions about how dembrane works, not only about your data.
							</Trans>
						</Text>
					</Stack>
				</List.Item>
			</List>
			<Group justify="flex-end" gap="sm">
				<Button variant="subtle" onClick={onClose}>
					<Trans>Not now</Trans>
				</Button>
				<Button
					onClick={onConfirm}
					aria-label={t`Switch to Agentic`}
					{...testId("agentic-intro-modal-confirm")}
				>
					<Trans>Switch to Agentic</Trans>
				</Button>
			</Group>
		</Stack>
	</Modal>
);
