import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ProjectSettingsSection } from "@/components/project/ProjectSettingsSection";
import { useProjectMemories } from "./hooks";
import { MemoryList } from "./MemoryList";

export const ProjectMemorySection = ({ projectId }: { projectId: string }) => {
	const memoriesQuery = useProjectMemories(projectId);

	return (
		<ProjectSettingsSection
			title={<Trans>Assistant memory</Trans>}
			description={
				<Trans>
					Notes the assistant saved about this project from chats. Everyone who
					chats in this project shares them.
				</Trans>
			}
		>
			<MemoryList
				memories={memoriesQuery.data}
				isLoading={memoriesQuery.isLoading}
				emptyText={t`Nothing saved yet. The assistant adds notes here as people chat.`}
			/>
		</ProjectSettingsSection>
	);
};
