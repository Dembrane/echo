import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Divider,
	Group,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useState } from "react";
import { useParams } from "react-router";
import { QRCode } from "@/components/common/QRCode";
import { LiveFunnelSection } from "@/components/conversation/LiveFunnelSection";
import { LiveMonitorSection } from "@/components/conversation/LiveMonitorSection";
import { PageContainer } from "@/components/layout/PageContainer";
import { useProjectById } from "@/components/project/hooks";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";

export const ProjectMonitorRoute = () => {
	const { projectId } = useParams<{ projectId: string }>();
	// Hovering a recording dot in the funnel highlights its detailed card below.
	const [hoveredConversationId, setHoveredConversationId] = useState<
		string | null
	>(null);

	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "language"] },
	});
	const sharingLink = useProjectSharingLink(
		projectQuery.data as Project | undefined,
		"qr_scan",
	);

	return (
		<PageContainer width="xl">
			<Stack gap="xl">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={4}>
						<Title order={2} fw={500}>
							<Trans>Monitor</Trans>
						</Title>
						<Text size="sm" c="dimmed" maw={560}>
							<Trans>
								Watch live recordings, transcription progress, and errors across
								this project as they happen.
							</Trans>
						</Text>
					</Stack>
					{sharingLink && (
						<Tooltip label={t`Scan to join this project`} withArrow>
							<Box className="w-[92px] shrink-0">
								<QRCode value={sharingLink} />
							</Box>
						</Tooltip>
					)}
				</Group>

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
