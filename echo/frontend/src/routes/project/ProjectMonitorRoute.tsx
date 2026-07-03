import { Trans } from "@lingui/react/macro";
import { Divider, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useParams } from "react-router";
import { LiveFunnelSection } from "@/components/conversation/LiveFunnelSection";
import { LiveMonitorSection } from "@/components/conversation/LiveMonitorSection";
import { PageContainer } from "@/components/layout/PageContainer";

export const ProjectMonitorRoute = () => {
	const { projectId } = useParams<{ projectId: string }>();
	// Hovering a recording dot in the funnel highlights its detailed card below.
	const [hoveredConversationId, setHoveredConversationId] = useState<
		string | null
	>(null);

	return (
		<PageContainer width="xl">
			<Stack gap="xl">
				<Stack gap={4}>
					<Title order={2} fw={500} style={{ color: "#2d2d2c" }}>
						<Trans>Monitor</Trans>
					</Title>
					<Text size="sm" c="dimmed" maw={560}>
						<Trans>
							Watch live recordings, transcription progress, and errors across
							this project as they happen.
						</Trans>
					</Text>
				</Stack>

				{projectId && (
					<LiveFunnelSection
						projectId={projectId}
						onHoverConversation={setHoveredConversationId}
					/>
				)}

				<Divider />

				{projectId && (
					<LiveMonitorSection
						projectId={projectId}
						standalone
						highlightedConversationId={hoveredConversationId}
					/>
				)}
			</Stack>
		</PageContainer>
	);
};
