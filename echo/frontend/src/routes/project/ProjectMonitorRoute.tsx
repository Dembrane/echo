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
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { QRCode } from "@/components/common/QRCode";
import { LiveFunnelSection } from "@/components/conversation/LiveFunnelSection";
import { LiveMonitorSection } from "@/components/conversation/LiveMonitorSection";
import { PageContainer } from "@/components/layout/PageContainer";
import { useProjectById } from "@/components/project/hooks";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import { useConversationMonitor } from "@/hooks/useConversationMonitor";

// Renders nothing: keeps the analytics subscription off the page component so
// snapshots don't re-render the page chrome (QR, headings). The live sections re-render on their own.
const MonitorSessionAnalytics = ({ projectId }: { projectId: string }) => {
	const { summary } = useConversationMonitor(projectId);
	const peakLiveRef = useRef(0);

	useEffect(() => {
		if (summary.live > peakLiveRef.current) peakLiveRef.current = summary.live;
	}, [summary.live]);

	// Events double-fire under React.StrictMode in dev only; production fires once.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once per project session, summary is read at open time only
	useEffect(() => {
		// Reset per project session so a param change (no remount) starts fresh.
		peakLiveRef.current = summary.live;
		const openedAt = Date.now();
		// live_count_at_open may be 0 before the first snapshot; peak on close is the reliable measure.
		posthog.capture("monitor_opened", {
			has_live_activity: summary.live > 0,
			live_count_at_open: summary.live,
			project_id: projectId,
		});
		return () => {
			posthog.capture("monitor_closed", {
				duration_seconds: Math.round((Date.now() - openedAt) / 1000),
				peak_live_count: peakLiveRef.current,
				project_id: projectId,
			});
		};
	}, [projectId]);

	return null;
};

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
				{projectId && <MonitorSessionAnalytics projectId={projectId} />}
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={4}>
						<Title order={2} fw={500}>
							<Trans>Monitor</Trans>
						</Title>
						<Text size="sm" maw={560}>
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
