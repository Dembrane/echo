import { Trans } from "@lingui/react/macro";
import { Stack, Text, Title } from "@mantine/core";
import { useWorkspaceMemories } from "./hooks";
import { MemoryList } from "./MemoryList";

export const WorkspaceMemorySection = ({
	workspaceId,
}: {
	workspaceId: string;
}) => {
	const memoriesQuery = useWorkspaceMemories(workspaceId);

	return (
		<Stack gap={8}>
			<Title order={5} fw={400}>
				<Trans>Assistant memory</Trans>
			</Title>
			<Text size="sm">
				<Trans>
					Notes the assistant saved about this workspace from chats. Everyone in
					the workspace shares them.
				</Trans>
			</Text>
			<MemoryList
				memories={memoriesQuery.data}
				isLoading={memoriesQuery.isLoading}
				isError={memoriesQuery.isError}
			/>
		</Stack>
	);
};
