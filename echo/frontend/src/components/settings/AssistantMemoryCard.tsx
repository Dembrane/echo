import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useUserMemories } from "@/components/memory/hooks";
import { MemoryList } from "@/components/memory/MemoryList";

export const AssistantMemoryCard = () => {
	const memoriesQuery = useUserMemories();

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconSparkles size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Memory</Trans>
					</Title>
				</Group>

				<Text size="sm">
					<Trans>
						Notes the assistant keeps about how you like to work, saved during
						your chats. Only you see these. Remove anything you don't want it to
						keep.
					</Trans>
				</Text>

				<MemoryList
					memories={memoriesQuery.data}
					isLoading={memoriesQuery.isLoading}
					emptyText={t`Nothing saved yet. The assistant adds notes here as you chat.`}
				/>
			</Stack>
		</Card>
	);
};
